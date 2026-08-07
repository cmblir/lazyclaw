// scripts/hermes-import.mjs
// Detect ~/.hermes (or --from <dir>) and import into pompos.
//   skills/*.md       → <cfgDir>/skills/*.md with trained_by: hermes-import (C4)
//   USER.md           → <cfgDir>/memory/USER.md          (C6)
//   MEMORY.md         → <cfgDir>/memory/core.md          (merged, append)
//   channels.json     → cfg.channels.* (best-effort)
//   skins/<slug>.yaml → <cfgDir>/personalities/hermes-<slug>.md (C7)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultConfigDir as resolveConfigDir } from '../lib/config_dir.mjs';

export function defaultHermesDir() { return path.join(os.homedir(), '.hermes'); }
export function defaultCfgDir() {
  return resolveConfigDir();
}

function injectTrainedBy(content, value) {
  if (!content.startsWith('---')) {
    return `---\ntrained_by: ${value}\n---\n${content}`;
  }
  // Replace existing trained_by or insert before closing fence
  const closeRe = /\r?\n---[ \t]*(?:\r?\n|$)/;
  const m = closeRe.exec(content.slice(3));
  if (!m) return content;
  const block = content.slice(4, 3 + m.index);
  const rest = content.slice(3 + m.index + m[0].length);
  if (/^trained_by:/m.test(block)) {
    return `---\n${block.replace(/^trained_by:.*$/m, `trained_by: ${value}`)}\n---\n${rest}`;
  }
  return `---\n${block}\ntrained_by: ${value}\n---\n${rest}`;
}

function importSkills(srcDir, dstDir) {
  const src = path.join(srcDir, 'skills');
  if (!fs.existsSync(src)) return 0;
  const dst = path.join(dstDir, 'skills');
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(src, f), 'utf8');
    fs.writeFileSync(path.join(dst, f), injectTrainedBy(content, 'hermes-import'));
    n++;
  }
  return n;
}

function importMemory(srcDir, dstDir) {
  const memDir = path.join(dstDir, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const userSrc = path.join(srcDir, 'USER.md');
  if (fs.existsSync(userSrc)) {
    const incoming = fs.readFileSync(userSrc, 'utf8');
    const dst = path.join(memDir, 'USER.md');
    const existing = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
    fs.writeFileSync(dst, existing ? `${existing}\n\n<!-- hermes-import -->\n${incoming}` : incoming);
  }
  const memSrc = path.join(srcDir, 'MEMORY.md');
  if (fs.existsSync(memSrc)) {
    const incoming = fs.readFileSync(memSrc, 'utf8');
    const dst = path.join(memDir, 'core.md');
    const existing = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
    fs.writeFileSync(dst, existing ? `${existing}\n\n<!-- hermes-import -->\n${incoming}` : incoming);
  }
}

function importChannels(srcDir, cfgDir) {
  const src = path.join(srcDir, 'channels.json');
  if (!fs.existsSync(src)) return;
  let incoming;
  try { incoming = JSON.parse(fs.readFileSync(src, 'utf8')); } catch { return; }
  const cfgPath = path.join(cfgDir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.channels = { ...(cfg.channels || {}), ...incoming };
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

function importSkins(srcDir, dstDir) {
  const src = path.join(srcDir, 'skins');
  if (!fs.existsSync(src)) return 0;
  const dst = path.join(dstDir, 'personalities');
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const slug = f.replace(/\.ya?ml$/, '');
    const raw = fs.readFileSync(path.join(src, f), 'utf8');
    // Best-effort: extract `prompt:` flat YAML; else dump raw.
    const m = /^prompt:\s*"?(.*?)"?\s*$/m.exec(raw);
    const body = m ? m[1] : raw;
    fs.writeFileSync(path.join(dst, `hermes-${slug}.md`), `# ${slug} (imported from Hermes)\n\n${body}\n`);
    n++;
  }
  return n;
}

export function importHermes({ from, cfgDir } = {}) {
  const src = from || defaultHermesDir();
  const dst = cfgDir || defaultCfgDir();
  if (!fs.existsSync(src)) throw new Error(`hermes source not found: ${src}`);
  fs.mkdirSync(dst, { recursive: true });
  const counts = {
    skills: importSkills(src, dst),
    memory: (importMemory(src, dst), 1),
    channels: (importChannels(src, dst), 1),
    skins: importSkins(src, dst),
  };
  return { src, dst, counts };
}
