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
import { f32ToBlob, blobToF32, blendHybrid } from './recall_blend.mjs';

const SCHEMA_VERSION = 1;
const _handles = new Map();   // configDir → { db, stmts }

function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

// m11 — when a write-through hook fails, append a structured entry to
// <configDir>/index-failures.jsonl so `lazyclaw doctor` can surface
// recent failures (last 24h) and the operator can rebuild before the
// silent stale-index problem compounds. Best-effort: any error during
// the append itself is swallowed (we don't want to spam stderr from a
// background hook).
function _logIndexFailure(configDir, scope, err) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, 'index-failures.jsonl');
    const entry = {
      ts: new Date().toISOString(),
      event: 'index.write.failed',
      scope,
      error: String(err?.message || err || 'unknown'),
    };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch { /* swallow — surface only via console.warn below */ }
}

// The native better-sqlite3 addon fails to load when node_modules was built
// against a different Node.js ABI than the one running lazyclaw (a Node switch
// via nvm/brew, or copied node_modules). Every index op then throws the same
// thing — so instead of dumping the raw stack on each write, recognise it and
// print ONE actionable hint, then stay quiet. Chat is unaffected; only recall /
// skill search degrade until the addon is rebuilt.
let _nativeHintShown = false;
export function _resetNativeHint() { _nativeHintShown = false; } // test seam
export function _isNativeAbiError(e) {
  return /NODE_MODULE_VERSION|was compiled against a different Node|better_sqlite3\.node|invalid ELF header|dlopen\(/i
    .test(String(e?.message || e || ''));
}
export function _warnIndexFailure(label, e) {
  if (_isNativeAbiError(e)) {
    if (_nativeHintShown) return;
    _nativeHintShown = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[index_db] recall index disabled — better-sqlite3 was built for a different Node.js version.\n' +
      '           Re-enable it once with:  npm rebuild better-sqlite3   (in the lazyclaw install dir),\n' +
      '           or reinstall deps with the Node you run lazyclaw with. Chat is unaffected.');
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(`[index_db] ${label}:`, e.message);
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
    -- Opt-in hybrid recall (roadmap #4): doc embeddings keyed to the FTS row's
    -- implicit rowid + scope. Stored as a Float32 BLOB; cosine runs in JS (no
    -- native vector extension). Empty/unused unless cfg.recall.embeddings is on.
    CREATE TABLE IF NOT EXISTS embeddings (
      scope TEXT, rowid_ref INTEGER, vec BLOB,
      PRIMARY KEY (scope, rowid_ref)
    );
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
    // Hybrid recall: query/insert doc embeddings by (scope, FTS rowid).
    getEmbedding: db.prepare(`SELECT vec FROM embeddings WHERE scope = ? AND rowid_ref = ?`),
    putEmbedding: db.prepare(`INSERT OR REPLACE INTO embeddings(scope, rowid_ref, vec) VALUES (?, ?, ?)`),
    queries: {
      // `rowid` (FTS5 implicit) is selected so a stored embedding can be joined
      // back to its row for the cosine blend; recall() strips it from metadata.
      sessions: db.prepare(
        `SELECT 'sessions' AS scope, bm25(fts_sessions) AS bm25,
                snippet(fts_sessions, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                rowid AS rowid, session_id, turn_idx, role, ts
           FROM fts_sessions WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
      skills: db.prepare(
        `SELECT 'skills' AS scope, bm25(fts_skills) AS bm25,
                snippet(fts_skills, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                rowid AS rowid, skill_name, trained_by, group_name
           FROM fts_skills WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
      trajectories: db.prepare(
        `SELECT 'trajectories' AS scope, bm25(fts_trajectories) AS bm25,
                snippet(fts_trajectories, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                rowid AS rowid, trajectory_id, agent, outcome
           FROM fts_trajectories WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
      memories: db.prepare(
        `SELECT 'memories' AS scope, bm25(fts_memories) AS bm25,
                snippet(fts_memories, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                rowid AS rowid, topic, kind
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
  // Hot path (recall + session/trajectory writes). Skip the O(index-size)
  // PRAGMA integrity_check here — because each turn is a fresh process, paying
  // it on the first index touch stalls the first user turn by 50-80ms+ (and
  // growing). It is reserved for `doctor` / `index rebuild`, which open/run it
  // explicitly; corruption then surfaces at query time (logged) instead.
  if (!_handles.has(configDir)) openIndex(configDir, { runIntegrityCheck: false });
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
    _logIndexFailure(configDir, 'sessions', e);
    _warnIndexFailure('indexSessionTurn failed', e);
  }
}

export function indexSkill(row, configDir = defaultConfigDir()) {
  try {
    const s = _stmts(configDir);
    s.deleteSkill.run(String(row.skill_name || ''));   // upsert by skill_name
    s.insertSkill.run(
      redactSecrets(String(row.content || '')),
      String(row.skill_name || ''), String(row.trained_by || ''),
      String(row.group_name || ''),
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

export function indexTrajectory(row, configDir = defaultConfigDir()) {
  try {
    const s = _stmts(configDir);
    s.deleteTrajectory.run(String(row.trajectory_id || ''));   // upsert by trajectory_id
    s.insertTrajectory.run(
      redactSecrets(String(row.content || '')),
      String(row.trajectory_id || ''), String(row.agent || ''),
      String(row.outcome || ''),
    );
  } catch (e) {
    _logIndexFailure(configDir, 'trajectories', e);
    _warnIndexFailure('indexTrajectory failed', e);
  }
}

export function indexMemory(row, configDir = defaultConfigDir()) {
  try {
    const s = _stmts(configDir);
    s.deleteMemory.run(String(row.topic || ''), String(row.kind || ''));   // upsert by (topic,kind)
    s.insertMemory.run(
      redactSecrets(String(row.content || '')),
      String(row.topic || ''), String(row.kind || ''),
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
 * Cross-scope FTS5 recall. Content-only semantics — all UNINDEXED
 * metadata columns (session_id, skill_name, agent, outcome, topic, …)
 * are returned as `metadata` but NOT searchable via MATCH (m9). Use
 * `opts.where` to post-filter on metadata equality.
 *
 * @param {string} query  FTS5 MATCH query. By default the query is
 *                        sanitised: `-`, `:`, `+` rewritten to spaces
 *                        so a bareword like "write-through" doesn't
 *                        get parsed as NOT-through. Pass `opts.raw=true`
 *                        to bypass sanitisation when you need real
 *                        FTS5 operators (NOT, OR, near).
 * @param {Object} [opts]
 * @param {string} [opts.configDir]
 * @param {string[]} [opts.scope]  default: all four scopes
 * @param {number} [opts.k]        default 10, capped at 50
 * @param {boolean} [opts.raw]     bypass sanitiseFtsQuery (power users)
 * @param {Object} [opts.where]    metadata equality post-filter, e.g.
 *                                 { trained_by: 'human', agent: 'reviewer' }
 *                                 Applied after FTS5 returns hits; values
 *                                 are coerced to string before compare.
 */
export function recall(query, opts = {}) {
  const t0 = process.hrtime.bigint();
  const configDir = opts.configDir || defaultConfigDir();
  const scope = opts.scope || ['sessions', 'skills', 'trajectories', 'memories'];
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
  const hits = [];
  const rowmeta = [];  // parallel to hits: { scope, rowid } for the cosine join
  for (const sc of scope) {
    const stmt = s.queries[sc];
    if (!stmt) continue;
    try {
      const rows = stmt.all(safeQuery, fetchK);
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
        rowmeta.push({ scope: sc2, rowid });
      }
    } catch (e) {
      // FTS5 MATCH syntax errors are caller mistakes; skip silently.
      // "no such column" arises from the FTS5 column-filter syntax when
      // a stray colon/operator survives sanitisation — also benign.
      if (!/syntax error|no such column/i.test(e.message)) throw e;
    }
  }
  // Opt-in hybrid re-rank when the caller supplies a query vector; otherwise
  // the exact pure-FTS bm25 order (today's behavior) is preserved.
  const getVec = (sc, rid) => { const row = s.getEmbedding.get(sc, rid); return row ? blobToF32(row.vec) : null; };
  const ordered = blend
    ? blendHybrid(hits, rowmeta, opts.queryVector, getVec, opts.weights)
    : hits.sort((a, b) => a.bm25 - b.bm25);
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
  const limit = Number(opts.limit) || 500;
  const SCOPES = {
    sessions: 'fts_sessions', skills: 'fts_skills',
    trajectories: 'fts_trajectories', memories: 'fts_memories',
  };
  let embedded = 0;
  for (const [scope, table] of Object.entries(SCOPES)) {
    let rows;
    try {
      rows = db.prepare(
        `SELECT f.rowid AS rowid, f.content AS content FROM ${table} f
          WHERE f.rowid NOT IN (SELECT rowid_ref FROM embeddings WHERE scope = ?)
          LIMIT ?`).all(scope, limit);
    } catch { continue; }
    if (!rows.length) continue;
    let vecs;
    try { vecs = await embedder.embed(rows.map((r) => r.content)); }
    catch (e) { _logIndexFailure(configDir, `embed:${scope}`, e); continue; }
    for (let i = 0; i < rows.length; i++) {
      const v = vecs[i];
      if (!v || !v.length) continue;
      try { s.putEmbedding.run(scope, rows[i].rowid, f32ToBlob(v)); embedded++; }
      catch { /* swallow — never break the backfill on a single bad row */ }
    }
  }
  return embedded;
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

// Minimal frontmatter splitter (trained_by / group are the only keys reindex
// needs); avoids importing skills.mjs and risking an import cycle.
function _miniFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(raw || ''));
  if (!m) return { meta: {}, body: String(raw || '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

// Rebuild AND repopulate the FTS index from the on-disk source of truth
// (sessions JSONL, flat skill .md, memory core/episodic). This is what
// `index rebuild` / doctor recovery must call — a bare rebuild() zeroes recall.
// Shared by scripts/migrate-v5 and the daemon POST /index/rebuild route.
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
  // Memory — core.md + episodic/*.md.
  const memDir = path.join(configDir, 'memory');
  if (fs.existsSync(memDir)) {
    const core = path.join(memDir, 'core.md');
    if (fs.existsSync(core)) indexMemory({ topic: 'core', kind: 'core', content: fs.readFileSync(core, 'utf8') }, configDir);
    const epi = path.join(memDir, 'episodic');
    if (fs.existsSync(epi)) {
      for (const f of fs.readdirSync(epi)) {
        if (!f.endsWith('.md')) continue;
        indexMemory({ topic: f.slice(0, -'.md'.length), kind: 'episodic', content: fs.readFileSync(path.join(epi, f), 'utf8') }, configDir);
      }
    }
  }
}
