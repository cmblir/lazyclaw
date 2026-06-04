// mas/trajectory_store.mjs — Phase A.
//
// Persists TrajectoryRecord (spec §3.3) to JSONL on disk plus an
// in-memory cache. Storage layout:
//   <configDir>/trajectories/<YYYY-MM-DD>/<id>.jsonl
// One file per trajectory id (a ULID) so concurrent writers never
// contend. A single in-memory Map<id, record> serves hot reads; cold
// reads stream the file back through JSON.parse.
//
// Phase A scope: write, read, list-by-task. Recall by full-text query
// lives in mas/index_db.mjs (FTS5). The two stores share the same
// record but the FTS5 mirror is best-effort — disk JSONL is the
// source of truth.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { redactSecrets } from './redact.mjs';
import { indexTrajectory as _indexTrajectory } from './index_db.mjs';

export const OUTCOME_ENUM = Object.freeze(['done', 'failed', 'abandoned']);

const _cache = new Map();   // id → record (capped at CACHE_MAX entries)
const CACHE_MAX = 256;

function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

function trajectoriesDir(configDir) {
  return path.join(configDir, 'trajectories');
}

// Crockford-base32 ULID generator. Monotonic within a single ms by
// appending a counter — same-millisecond puts stay sortable.
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let _ulidLastMs = 0;
let _ulidCounter = 0;
let _ulidLastRandPrefix = '';
function ulid() {
  let now = Date.now();
  let sameMs = (now === _ulidLastMs);
  if (sameMs) _ulidCounter++;
  else { _ulidLastMs = now; _ulidCounter = 0; }
  let timePart = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ALPHABET[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  // Hold the random prefix stable within a single ms so the counter
  // suffix is the ONLY thing that changes — that's what keeps same-ms
  // ULIDs lexicographically sortable (canonical ULID monotonicity).
  if (!sameMs) {
    const rand = crypto.randomBytes(10);
    let randPart = '';
    for (let i = 0; i < 16; i++) {
      randPart += ULID_ALPHABET[rand[i % 10] % 32];
    }
    _ulidLastRandPrefix = randPart.slice(0, 14);
  }
  // Counter suffix (last 2 chars) keeps monotonicity intra-ms.
  const ctr = ULID_ALPHABET[(_ulidCounter >> 5) % 32]
            + ULID_ALPHABET[_ulidCounter % 32];
  return timePart + _ulidLastRandPrefix + ctr;
}

function redactTurns(turns) {
  return (turns || []).map(t => ({
    ...t,
    content: typeof t.content === 'string' ? redactSecrets(t.content) : t.content,
    thinking: typeof t.thinking === 'string' ? redactSecrets(t.thinking) : t.thinking,
    toolCalls: (t.toolCalls || []).map(c => ({
      ...c,
      result: typeof c.result === 'string' ? redactSecrets(c.result) : c.result,
    })),
  }));
}

function dateBucket(ms) {
  return new Date(ms).toISOString().slice(0, 10);   // YYYY-MM-DD
}

function recordPath(configDir, bucket, id) {
  return path.join(trajectoriesDir(configDir), bucket, `${id}.jsonl`);
}

function cachePush(id, rec) {
  _cache.set(id, rec);
  if (_cache.size > CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

export async function put(record, opts = {}) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('trajectory_store.put: record must be an object');
  }
  if (!OUTCOME_ENUM.includes(record.outcome)) {
    throw new Error(
      `outcome must be one of ${OUTCOME_ENUM.join('|')}, got ${record.outcome}`,
    );
  }
  const configDir = opts.configDir || defaultConfigDir();
  const id = record.id || ulid();
  const stored = {
    ...record,
    id,
    systemPrompt: typeof record.systemPrompt === 'string'
      ? redactSecrets(record.systemPrompt) : '',
    userMessages: (record.userMessages || []).map(m =>
      typeof m === 'string' ? redactSecrets(m) : m),
    turns: redactTurns(record.turns),
    finalAnswer: typeof record.finalAnswer === 'string'
      ? redactSecrets(record.finalAnswer) : '',
  };
  const bucket = dateBucket(stored.startedAt || Date.now());
  const file = recordPath(configDir, bucket, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored) + '\n');
  // Phase A: FTS5 mirror (spec §4.4). Content is the concatenation of
  // the final answer plus every turn's textual content so a single
  // recall() can surface trajectories by either signal.
  try {
    const ftsContent = [
      stored.finalAnswer || '',
      ...(stored.turns || []).map(t => String(t.content || '')),
    ].filter(Boolean).join('\n');
    _indexTrajectory({
      trajectory_id: id,
      agent: stored.agentName || '',
      outcome: stored.outcome,
      content: ftsContent,
    }, configDir);
  } catch { /* swallow */ }
  cachePush(id, stored);
  return stored;
}

export async function get(id, opts = {}) {
  if (_cache.has(id)) return _cache.get(id);
  const configDir = opts.configDir || defaultConfigDir();
  const root = trajectoriesDir(configDir);
  if (!fs.existsSync(root)) return null;
  for (const bucket of fs.readdirSync(root)) {
    const file = recordPath(configDir, bucket, id);
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim();
      const rec = JSON.parse(raw);
      cachePush(id, rec);
      return rec;
    }
  }
  return null;
}

export async function listByTaskId(taskId, opts = {}) {
  const configDir = opts.configDir || defaultConfigDir();
  const root = trajectoriesDir(configDir);
  if (!fs.existsSync(root)) return [];
  const matches = [];
  for (const bucket of fs.readdirSync(root).sort()) {
    const bdir = path.join(root, bucket);
    if (!fs.statSync(bdir).isDirectory()) continue;
    for (const f of fs.readdirSync(bdir).sort()) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(bdir, f), 'utf8'));
        if (rec.taskId === taskId) matches.push(rec);
      } catch { /* skip corrupt */ }
    }
  }
  return matches;
}

// Test/maintenance hook.
export function _resetCache() { _cache.clear(); }
