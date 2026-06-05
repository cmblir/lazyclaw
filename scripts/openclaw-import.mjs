// scripts/openclaw-import.mjs
// Detect ~/.openclaw (or --from <dir>) and import into lazyclaw,
// matching Hermes `claw migrate` coverage. Tags every skill
// trained_by: openclaw-import (canonical C4).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function defaultOpenclawDir() { return path.join(os.homedir(), '.openclaw'); }
export function defaultCfgDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

function injectTrainedBy(content, value) {
  if (!content.startsWith('---')) return `---\ntrained_by: ${value}\n---\n${content}`;
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

function copyIfPresent(srcFile, dstFile, transform = (s) => s) {
  if (!fs.existsSync(srcFile)) return false;
  fs.mkdirSync(path.dirname(dstFile), { recursive: true });
  fs.writeFileSync(dstFile, transform(fs.readFileSync(srcFile, 'utf8')));
  return true;
}

function mergeJson(srcFile, cfgKey, cfgDir) {
  if (!fs.existsSync(srcFile)) return;
  let incoming; try { incoming = JSON.parse(fs.readFileSync(srcFile, 'utf8')); } catch { return; }
  const cfgPath = path.join(cfgDir, 'config.json');
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg[cfgKey] = { ...(cfg[cfgKey] || {}), ...incoming };
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

export function importOpenclaw({ from, cfgDir } = {}) {
  const src = from || defaultOpenclawDir();
  const dst = cfgDir || defaultCfgDir();
  if (!fs.existsSync(src)) throw new Error(`openclaw source not found: ${src}`);
  fs.mkdirSync(dst, { recursive: true });

  copyIfPresent(path.join(src, 'SOUL.md'),  path.join(dst, 'SOUL.md'));
  copyIfPresent(path.join(src, 'USER.md'),  path.join(dst, 'memory', 'USER.md'));
  copyIfPresent(path.join(src, 'MEMORY.md'), path.join(dst, 'memory', 'core.md'));

  const skillsSrc = path.join(src, 'skills');
  let nSkills = 0;
  if (fs.existsSync(skillsSrc)) {
    const skillsDst = path.join(dst, 'skills');
    fs.mkdirSync(skillsDst, { recursive: true });
    for (const f of fs.readdirSync(skillsSrc)) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(skillsSrc, f), 'utf8');
      fs.writeFileSync(path.join(skillsDst, f), injectTrainedBy(content, 'openclaw-import'));
      nSkills++;
    }
  }

  mergeJson(path.join(src, 'allowlist.json'), 'allowlist', dst);
  mergeJson(path.join(src, 'messaging.json'), 'channels', dst);

  return { src, dst, counts: { skills: nSkills } };
}
