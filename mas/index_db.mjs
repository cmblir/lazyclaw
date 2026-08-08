// mas/index_db.mjs — Phase A.
//
// Single SQLite handle per configDir backing four FTS5 virtual tables
// (spec §4.3). The daemon opens the db at boot; CLI subcommands open
// on demand. WAL mode lets many readers coexist with the one writer.
//
// Index failure NEVER propagates — see spec §4.4: write-through hooks
// log and swallow so a corrupt index can't break the session-write
// path. Recovery is via `pompos index rebuild`.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { redactSecrets } from './redact.mjs';
import { blobToF32, blendHybrid } from './recall_blend.mjs';
import {
  SKILL_CONFIDENCE_FLOOR,
  _skillRankWeight,
  _miniFrontmatter,
} from './index_rank.mjs';
import {
  _logIndexFailure,
  _resetNativeHint,
  _isNativeAbiError,
  _warnIndexFailure,
} from './index_failures.mjs';
import {
  normScope, scopeMatchClause, readStoredVersion,
  buildRecallSQL, RECALL_SCOPES, scopedStmt,
} from './index_scope.mjs';
import { embeddingKey } from './embedding_keys.mjs';
import { defaultConfigDir as resolveConfigDir } from '../lib/config_dir.mjs';

// Re-exported so callers/tests keep importing these from index_db.mjs
// (their historical location) even though the impls now live in index_failures.
export { _resetNativeHint, _isNativeAbiError, _warnIndexFailure };

// v2 adds a `doc_scope` UNINDEXED column to every FTS5 table (Phase 2 scoped
// recall). v3 re-keys embeddings by a STABLE natural key (see embedding_keys)
// instead of the FTS5 implicit rowid, which is NOT stable across
// delete-then-insert/reindex — the old rowid-keyed vectors could mis-join to the
// wrong doc, so the version bump DROPS them (embeddings are opt-in + off by
// default; they recompute on the next backfill). Bumping the version rebuilds an
// old index from source.
const SCHEMA_VERSION = 3;
const _handles = new Map();   // configDir → { db, stmts }

function defaultConfigDir() {
  return resolveConfigDir();
}

function dbPath(configDir) {
  return path.join(configDir, 'index.db');
}

function ensureSchema(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_sessions USING fts5(
      content,
      session_id UNINDEXED, turn_idx UNINDEXED, role UNINDEXED, ts UNINDEXED,
      doc_scope UNINDEXED
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_skills USING fts5(
      content,
      skill_name UNINDEXED, trained_by UNINDEXED, group_name UNINDEXED,
      doc_scope UNINDEXED
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_trajectories USING fts5(
      content,
      trajectory_id UNINDEXED, agent UNINDEXED, outcome UNINDEXED,
      doc_scope UNINDEXED
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(
      content,
      topic UNINDEXED, kind UNINDEXED,
      doc_scope UNINDEXED
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    -- Opt-in hybrid recall (roadmap #4): doc embeddings keyed by (scope, stable
    -- natural key) — NOT the FTS implicit rowid, which churns on
    -- delete-then-insert/reindex and would mis-join a vector to the wrong doc
    -- (see embedding_keys.mjs). Stored as a Float32 BLOB; cosine runs in JS (no
    -- native vector extension). Empty/unused unless cfg.recall.embeddings is on.
    CREATE TABLE IF NOT EXISTS embeddings (
      scope TEXT, doc_key TEXT, vec BLOB,
      PRIMARY KEY (scope, doc_key)
    );
  `);
  const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!cur) {
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  }
}

function prepareStatements(db) {
  const out = {
    insertSession: db.prepare(
      `INSERT INTO fts_sessions(content, session_id, turn_idx, role, ts, doc_scope)
       VALUES (?, ?, ?, ?, ?, ?)`),
    insertSkill: db.prepare(
      `INSERT INTO fts_skills(content, skill_name, trained_by, group_name, doc_scope)
       VALUES (?, ?, ?, ?, ?)`),
    insertTrajectory: db.prepare(
      `INSERT INTO fts_trajectories(content, trajectory_id, agent, outcome, doc_scope)
       VALUES (?, ?, ?, ?, ?)`),
    insertMemory: db.prepare(
      `INSERT INTO fts_memories(content, topic, kind, doc_scope)
       VALUES (?, ?, ?, ?)`),
    // Upsert-by-natural-key deletes (skills/trajectories/memories only —
    // these get re-indexed for the same key on every save/put, so a bare
    // INSERT would accumulate duplicate FTS rows that skew bm25 and eat the
    // recall k-budget). Sessions are NOT deduped this way: each turn has a
    // unique (session_id,turn_idx) in normal flow, and a per-turn full-table
    // DELETE would reintroduce O(n^2) on the hot write path; session dedup is
    // handled by reindexAll rebuilding from scratch.
    deleteSkill: db.prepare(`DELETE FROM fts_skills WHERE skill_name = ?`),
    deleteTrajectory: db.prepare(`DELETE FROM fts_trajectories WHERE trajectory_id = ?`),
    deleteMemory: db.prepare(`DELETE FROM fts_memories WHERE topic = ? AND kind = ?`),
    // Hybrid recall: query/insert doc embeddings by (scope, stable doc_key).
    getEmbedding: db.prepare(`SELECT vec FROM embeddings WHERE scope = ? AND doc_key = ?`),
    putEmbedding: db.prepare(`INSERT OR REPLACE INTO embeddings(scope, doc_key, vec) VALUES (?, ?, ?)`),
  };
  // Recall SQL templates live in index_scope.buildRecallSQL; the OPT-IN
  // doc_scope filter is spliced between MATCH and ORDER BY. `doc_scope` is NOT
  // selected (the filter runs in SQL) so it never leaks into a hit's metadata.
  // No-scope prepared statements are the byte-stable default recall path; scoped
  // variants are prepared per distinct clause and cached (see scopedStmt).
  out.queries = {};
  for (const sc of RECALL_SCOPES) out.queries[sc] = db.prepare(buildRecallSQL(sc));
  out._scopedCache = new Map();  // scopeClause → { [sc]: Statement }
  out._db = db;
  return out;
}

// Guards re-entry while a stale-schema rebuild is in flight (reindexAll re-calls
// openIndex, which would otherwise re-fire the version check).
let _migrating = false;

export function openIndex(configDir = defaultConfigDir(), opts = {}) {
  const dir = configDir;
  if (_handles.has(dir)) return _handles.get(dir).db;
  fs.mkdirSync(dir, { recursive: true });
  // Schema-version drift: an on-disk index predating the current DDL (e.g. v1
  // FTS tables with no doc_scope column) is rebuilt from the on-disk sources via
  // reindexAll — CREATE ... IF NOT EXISTS can't add a column to an existing FTS5
  // table, so a clean rebuild IS the migration. Best-effort (never blocks open).
  if (!_migrating) {
    const stored = readStoredVersion(dbPath(dir));
    if (stored !== null && stored !== SCHEMA_VERSION) {
      _migrating = true;
      try {
        reindexAll(dir);
        if (_handles.has(dir)) return _handles.get(dir).db;
      } catch (e) {
        _warnIndexFailure('schema migration rebuild failed', e);
      } finally {
        _migrating = false;
      }
    }
  }
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
  // Hot path (recall + session/trajectory writes). Skip the O(index-size)
  // PRAGMA integrity_check here — because each turn is a fresh process, paying
  // it on the first index touch stalls the first user turn by 50-80ms+ (and
  // growing). It is reserved for `doctor` / `index rebuild`, which open/run it
  // explicitly; corruption then surfaces at query time (logged) instead.
  if (!_handles.has(configDir)) openIndex(configDir, { runIntegrityCheck: false });
  return _handles.get(configDir).stmts;
}

export function indexSessionTurn(row, configDir = defaultConfigDir(), opts = {}) {
  try {
    const s = _stmts(configDir);
    s.insertSession.run(
      redactSecrets(String(row.content || '')),
      String(row.session_id || ''), Number(row.turn_idx || 0),
      String(row.role || ''), Number(row.ts || Date.now()),
      normScope(opts.docScope ?? opts.scope ?? row.docScope ?? row.scope),
    );
  } catch (e) {
    _logIndexFailure(configDir, 'sessions', e);
    _warnIndexFailure('indexSessionTurn failed', e);
  }
}

export function indexSkill(row, configDir = defaultConfigDir(), opts = {}) {
  try {
    const s = _stmts(configDir);
    s.deleteSkill.run(String(row.skill_name || ''));   // upsert by skill_name
    s.insertSkill.run(
      redactSecrets(String(row.content || '')),
      String(row.skill_name || ''), String(row.trained_by || ''),
      String(row.group_name || ''),
      normScope(opts.docScope ?? opts.scope ?? row.docScope ?? row.scope),
    );
  } catch (e) {
    _logIndexFailure(configDir, 'skills', e);
    _warnIndexFailure('indexSkill failed', e);
  }
}

// Remove a skill's FTS row so an archived/removed skill stops surfacing in
// recall. Until now deleteSkill only ran as an upsert prelude inside
// indexSkill; skills.removeSkill unlinks the .md but left the stale FTS row
// recallable. Best-effort like the index writers — a delete hiccup must
// never fail the caller's archive/remove path.
export function deleteSkill(skillName, configDir = defaultConfigDir()) {
  try {
    const s = _stmts(configDir);
    s.deleteSkill.run(String(skillName || ''));
  } catch (e) {
    _logIndexFailure(configDir, 'skills', e);
    _warnIndexFailure('deleteSkill failed', e);
  }
}

export function indexTrajectory(row, configDir = defaultConfigDir(), opts = {}) {
  try {
    const s = _stmts(configDir);
    s.deleteTrajectory.run(String(row.trajectory_id || ''));   // upsert by trajectory_id
    s.insertTrajectory.run(
      redactSecrets(String(row.content || '')),
      String(row.trajectory_id || ''), String(row.agent || ''),
      String(row.outcome || ''),
      normScope(opts.docScope ?? opts.scope ?? row.docScope ?? row.scope),
    );
  } catch (e) {
    _logIndexFailure(configDir, 'trajectories', e);
    _warnIndexFailure('indexTrajectory failed', e);
  }
}

export function indexMemory(row, configDir = defaultConfigDir(), opts = {}) {
  try {
    const s = _stmts(configDir);
    s.deleteMemory.run(String(row.topic || ''), String(row.kind || ''));   // upsert by (topic,kind)
    s.insertMemory.run(
      redactSecrets(String(row.content || '')),
      String(row.topic || ''), String(row.kind || ''),
      normScope(opts.docScope ?? opts.scope ?? row.docScope ?? row.scope),
    );
  } catch (e) {
    _logIndexFailure(configDir, 'memories', e);
    _warnIndexFailure('indexMemory failed', e);
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

/**
 * Cross-scope FTS5 recall. Content-only semantics — all UNINDEXED metadata
 * columns (session_id, skill_name, agent, outcome, topic, …) are returned as
 * `metadata` but NOT searchable via MATCH (m9). Use `opts.where` to post-filter.
 *
 * @param {string} query  FTS5 MATCH query. Sanitised by default (`-`, `:`, `+`
 *                        → spaces, so "write-through" isn't parsed as NOT). Pass
 *                        `opts.raw=true` for real FTS5 operators (NOT, OR, near).
 * @param {Object} [opts]
 * @param {string} [opts.configDir]
 * @param {string[]} [opts.scope]  table categories to search; default all four
 * @param {string|string[]} [opts.docScope]  OPT-IN owner-scope filter: restricts
 *                        hits to these scope(s) + always-allowed 'global'.
 *                        Omitted => no filter (byte-stable global recall).
 * @param {number} [opts.k]        default 10, capped at 50
 * @param {boolean} [opts.raw]     bypass sanitiseFtsQuery (power users)
 * @param {Object} [opts.where]    metadata equality post-filter, e.g.
 *                        { trained_by: 'human' }; values coerced to string.
 * @param {string} [opts.workerProvider]  caller's provider (e.g. 'anthropic');
 *                        a cross-family skill is dampened via crossCliDampen.
 */
export function recall(query, opts = {}) {
  const t0 = process.hrtime.bigint();
  const configDir = opts.configDir || defaultConfigDir();
  const scope = opts.scope || RECALL_SCOPES;
  const k = Math.min(Math.max(Number(opts.k) || 10, 1), 50);
  const s = _stmts(configDir);
  const safeQuery = opts.raw ? String(query ?? '').trim() : sanitizeFtsQuery(query);
  const whereKeys = (opts.where && typeof opts.where === 'object') ? Object.keys(opts.where) : [];
  // Over-fetch when a where-filter is set: post-filter can drop most
  // hits, so request 2x k from FTS5 so the final trimmed slice has
  // enough to fill k. Capped at the FTS5-side 200 hard limit.
  // Hybrid blend over the same candidates needs a wider FTS pool to re-rank.
  const blend = !!(opts.queryVector && opts.queryVector.length);
  const fetchK = blend ? Math.min(200, Math.max(k * 4, 40))
    : (whereKeys.length ? Math.min(200, k * 2) : k);
  // OPT-IN doc-scope filter (Phase 2). `opts.docScope` (owner key or array)
  // restricts hits to those scope(s) + always-allowed 'global'; omitted => empty
  // clause => byte-stable no-filter path. Named docScope so it can't collide
  // with `opts.scope` (the table-category selector above).
  const { clause: scopeClause, params: scopeParams } = scopeMatchClause(opts.docScope);
  const hits = [];
  // parallel to hits: { scope, key } — `key` is the doc's STABLE natural key
  // (derived from the hit's metadata), so the cosine join only ever pairs a
  // vector with the doc it was computed for. A null key => no embedding join.
  const rowmeta = [];
  for (const sc of scope) {
    const stmt = scopedStmt(s, sc, scopeClause);
    if (!stmt) continue;
    try {
      const rows = stmt.all(safeQuery, ...scopeParams, fetchK);
      for (const r of rows) {
        // `rowid` is destructured OUT so it never leaks into the returned
        // metadata (keeps the hit shape byte-stable for non-blend callers).
        const { scope: sc2, bm25, snippet, rowid, ...metadata } = r;
        // snippet() wraps the matched term in <mark>..</mark>; recall hits
        // are fed verbatim into agent prompts, where the markup is noise.
        // Return plain text — strip the tags FTS5 injected.
        const plainSnippet = typeof snippet === 'string'
          ? snippet.replace(/<\/?mark>/g, '')
          : snippet;
        // Apply where-filter at row level — keeps the bm25 ordering
        // intact and avoids re-fetching after sort.
        if (whereKeys.length) {
          let skip = false;
          for (const wk of whereKeys) {
            if (String(metadata[wk] ?? '') !== String(opts.where[wk])) { skip = true; break; }
          }
          if (skip) continue;
        }
        hits.push({ scope: sc2, rank: hits.length, bm25, snippet: plainSnippet, metadata });
        // `rowid` (destructured above) is intentionally NOT used to key the
        // embedding — it is unstable across reindex. Derive the stable key from
        // the same metadata columns backfill keyed on.
        rowmeta.push({ scope: sc2, key: embeddingKey(sc2, metadata) });
      }
    } catch (e) {
      // FTS5 MATCH syntax errors are caller mistakes; skip silently.
      // "no such column" arises from the FTS5 column-filter syntax when
      // a stray colon/operator survives sanitisation — also benign.
      if (!/syntax error|no such column/i.test(e.message)) throw e;
    }
  }
  // Confidence-aware ranking (Phase 0): weight each skills-scope hit's base
  // relevance by its frontmatter confidence (floored) and the cross-CLI dampen.
  // SQLite bm25 is negative and sorted ascending (more-negative = more
  // relevant); multiplying by a weight in (0,1] pulls a skill's score TOWARD
  // zero, demoting it. Non-skills hits keep their exact bm25 as the sort key so
  // sessions/trajectories/memories order is byte-stable.
  const workerProvider = opts.workerProvider ? String(opts.workerProvider).trim() : '';
  const sortKey = (h) => {
    if (h.scope !== 'skills') return h.bm25;
    const w = _skillRankWeight(h.metadata?.skill_name, configDir, workerProvider);
    return h.bm25 * (w > 0 ? w : SKILL_CONFIDENCE_FLOOR);
  };
  // Opt-in hybrid re-rank when the caller supplies a query vector; otherwise
  // the confidence-weighted bm25 order is used (pure bm25 for non-skills).
  // Join a hit to its vector by (scope, stable key). A null key (metadata
  // missing a natural-key field) => no vector => the hit keeps its bm25 score.
  const getVec = (sc, key) => {
    if (key == null) return null;
    const row = s.getEmbedding.get(sc, key);
    return row ? blobToF32(row.vec) : null;
  };
  const ordered = blend
    ? blendHybrid(hits, rowmeta, opts.queryVector, getVec, opts.weights)
    : hits.sort((a, b) => sortKey(a) - sortKey(b));
  const trimmed = ordered.slice(0, k);
  for (let i = 0; i < trimmed.length; i++) trimmed[i].rank = i;
  const elapsedNs = process.hrtime.bigint() - t0;
  return { query, hits: trimmed, latencyMs: Number(elapsedNs) / 1e6 };
}

// Backfill doc embeddings for FTS rows that don't have one yet. Opt-in: a no-op
// (returns 0) when cfg.recall.embeddings is off or no embedder resolves (the
// default / $0 path). Runs OFF the chat write hot path — call it explicitly
// (a reindex, a CLI command, or a background pass) so a network embedding call
// never lands on a reply. Best-effort: embed/store failures are swallowed and
// logged so a flaky embedder can never corrupt the FTS index. Returns the
// number of rows embedded.
export async function backfillEmbeddings(configDir = defaultConfigDir(), cfg = {}, opts = {}) {
  const { getEmbedder } = await import('./embedder.mjs');
  const embedder = getEmbedder(cfg, opts);
  if (!embedder) return 0;
  const db = openIndex(configDir, { runIntegrityCheck: false });
  const s = _stmts(configDir);
  const { runBackfill } = await import('./embed_backfill.mjs');
  return runBackfill(db, s.putEmbedding, embedder, opts,
    (scope, e) => _logIndexFailure(configDir, `embed:${scope}`, e));
}

export function integrityCheck(configDir = defaultConfigDir()) {
  const db = openIndex(configDir);
  const r = db.pragma('integrity_check', { simple: true });
  return { ok: r === 'ok', result: r };
}

// Destructive primitive: drop the db (+ WAL sidecars) and recreate the empty
// schema. Callers that want a *populated* index must use reindexAll — a bare
// rebuild leaves recall returning zero hits.
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

// Rebuild + repopulate moved to mas/reindex.mjs (this file was at its size
// limit). Imported rather than only re-exported: `export ... from` creates no
// local binding, and openIndex calls reindexAll itself on a schema-version
// migration. The import cycle (reindex.mjs imports our function declarations,
// which hoist) is evaluated safely in either load order.
import { reindexAll } from './reindex.mjs';
export { reindexAll };
