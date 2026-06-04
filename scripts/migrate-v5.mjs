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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openIndex, rebuild, indexSessionTurn, indexSkill, indexMemory } from '../mas/index_db.mjs';
import { parseFrontmatter } from '../skills.mjs';

function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
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

function rebuildIndex(configDir) {
  rebuild(configDir);
  openIndex(configDir);

  // Sessions.
  const sessDir = path.join(configDir, 'sessions');
  if (fs.existsSync(sessDir)) {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -'.jsonl'.length);
      const raw = fs.readFileSync(path.join(sessDir, f), 'utf8');
      let idx = 0;
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          indexSessionTurn({
            session_id: id, turn_idx: idx++, role: obj.role || 'user',
            ts: obj.ts || 0, content: obj.content || '',
          }, configDir);
        } catch { /* skip malformed */ }
      }
    }
  }

  // Skills.
  const skillsDir = path.join(configDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const f of fs.readdirSync(skillsDir)) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -'.md'.length);
      const raw = fs.readFileSync(path.join(skillsDir, f), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      indexSkill({
        skill_name: name,
        trained_by: meta.trained_by || 'legacy',
        group_name: meta.group || (name.includes('-') ? name.split('-')[0] : 'legacy'),
        content: body,
      }, configDir);
    }
  }

  // Memory (core + episodic).
  const memDir = path.join(configDir, 'memory');
  if (fs.existsSync(memDir)) {
    const corePath = path.join(memDir, 'core.md');
    if (fs.existsSync(corePath)) {
      indexMemory({ topic: 'core', kind: 'core',
        content: fs.readFileSync(corePath, 'utf8') }, configDir);
    }
    const epi = path.join(memDir, 'episodic');
    if (fs.existsSync(epi)) {
      for (const f of fs.readdirSync(epi)) {
        if (!f.endsWith('.md')) continue;
        indexMemory({
          topic: f.slice(0, -'.md'.length), kind: 'episodic',
          content: fs.readFileSync(path.join(epi, f), 'utf8'),
        }, configDir);
      }
    }
  }
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
