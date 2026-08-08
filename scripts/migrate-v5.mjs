#!/usr/bin/env node
// scripts/migrate-v5.mjs — Phase A baseline migration (spec §10).
//
// Steps (each is idempotent — a second run is a no-op):
//   1. Backup <configDir> to <configDir>/backup-v4-<ts>/ (only when no
//      prior backup exists for the current schema version).
//   2. Rewrite config.json: ensure trainer.provider defaults to "auto"
//      when omitted (canonical C9). Existing trainer blocks are left
//      alone.
//   3. Walk skills/*.md and add missing frontmatter fields per
//      canonical decisions:
//        - group:    filename-hyphen-prefix or 'legacy' (C5)
//        - trained_by: 'legacy' for pre-v5 skills (C4)
//      Existing fields are never overwritten.
//   4. Rebuild index.db from on-disk sessions, skills, memory.
//
// Phases B+ extend this script with user-modeler import, persona
// promotion, and trajectory backfill from the v4 recent.jsonl.

// Standalone entrypoint: cli.mjs's boot never runs here, so mirror the
// POMPOS_*/POMPOS_* prefixes ourselves before anything reads them.
import '../lib/env_compat_boot.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reindexAll } from '../mas/index_db.mjs';
import { parseFrontmatter } from '../skills.mjs';
import { defaultConfigDir as resolveConfigDir } from '../lib/config_dir.mjs';

function defaultConfigDir() {
  return resolveConfigDir();
}

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupOnce(configDir) {
  const entries = fs.readdirSync(configDir, { withFileTypes: true });
  const hasBackup = entries.some(e => e.isDirectory() && e.name.startsWith('backup-v4-'));
  if (hasBackup) return { skipped: true };
  const backupDir = path.join(configDir, `backup-v4-${tsStamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const e of entries) {
    if (e.name === 'index.db' || e.name.startsWith('backup-v4-')) continue;
    const src = path.join(configDir, e.name);
    const dst = path.join(backupDir, e.name);
    fs.cpSync(src, dst, { recursive: true });
  }
  return { backupDir };
}

function rewriteConfig(configDir) {
  const cfgPath = path.join(configDir, 'config.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { cfg = {}; }
  }
  if (!cfg.trainer || !cfg.trainer.provider) {
    cfg.trainer = { provider: 'auto', ...(cfg.trainer || {}) };
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfg;
}

function escapeYaml(s) {
  const str = String(s ?? '');
  if (!/[":\n]/.test(str)) return str;
  return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function upgradeSkillFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  const baseName = path.basename(filePath, '.md');
  const want = {
    group: meta.group || (baseName.includes('-') ? baseName.split('-')[0] : 'legacy'),
    trained_by: meta.trained_by || 'legacy',
  };
  const before = JSON.stringify(meta);
  const next = { ...meta, ...want };
  if (JSON.stringify(next) === before) return false;   // no change
  const lines = ['---'];
  for (const [k, v] of Object.entries(next)) {
    lines.push(`${k}: ${escapeYaml(v)}`);
  }
  lines.push('---', '', body.replace(/^\n+/, ''));
  fs.writeFileSync(filePath, lines.join('\n'));
  return true;
}

function upgradeAllSkills(configDir) {
  const dir = path.join(configDir, 'skills');
  if (!fs.existsSync(dir)) return { upgraded: 0 };
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    if (upgradeSkillFrontmatter(path.join(dir, name))) n++;
  }
  return { upgraded: n };
}

// Rebuild + repopulate the FTS index. The walk now lives in index_db.reindexAll
// (shared with the daemon POST /index/rebuild route) so a "rebuild" is always a
// repopulate, never a silent zeroing.
function rebuildIndex(configDir) {
  reindexAll(configDir);
}

export async function migrateV5(opts = {}) {
  const configDir = opts.configDir || defaultConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  const backup = backupOnce(configDir);
  const config = rewriteConfig(configDir);
  const skills = upgradeAllSkills(configDir);
  rebuildIndex(configDir);
  return {
    ok: true,
    configDir,
    backupDir: backup.backupDir || null,
    backupSkipped: !!backup.skipped,
    trainerProvider: config.trainer?.provider,
    skillsUpgraded: skills.upgraded,
  };
}

// --- Phase G: full v4→v5 migration (spec §1.7, §10) ---------------------
// Phase A's migrateV5() keeps its original behaviour (backup inside
// cfgDir, rebuild index). Phase G adds a parallel migrate()/rollback()
// pair the user-facing CLI calls. Differences from Phase A:
//   * Backup goes to `<cfgDir>.v4.backup/<ISO-ts>/` (peer dir, not under
//     cfgDir) so rollback can wipe + restore cleanly.
//   * Config rewrites add `orchestrator → orchestra` (C3, §3.9) and
//     `sandbox: "docker"` string → `sandbox: {backend: "docker"}` object
//     (C8) on top of the trainer auto default (C9).
//   * Skill frontmatter gains `confidence: 0.5` alongside the C4/C5
//     fields Phase A already injects.
//   * `personalities/`, `memory/`, `workspaces/` directories are
//     created so the Phase-G CLI surfaces work right after migration.

function isoTs() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function removeTree(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) { fs.unlinkSync(p); return; }
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const c = path.join(p, entry.name);
    if (entry.isDirectory()) removeTree(c);
    else fs.unlinkSync(c);
  }
  fs.rmdirSync(p);
}

function backupSnapshot(cfgDir) {
  const root = `${cfgDir}.v4.backup`;
  fs.mkdirSync(root, { recursive: true });
  const dst = path.join(root, isoTs());
  copyTree(cfgDir, dst);
  return dst;
}

function rewriteConfigPhaseG(cfgDir) {
  const p = path.join(cfgDir, 'config.json');
  if (!fs.existsSync(p)) return;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`migrate: config.json is not valid JSON: ${e.message}`); }

  // orchestrator → orchestra (C3 + spec §3.9)
  if (cfg.orchestrator && !cfg.orchestra) {
    cfg.orchestra = cfg.orchestrator;
    delete cfg.orchestrator;
  }

  // sandbox: "docker" → sandbox: { backend: "docker" } (C8)
  if (typeof cfg.sandbox === 'string') {
    cfg.sandbox = { backend: cfg.sandbox };
  }

  // Default trainer (auto) when absent (C9)
  if (!cfg.trainer) {
    cfg.trainer = { provider: 'auto', schedule: 'nightly' };
  }

  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}

function upgradeSkillPhaseG(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Frontmatter detection mirrors skills.mjs::parseFrontmatter
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return;
  const after = raw.slice(4);
  const closeRe = /\r?\n---[ \t]*(?:\r?\n|$)/;
  const m = closeRe.exec(after);
  if (!m) return;
  const block = after.slice(0, m.index);
  const body = after.slice(m.index + m[0].length);
  const keys = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) keys[kv[1]] = kv[2];
  }

  const fname = path.basename(filePath, '.md');
  const hyphenPrefix = fname.includes('-') ? fname.split('-')[0] : null;

  let mutated = false;
  if (!keys.group) {
    keys.group = hyphenPrefix || 'legacy';                  // C5
    mutated = true;
  }
  if (!keys.confidence) { keys.confidence = '0.5'; mutated = true; }
  if (!keys.trained_by) { keys.trained_by = 'legacy'; mutated = true; }   // C4

  if (!mutated) return;
  // Emit in a stable order: keep originals first, append new ones.
  const orderedKeys = [];
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:/.exec(line.trim());
    if (kv && !orderedKeys.includes(kv[1])) orderedKeys.push(kv[1]);
  }
  for (const k of ['group', 'confidence', 'trained_by']) {
    if (!orderedKeys.includes(k)) orderedKeys.push(k);
  }
  const newBlock = orderedKeys.map(k => `${k}: ${keys[k]}`).join('\n');
  fs.writeFileSync(filePath, `---\n${newBlock}\n---\n${body}`);
}

function upgradeAllSkillsPhaseG(cfgDir) {
  const dir = path.join(cfgDir, 'skills');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.md')) upgradeSkillPhaseG(path.join(dir, f));
  }
}

function ensureDirs(cfgDir) {
  fs.mkdirSync(path.join(cfgDir, 'personalities'), { recursive: true });   // C7
  fs.mkdirSync(path.join(cfgDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, 'workspaces'), { recursive: true });
}

export function migrate({ cfgDir } = {}) {
  const dir = cfgDir || defaultConfigDir();
  if (!fs.existsSync(dir)) throw new Error(`config dir not found: ${dir}`);
  const backupDir = backupSnapshot(dir);
  rewriteConfigPhaseG(dir);
  upgradeAllSkillsPhaseG(dir);
  ensureDirs(dir);
  return { backupDir };
}

export function rollback({ cfgDir } = {}) {
  const dir = cfgDir || defaultConfigDir();
  const root = `${dir}.v4.backup`;
  if (!fs.existsSync(root)) throw new Error(`no backup found at ${root}`);
  const stamps = fs.readdirSync(root).sort();
  if (!stamps.length) throw new Error(`no backup snapshots in ${root}`);
  const latest = path.join(root, stamps[stamps.length - 1]);
  // Wipe the current cfgDir contents, restore the latest snapshot.
  for (const entry of fs.readdirSync(dir)) removeTree(path.join(dir, entry));
  copyTree(latest, dir);
  return { restoredFrom: latest };
}

// CLI entry — `npm run migrate:v5` or `node scripts/migrate-v5.mjs`.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateV5().then(r => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }).catch(err => {
    // eslint-disable-next-line no-console
    console.error('[migrate-v5] failed:', err.stack || err.message);
    process.exit(1);
  });
}
