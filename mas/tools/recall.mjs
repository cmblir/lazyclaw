// recall tool — Phase B (v5 §4.5).
//
// FTS5-backed cross-scope recall. Reads from mas/index_db.mjs (the
// SQLite mirror populated by Phase A's write-through hooks).
//
// Args:
//   query:     required string
//   scope:     optional array of 'sessions'|'skills'|'trajectories'|'memories'
//              (default: all four)
//   k:         optional integer, default 10, hard-capped at 50
//   summarize: optional boolean (v5.1+ wires the trainer; v5.0 leaves
//              summary null when set, so the agent gets raw hits.)
//   filter:    optional object of UNINDEXED column equality filters
//              (session_id, agent, outcome, trained_by, group_name, kind, since)

import { openIndex, recall as indexRecall } from '../index_db.mjs';

export const NAME = 'recall';
export const DESCRIPTION =
  'Search prior sessions, skills, trajectories, and memories by FTS5 query. Returns ranked snippets with metadata. Use this BEFORE asking the user to repeat themselves or before solving a problem from scratch.';
export const PARAMETERS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'FTS5 MATCH query. Plain words are AND-ed.' },
    scope: { type: 'array', items: { type: 'string', enum: ['sessions', 'skills', 'trajectories', 'memories'] } },
    k: { type: 'integer', minimum: 1, maximum: 50 },
    summarize: { type: 'boolean' },
    filter: { type: 'object', additionalProperties: true },
  },
  required: ['query'],
};

const DEFAULT_SCOPES = ['sessions', 'skills', 'trajectories', 'memories'];
const MAX_K = 50;

export async function exec(args, { configDir } = {}) {
  if (!args || typeof args.query !== 'string' || !args.query.trim()) {
    return { ok: false, error: 'recall: query is required' };
  }
  const query = args.query.trim();
  const scopes = Array.isArray(args.scope) && args.scope.length ? args.scope : DEFAULT_SCOPES;
  const k = Math.max(1, Math.min(MAX_K, Number(args.k) || 10));
  const filter = args.filter && typeof args.filter === 'object' ? args.filter : {};
  const t0 = Date.now();

  try {
    openIndex(configDir);
  } catch (err) {
    return { ok: false, error: `recall: openIndex failed — ${err?.message || err}` };
  }

  // Delegate to the index's own recall; it already enforces k≤50, sorts
  // by bm25 across scopes, and returns {scope, rank, bm25, snippet, metadata}.
  let out;
  try {
    out = indexRecall(query, { configDir, scope: scopes, k });
  } catch (err) {
    return { ok: false, error: `recall: query failed — ${err?.message || err}` };
  }

  // Apply optional UNINDEXED filter (metadata-level equality / since predicate).
  let hits = Array.isArray(out.hits) ? out.hits : [];
  const filterKeys = Object.keys(filter);
  if (filterKeys.length) {
    hits = hits.filter((h) => {
      const meta = h.metadata || {};
      for (const key of filterKeys) {
        if (key === 'since') {
          if (Number(meta.ts || 0) < Number(filter.since)) return false;
        } else if (String(meta[key] ?? '') !== String(filter[key])) {
          return false;
        }
      }
      return true;
    });
  }

  return {
    ok: true,
    query,
    hits: hits.slice(0, k),
    summary: null,           // v5.0: raw hits only; v5.1 wires trainer.
    summarizedBy: null,
    latencyMs: Date.now() - t0,
  };
}
