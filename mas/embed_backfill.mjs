// mas/embed_backfill.mjs — the opt-in embedding backfill loop, extracted from
// index_db.mjs to keep that file under the 500-line CI gate. index_db owns the
// SQLite handle + prepared statements and passes them in (no DB import here,
// no circular dependency).

import { f32ToBlob } from './recall_blend.mjs';
import { embeddingKey, keyColumns } from './embedding_keys.mjs';

const SCOPES = {
  sessions: 'fts_sessions', skills: 'fts_skills',
  trajectories: 'fts_trajectories', memories: 'fts_memories',
};

// Backfill doc embeddings for FTS rows that don't have one yet. Opt-in: the
// caller only reaches here when an embedder resolved (feature on). Best-effort:
// embed/store failures are swallowed + logged via `logFail` so a flaky embedder
// can never corrupt the FTS index. Vectors are keyed by (scope, STABLE natural
// key) — never the FTS rowid, which churns across reindex. Returns the number of
// rows embedded.
//   db        — better-sqlite3 handle
//   putEmbedding — prepared INSERT OR REPLACE(scope, doc_key, vec)
//   embedder  — { embed(texts) => Promise<Float32Array[]> }
//   logFail   — (scope, err) => void
export async function runBackfill(db, putEmbedding, embedder, opts, logFail) {
  const limit = Number(opts.limit) || 500;
  let embedded = 0;
  for (const [scope, table] of Object.entries(SCOPES)) {
    // Select the natural-key columns alongside content so each vector is stored
    // under the SAME stable key recall derives from a hit's metadata (rowid is
    // NOT used — it churns across reindex and would mis-join the vector).
    const cols = ['f.content AS content', ...keyColumns(scope).map((c) => `f.${c} AS ${c}`)].join(', ');
    let rows;
    try {
      rows = db.prepare(`SELECT ${cols} FROM ${table} f LIMIT ?`).all(limit);
    } catch { continue; }
    if (!rows.length) continue;
    // Already-embedded keys for this scope, so a re-run only embeds new docs.
    let have;
    try {
      have = new Set(db.prepare('SELECT doc_key FROM embeddings WHERE scope = ?')
        .all(scope).map((r) => r.doc_key));
    } catch { have = new Set(); }
    // Pair each row with its stable key; skip rows with no derivable key or one
    // already embedded before spending an embed call on them.
    const pending = [];
    for (const r of rows) {
      const key = embeddingKey(scope, r);
      if (key == null || have.has(key)) continue;
      pending.push({ key, content: r.content });
    }
    if (!pending.length) continue;
    let vecs;
    try { vecs = await embedder.embed(pending.map((p) => p.content)); }
    catch (e) { logFail(scope, e); continue; }
    for (let i = 0; i < pending.length; i++) {
      const v = vecs[i];
      if (!v || !v.length) continue;
      try { putEmbedding.run(scope, pending[i].key, f32ToBlob(v)); embedded++; }
      catch { /* swallow — never break the backfill on a single bad row */ }
    }
  }
  return embedded;
}
