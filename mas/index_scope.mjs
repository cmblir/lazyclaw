// mas/index_scope.mjs — Phase 2 (scoped recall).
//
// Recall was per-configDir GLOBAL: every indexed doc was recallable from any
// turn, so in a multi-agent / multi-workspace setup one agent's docs leaked
// into another's prompt. This module holds the scope helpers that keep
// index_db.mjs under the 500-line CI gate:
//   - GLOBAL_SCOPE / normScope: a doc's owner key (default 'global').
//   - scopeMatchClause: build the OPT-IN "(doc_scope IN (...) OR = global)"
//     SQL predicate + bind params for recall; omitted => no filter (byte-stable).
//   - migration detection: has the version drifted from the shipped schema?

import Database from 'better-sqlite3';
import fs from 'node:fs';

export const GLOBAL_SCOPE = 'global';

// Read the persisted schema_version WITHOUT creating any table, so openIndex can
// decide whether an on-disk index predates the current DDL (e.g. the v1 FTS
// tables that have no doc_scope column). Returns null when there is no index yet
// (fresh dir) — a fresh dir needs no migration. Best-effort: any read error is
// treated as "no stored version" so the caller falls through to normal schema
// creation rather than throwing on a corrupt/locked file.
export function readStoredVersion(dbFile) {
  if (!fs.existsSync(dbFile)) return null;
  let probe;
  try {
    probe = new Database(dbFile, { readonly: true });
    const hasMeta = probe.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
    if (!hasMeta) return null;
    const row = probe.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    return row ? Number(row.value) : null;
  } catch {
    return null;
  } finally {
    try { probe && probe.close(); } catch { /* ignore */ }
  }
}

// The four FTS5 table categories recall can search (kept here so index_db's
// prepareStatements can iterate them alongside the SQL builder below).
export const RECALL_SCOPES = ['sessions', 'skills', 'trajectories', 'memories'];

// Column projections per category. `doc_scope` is deliberately NOT projected —
// the scope filter runs in the WHERE clause, so the column never reaches a hit's
// metadata (keeps the hit shape byte-stable). `rowid` (FTS5 implicit) IS
// projected so a stored embedding can be joined back for the cosine blend.
const _RECALL_COLS = {
  sessions: 'session_id, turn_idx, role, ts',
  skills: 'skill_name, trained_by, group_name',
  trajectories: 'trajectory_id, agent, outcome',
  memories: 'topic, kind',
};

// Build the recall SQL for one category. `scopeClause` (default '') is spliced
// between the MATCH and ORDER BY; empty => the byte-stable no-filter query.
export function buildRecallSQL(sc, scopeClause = '') {
  const t = `fts_${sc}`;
  return `SELECT '${sc}' AS scope, bm25(${t}) AS bm25,
                snippet(${t}, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                rowid AS rowid, ${_RECALL_COLS[sc]}
           FROM ${t} WHERE content MATCH ?${scopeClause} ORDER BY bm25 LIMIT ?`;
}

// Recall statement for a scope+clause pair; scoped variants are prepared+cached
// on first use (`stmts` carries _scopedCache + _db), so the hot no-scope path
// keeps its precompiled statement.
export function scopedStmt(stmts, sc, scopeClause) {
  if (!scopeClause) return stmts.queries[sc];
  let bucket = stmts._scopedCache.get(scopeClause);
  if (!bucket) { bucket = {}; stmts._scopedCache.set(scopeClause, bucket); }
  if (!bucket[sc]) bucket[sc] = stmts._db.prepare(buildRecallSQL(sc, scopeClause));
  return bucket[sc];
}

// A scope is a short owner key (e.g. 'session:<id>', 'workspace:<name>',
// 'agent:<name>', 'global'). Coerce to a trimmed string; empty => global so a
// caller that passes '' or nothing indexes as global (current behavior).
export function normScope(scope) {
  const s = scope == null ? '' : String(scope).trim();
  return s || GLOBAL_SCOPE;
}

// Build the recall scope predicate. Returns { clause, params } where clause is
// an SQL fragment to AND after the MATCH, or '' when no scope filter applies
// (opts.scope omitted) — the byte-stable "global recall" path.
//
// When scope is provided (a single string or an array), results are restricted
// to those scopes PLUS the always-allowed GLOBAL_SCOPE, so global docs stay
// visible under any narrow scope.
export function scopeMatchClause(scope) {
  if (scope === undefined || scope === null) return { clause: '', params: [] };
  const list = Array.isArray(scope) ? scope : [scope];
  const allowed = new Set();
  for (const s of list) {
    const n = normScope(s);
    if (n) allowed.add(n);
  }
  allowed.add(GLOBAL_SCOPE);   // global is always allowed
  const params = [...allowed];
  const placeholders = params.map(() => '?').join(', ');
  return { clause: ` AND doc_scope IN (${placeholders})`, params };
}
