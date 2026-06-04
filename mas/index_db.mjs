// mas/index_db.mjs — Phase A.
//
// Single SQLite handle per configDir backing four FTS5 virtual tables
// (spec §4.3). The daemon opens the db at boot; CLI subcommands open
// on demand. WAL mode lets many readers coexist with the one writer.
//
// Index failure NEVER propagates — see spec §4.4: write-through hooks
// log and swallow so a corrupt index can't break the session-write
// path. Recovery is via `lazyclaw index rebuild`.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { redactSecrets } from './redact.mjs';

const SCHEMA_VERSION = 1;
const _handles = new Map();   // configDir → { db, stmts }

function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

function dbPath(configDir) {
  return path.join(configDir, 'index.db');
}

function ensureSchema(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_sessions USING fts5(
      content,
      session_id UNINDEXED, turn_idx UNINDEXED, role UNINDEXED, ts UNINDEXED
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_skills USING fts5(
      content,
      skill_name UNINDEXED, trained_by UNINDEXED, group_name UNINDEXED
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_trajectories USING fts5(
      content,
      trajectory_id UNINDEXED, agent UNINDEXED, outcome UNINDEXED
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(
      content,
      topic UNINDEXED, kind UNINDEXED
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!cur) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  }
}

function prepareStatements(db) {
  return {
    insertSession: db.prepare(
      `INSERT INTO fts_sessions(content, session_id, turn_idx, role, ts)
       VALUES (?, ?, ?, ?, ?)`),
    insertSkill: db.prepare(
      `INSERT INTO fts_skills(content, skill_name, trained_by, group_name)
       VALUES (?, ?, ?, ?)`),
    insertTrajectory: db.prepare(
      `INSERT INTO fts_trajectories(content, trajectory_id, agent, outcome)
       VALUES (?, ?, ?, ?)`),
    insertMemory: db.prepare(
      `INSERT INTO fts_memories(content, topic, kind)
       VALUES (?, ?, ?)`),
    queries: {
      sessions: db.prepare(
        `SELECT 'sessions' AS scope, bm25(fts_sessions) AS bm25,
                snippet(fts_sessions, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                session_id, turn_idx, role, ts
           FROM fts_sessions WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
      skills: db.prepare(
        `SELECT 'skills' AS scope, bm25(fts_skills) AS bm25,
                snippet(fts_skills, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                skill_name, trained_by, group_name
           FROM fts_skills WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
      trajectories: db.prepare(
        `SELECT 'trajectories' AS scope, bm25(fts_trajectories) AS bm25,
                snippet(fts_trajectories, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                trajectory_id, agent, outcome
           FROM fts_trajectories WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
      memories: db.prepare(
        `SELECT 'memories' AS scope, bm25(fts_memories) AS bm25,
                snippet(fts_memories, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                topic, kind
           FROM fts_memories WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
    },
  };
}

export function openIndex(configDir = defaultConfigDir(), opts = {}) {
  const dir = configDir;
  if (_handles.has(dir)) return _handles.get(dir).db;
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath(dir));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  ensureSchema(db);
  if (opts.runIntegrityCheck !== false) {
    const r = db.pragma('integrity_check', { simple: true });
    if (r !== 'ok') {
      // eslint-disable-next-line no-console
      console.warn(`[index_db] integrity_check returned ${r} for ${dbPath(dir)}`);
    }
  }
  const stmts = prepareStatements(db);
  _handles.set(dir, { db, stmts });
  return db;
}

export function closeIndex(configDir = defaultConfigDir()) {
  const h = _handles.get(configDir);
  if (!h) return;
  try { h.db.close(); } catch { /* ignore */ }
  _handles.delete(configDir);
}

function _stmts(configDir) {
  if (!_handles.has(configDir)) openIndex(configDir);
  return _handles.get(configDir).stmts;
}

export function indexSessionTurn(row, configDir = defaultConfigDir()) {
  try {
    const s = _stmts(configDir);
    s.insertSession.run(
      redactSecrets(String(row.content || '')),
      String(row.session_id || ''), Number(row.turn_idx || 0),
      String(row.role || ''), Number(row.ts || Date.now()),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[index_db] indexSessionTurn failed:', e.message);
  }
}

export function indexSkill(row, configDir = defaultConfigDir()) {
  try {
    const s = _stmts(configDir);
    s.insertSkill.run(
      redactSecrets(String(row.content || '')),
      String(row.skill_name || ''), String(row.trained_by || ''),
      String(row.group_name || ''),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[index_db] indexSkill failed:', e.message);
  }
}

export function indexTrajectory(row, configDir = defaultConfigDir()) {
  try {
    const s = _stmts(configDir);
    s.insertTrajectory.run(
      redactSecrets(String(row.content || '')),
      String(row.trajectory_id || ''), String(row.agent || ''),
      String(row.outcome || ''),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[index_db] indexTrajectory failed:', e.message);
  }
}

export function indexMemory(row, configDir = defaultConfigDir()) {
  try {
    const s = _stmts(configDir);
    s.insertMemory.run(
      redactSecrets(String(row.content || '')),
      String(row.topic || ''), String(row.kind || ''),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[index_db] indexMemory failed:', e.message);
  }
}

// FTS5 query parser treats `-` as unary NOT and `:` as a column filter, so
// raw user phrases like "write-through" turn into a NOT op against a
// non-existent column. Strip FTS5 operators down to whitespace before the
// MATCH so a bareword recall behaves like content search. Quoted phrases
// from the caller are left alone (one or more `"` survives).
function sanitizeFtsQuery(q) {
  const s = String(q ?? '').trim();
  if (!s) return s;
  // Preserve quoted phrases verbatim; rewrite only unquoted runs.
  if (/["()*^]/.test(s)) return s;
  return s.replace(/[-:+]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function recall(query, opts = {}) {
  const t0 = process.hrtime.bigint();
  const configDir = opts.configDir || defaultConfigDir();
  const scope = opts.scope || ['sessions', 'skills', 'trajectories', 'memories'];
  const k = Math.min(Math.max(Number(opts.k) || 10, 1), 50);
  const s = _stmts(configDir);
  const safeQuery = sanitizeFtsQuery(query);
  const hits = [];
  for (const sc of scope) {
    const stmt = s.queries[sc];
    if (!stmt) continue;
    try {
      const rows = stmt.all(safeQuery, k);
      for (const r of rows) {
        const { scope: sc2, bm25, snippet, ...metadata } = r;
        hits.push({ scope: sc2, rank: hits.length, bm25, snippet, metadata });
      }
    } catch (e) {
      // FTS5 MATCH syntax errors are caller mistakes; skip silently.
      // "no such column" arises from the FTS5 column-filter syntax when
      // a stray colon/operator survives sanitisation — also benign.
      if (!/syntax error|no such column/i.test(e.message)) throw e;
    }
  }
  hits.sort((a, b) => a.bm25 - b.bm25);
  const trimmed = hits.slice(0, k);
  for (let i = 0; i < trimmed.length; i++) trimmed[i].rank = i;
  const elapsedNs = process.hrtime.bigint() - t0;
  return { query, hits: trimmed, latencyMs: Number(elapsedNs) / 1e6 };
}

export function integrityCheck(configDir = defaultConfigDir()) {
  const db = openIndex(configDir);
  const r = db.pragma('integrity_check', { simple: true });
  return { ok: r === 'ok', result: r };
}

export function rebuild(configDir = defaultConfigDir()) {
  closeIndex(configDir);
  const p = dbPath(configDir);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    // WAL sidecar files
    for (const ext of ['-wal', '-shm']) {
      const side = p + ext;
      if (fs.existsSync(side)) fs.unlinkSync(side);
    }
  }
  openIndex(configDir);
}
