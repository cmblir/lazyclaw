// mas/prompt_stack.mjs
// 8-layer system-prompt composer (v5.0 spec §9.3, canonical C10).
// Layers (top-to-bottom in the system prompt):
//   1.  Global  SOUL.md          <configDir>/SOUL.md
//   1.5 Workspace SOUL.md        <configDir>/workspaces/<name>/SOUL.md      (C10)
//   2.  Personality              <configDir>/personalities/<name>.md         (C7)
//   3.  agent.role               from agent record
//   4.  USER.md                  <configDir>/memory/USER.md                  (C6)
//   5.  Skill index              skills.skillsIndex(cfgDir)
//   6.  Memory (core.md)         memory.loadCore(cfgDir)
//   7.  Trajectory tail          last recent.jsonl entry (best-effort)
//
// Missing layers are silently skipped. Never throws. Result is a single
// newline-joined string suitable for prepending to the agent system
// prompt. Caller decides whether to further sandwich it with task input.

import fs from 'node:fs';
import path from 'node:path';
import { skillsIndex } from '../skills.mjs';
import { loadCore, recentPath, defaultConfigDir } from '../memory.mjs';
import { recall as _recall } from './index_db.mjs';

function readOpt(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); }
  catch { return ''; }
}

function lastRecentLine(cfgDir) {
  try {
    const p = recentPath(cfgDir);
    if (!fs.existsSync(p)) return '';
    const txt = fs.readFileSync(p, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    if (!lines.length) return '';
    const parsed = JSON.parse(lines[lines.length - 1]);
    return `${parsed.role || 'user'}: ${String(parsed.content || '').slice(0, 240)}`;
  } catch { return ''; }
}

// Top-k recalled context for the CURRENT user message. Off (and byte-stable)
// when no `query` is passed. Scoped to prior sessions / trajectories /
// memories — the skill index already has its own layer above. Best-effort:
// any index/FTS hiccup yields no layer rather than breaking prompt composition.
function recalledLayer(dir, query, k) {
  if (!query || !String(query).trim()) return '';
  try {
    const r = _recall(String(query), { configDir: dir, scope: ['sessions', 'trajectories', 'memories'], k });
    const hits = (r && Array.isArray(r.hits)) ? r.hits : [];
    const lines = hits
      .map((h) => `- [${h.scope}] ${String(h.snippet || '').replace(/\s+/g, ' ').trim()}`)
      .filter((l) => l.length > 6);
    return lines.length ? `## Relevant recalled context\n${lines.join('\n')}` : '';
  } catch {
    return '';
  }
}

export function composePromptStack({ cfgDir, agent, workspace, sessionId, query, recallK = 5 } = {}) {
  const dir = cfgDir || defaultConfigDir();
  const a = agent || {};
  const parts = [];

  // 1. global SOUL
  const globalSoul = readOpt(path.join(dir, 'SOUL.md'));
  if (globalSoul) parts.push(`## SOUL\n${globalSoul}`);

  // 1.5 workspace SOUL (C10)
  if (workspace) {
    const wsSoul = readOpt(path.join(dir, 'workspaces', workspace, 'SOUL.md'));
    if (wsSoul) parts.push(`## Workspace SOUL (${workspace})\n${wsSoul}`);
  }

  // 2. personality (C7)
  if (a.personality) {
    const p = readOpt(path.join(dir, 'personalities', `${a.personality}.md`));
    if (p) parts.push(`## Personality (${a.personality})\n${p}`);
  }

  // 3. agent.role
  if (a.role) parts.push(`## Role (${a.name || 'agent'})\n${a.role}`);

  // 4. USER.md (C6)
  const userMd = readOpt(path.join(dir, 'memory', 'USER.md'));
  if (userMd) parts.push(`## What the user has told you before\n${userMd}`);

  // 5. skill index
  const idx = skillsIndex(dir);
  if (idx) parts.push(`## Available skills\n${idx}`);

  // 6. memory core.md
  const core = loadCore(dir);
  if (core && core.trim()) parts.push(`## Long-term memory\n${core.trim()}`);

  // 7. trajectory tail (sessionId may be ignored — recent.jsonl is global)
  const tail = lastRecentLine(dir);
  if (tail) parts.push(`## Most-recent turn\n${tail}`);

  // 8. recalled context for the current message (opt-in via `query`).
  const recalled = recalledLayer(dir, query, recallK);
  if (recalled) parts.push(recalled);

  return parts.join('\n\n');
}
