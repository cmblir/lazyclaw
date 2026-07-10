// mas/recall_blend.mjs — pure helpers for hybrid recall (JS cosine + bm25
// blend). No native vector extension and no DB access: index_db.mjs owns the
// SQLite handle and passes a getVec(scope, rowid) lookup in. Kept here so
// index_db.mjs stays one-responsibility (and under its size ceiling).

// Float32 vector <-> SQLite BLOB.
export function f32ToBlob(vec) {
  return Buffer.from(Float32Array.from(vec).buffer);
}
export function blobToF32(buf) {
  if (!buf || !buf.byteLength) return null;
  const out = new Float32Array(buf.byteLength >> 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Re-rank FTS candidates by a fused bm25 + cosine score. bm25 is
// ascending-better and cosine is descending-better, so each is min-max
// normalized to [0,1] (higher = better) before the weighted sum. Candidates
// with no stored vector (or a dim mismatch) get vecNorm 0 — they keep their
// bm25 standing and never outrank a real semantic match. Strictly additive:
// it only re-orders the same hit set, never drops a hit.
//   hits     — [{ bm25, ... }]
//   rowmeta  — parallel [{ scope, key }] where `key` is the doc's STABLE
//              natural key (never the FTS rowid, which is unstable across
//              reindex), so a vector only ever pairs with its own doc.
//   qvec     — query embedding (Float32Array)
//   getVec   — (scope, key) => Float32Array | null
export function blendHybrid(hits, rowmeta, qvec, getVec, weights) {
  const wFts = Number.isFinite(weights?.fts) ? weights.fts : 0.5;
  const wVec = Number.isFinite(weights?.vec) ? weights.vec : 0.5;
  const bm25s = hits.map((h) => h.bm25);
  const bMin = Math.min(...bm25s), bMax = Math.max(...bm25s);
  const ftsScore = (b) => (bMax === bMin ? 1 : (bMax - b) / (bMax - bMin)); // best (lowest) bm25 → 1
  const vecScores = hits.map((_, i) => {
    try {
      const dv = getVec(rowmeta[i].scope, rowmeta[i].key);
      if (!dv || dv.length !== qvec.length) return null;
      return cosine(qvec, dv);
    } catch { return null; }
  });
  const present = vecScores.filter((v) => v != null);
  const vMin = present.length ? Math.min(...present) : 0;
  const vMax = present.length ? Math.max(...present) : 1;
  const vNorm = (v) => (v == null ? 0 : (vMax === vMin ? 1 : (v - vMin) / (vMax - vMin)));
  return hits
    .map((h, i) => ({ h, score: wFts * ftsScore(h.bm25) + wVec * vNorm(vecScores[i]) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.h);
}
