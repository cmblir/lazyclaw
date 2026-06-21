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

// Static layer files (global SOUL.md, workspace SOUL.md, personality, USER.md)
// are re-read on every composePromptStack call — and that runs once per
// iteration of the per-message agent loop (mention_router), where these layers
// are byte-identical every pass. Memoize by path + mtime so an unchanged file
// is read from disk once, not N times; editing the file bumps its mtime and
// busts the entry, so correctness is preserved. Mirrors the skills.mjs
// _indexCache pattern. Layers 7-8 (recent.jsonl tail, FTS recall) deliberately
// stay un-memoized — they are meant to be volatile per turn.
const _readCache = new Map();  // path → { mtimeMs, content }

export function _invalidateReadCache() { _readCache.clear(); }

function readOpt(p) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(p).mtimeMs;
  } catch {
    // Missing/unreadable — drop any stale entry and return empty.
    _readCache.delete(p);
    return '';
  }
  const hit = _readCache.get(p);
  if (hit && hit.mtimeMs === mtimeMs) return hit.content;
  try {
    const content = fs.readFileSync(p, 'utf8').trim();
    _readCache.set(p, { mtimeMs, content });
    return content;
  } catch {
    _readCache.delete(p);
    return '';
  }
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
  // FTS5 ANDs space-separated terms, so a natural-language message rarely
  // matches a prior doc. Build an OR query over the significant terms (bm25
  // still ranks rarer, more-relevant matches first) and pass it raw — each
  // term is [a-z0-9] only, so no FTS operator can be injected.
  const terms = [...new Set((String(query).toLowerCase().match(/[a-z0-9]{3,}/g) || []))].slice(0, 12);
  if (!terms.length) return '';
  try {
    const r = _recall(terms.join(' OR '), { configDir: dir, scope: ['sessions', 'trajectories', 'memories'], k, raw: true });
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
