// mas/reindex.mjs — rebuild AND repopulate the FTS index from the on-disk
// source of truth. Moved out of index_db.mjs, which sat at 490/500 lines with
// this addition pending; index_db re-exports reindexAll so its three callers
// (cli.mjs doctor path, daemon POST /index/rebuild, scripts/migrate-v5) are
// untouched.
//
// Why the addition: reindexAll repopulated sessions, skills and core/episodic
// memories — but NOT trajectories or the USER model, both of which are indexed
// only at write time (trajectory_store.put, user_modeler). So the documented
// recovery path silently destroyed exactly the recall data a long-running
// install has most of. Observed live: a reindex on this machine dropped
// fts_trajectories from 1451 rows to 0 and lost the USER memory row, while the
// JSONL and USER.md sources sat intact on disk. Everything indexed at write
// time must be walked here, or "rebuild" means "lose".

import fs from 'node:fs';
import path from 'node:path';
import { _miniFrontmatter } from './index_rank.mjs';
import { defaultConfigDir } from '../lib/config_dir.mjs';
import {
  rebuild,
  indexSessionTurn,
  indexSkill,
  indexMemory,
  indexTrajectory,
} from './index_db.mjs';

export function reindexAll(configDir = defaultConfigDir()) {
  rebuild(configDir);
  // Sessions — flat <configDir>/sessions/<id>.jsonl, one turn per line.
  const sessDir = path.join(configDir, 'sessions');
  if (fs.existsSync(sessDir)) {
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -'.jsonl'.length);
      let idx = 0;
      const raw = fs.readFileSync(path.join(sessDir, f), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const o = JSON.parse(line);
          indexSessionTurn({ session_id: id, turn_idx: idx++, role: o.role || 'user', ts: o.ts || 0, content: o.content || '' }, configDir);
        } catch { /* skip malformed line */ }
      }
    }
  }
  // Skills — canonical flat <configDir>/skills/<name>.md (skip the .archive dir).
  const skillsDir = path.join(configDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const f of fs.readdirSync(skillsDir)) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -'.md'.length);
      const { meta, body } = _miniFrontmatter(fs.readFileSync(path.join(skillsDir, f), 'utf8'));
      indexSkill({
        skill_name: name,
        trained_by: meta.trained_by || 'legacy',
        group_name: meta.group || (name.includes('-') ? name.split('-')[0] : 'legacy'),
        content: body,
      }, configDir);
    }
  }
  // Memory — core.md + episodic/*.md + USER.md. USER is written by
  // user_modeler with kind 'user_model'; without this line a reindex demotes
  // recall of everything the tool has learned about its operator.
  const memDir = path.join(configDir, 'memory');
  if (fs.existsSync(memDir)) {
    const core = path.join(memDir, 'core.md');
    if (fs.existsSync(core)) indexMemory({ topic: 'core', kind: 'core', content: fs.readFileSync(core, 'utf8') }, configDir);
    const user = path.join(memDir, 'USER.md');
    if (fs.existsSync(user)) indexMemory({ topic: 'USER', kind: 'user_model', content: fs.readFileSync(user, 'utf8') }, configDir);
    const epi = path.join(memDir, 'episodic');
    if (fs.existsSync(epi)) {
      for (const f of fs.readdirSync(epi)) {
        if (!f.endsWith('.md')) continue;
        indexMemory({ topic: f.slice(0, -'.md'.length), kind: 'episodic', content: fs.readFileSync(path.join(epi, f), 'utf8') }, configDir);
      }
    }
  }
  // Trajectories — <configDir>/trajectories/<YYYY-MM-DD>/<id>.jsonl, one JSON
  // record per file. The FTS content mirrors trajectory_store.put exactly
  // (finalAnswer + every turn's content), so a reindexed row ranks the same as
  // one indexed at write time. put() redacts before writing, so the stored file
  // is already redacted — re-running redaction here would double-process.
  const trajDir = path.join(configDir, 'trajectories');
  if (fs.existsSync(trajDir)) {
    for (const day of fs.readdirSync(trajDir)) {
      const dayDir = path.join(trajDir, day);
      let entries;
      try { entries = fs.readdirSync(dayDir); } catch { continue; /* stray file, not a day dir */ }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const stored = JSON.parse(fs.readFileSync(path.join(dayDir, f), 'utf8').split('\n')[0]);
          const ftsContent = [
            stored.finalAnswer || '',
            ...(stored.turns || []).map((t) => String(t.content || '')),
          ].filter(Boolean).join('\n');
          indexTrajectory({
            trajectory_id: stored.id || f.slice(0, -'.jsonl'.length),
            agent: stored.agentName || '',
            outcome: stored.outcome,
            content: ftsContent,
          }, configDir);
        } catch { /* skip malformed record */ }
      }
    }
  }
}
