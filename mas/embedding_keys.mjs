// mas/embedding_keys.mjs — stable natural keys for hybrid-recall embeddings.
//
// WHY: embeddings used to be keyed by the FTS5 IMPLICIT rowid. FTS5 rowids are
// NOT stable across delete-then-insert (indexSkill/indexTrajectory/indexMemory
// delete-then-insert on every save; reindexAll rebuilds from scratch), so a
// stored vector silently ended up pointing at a DIFFERENT (or absent) document
// after any re-index. blendHybrid guards a dim mismatch but cannot detect a
// rowid that now maps to a different doc → confidently WRONG cosine scores.
//
// Fix: key embeddings by each doc's STABLE natural key instead of the rowid, and
// derive the SAME key on both sides (backfill from FTS columns; recall from a
// hit's metadata). A vector is then only ever paired with the doc it was
// computed for. A hit with no vector under its key simply falls back to bm25.

// Field separator that cannot appear in a normal id/name/topic — keeps compound
// keys (sessions, memories) unambiguous.
const SEP = '\x1f';

// The natural-key column set per FTS category, in the order that composes the
// stable key. These match the UNINDEXED columns projected by buildRecallSQL, so
// a recall hit's metadata carries exactly what we need to rebuild the key.
const KEY_FIELDS = {
  sessions: ['session_id', 'turn_idx'],
  skills: ['skill_name'],
  trajectories: ['trajectory_id'],
  memories: ['topic', 'kind'],
};

// Build the stable key for `scope` from a plain object of that category's
// natural-key fields (a recall hit's metadata, or an FTS backfill row). Returns
// null when the scope is unknown or a required field is missing/empty, so the
// caller falls back to bm25 rather than joining on a bogus key.
export function embeddingKey(scope, fields) {
  const cols = KEY_FIELDS[scope];
  if (!cols || !fields) return null;
  const parts = [];
  for (const c of cols) {
    const v = fields[c];
    // turn_idx=0 is valid; only null/undefined/'' is missing.
    if (v === null || v === undefined || v === '') return null;
    parts.push(String(v));
  }
  return parts.join(SEP);
}

// The extra FTS columns backfill must SELECT (beyond content) to derive the key.
export function keyColumns(scope) {
  return KEY_FIELDS[scope] || [];
}
