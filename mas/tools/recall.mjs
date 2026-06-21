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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openIndex, recall as indexRecall } from '../index_db.mjs';
import { sameFamily } from '../confidence.mjs';

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
    // M10 — cross-CLI provider-aware ranking. When the caller is a
    // worker on a specific provider (e.g. anthropic/openai/gemini),
    // skills whose frontmatter cross_cli_tested[] includes that
    // provider's family are boosted ahead of untested duplicates.
    workerProvider: { type: 'string', description: 'Boost skills whose cross_cli_tested[] includes this provider family (e.g. "anthropic").' },
  },
  required: ['query'],
};

const DEFAULT_SCOPES = ['sessions', 'skills', 'trajectories', 'memories'];
const MAX_K = 50;

function _defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

// Read config.json from the tool's own configDir (not the env), so hybrid
// recall reads the right config when the dir is passed explicitly. Best-effort.
function _readCfg(configDir) {
  try { return JSON.parse(fs.readFileSync(path.join(configDir || _defaultConfigDir(), 'config.json'), 'utf8')); }
  catch { return {}; }
}

// Minimal frontmatter parser — read just the cross_cli_tested provider
// list for a skill by name. Returns [] when the file is missing or
// parse fails (best-effort ranking helper, not a strict loader).
function _readSkillCrossCli(skillName, configDir) {
  if (!skillName) return [];
  try {
    const dir = configDir || _defaultConfigDir();
    const filePath = path.join(dir, 'skills', `${skillName}.md`);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return [];
    const fm = m[1];
    // Find cross_cli_tested block — YAML list form:
    //   cross_cli_tested:
    //     - provider: anthropic
    //       …
    const idx = fm.indexOf('cross_cli_tested:');
    if (idx < 0) return [];
    const tail = fm.slice(idx);
    const providers = [];
    for (const line of tail.split('\n')) {
      const pm = line.match(/^\s*-?\s*provider:\s*['"]?([\w.-]+)['"]?\s*$/);
      if (pm) providers.push(pm[1]);
    }
    return providers;
  } catch { return []; }
}

let _stubRecall = null;
export function __setRecall(fn) { _stubRecall = typeof fn === 'function' ? fn : null; }

export async function exec(args, { configDir } = {}) {
  if (!args || typeof args.query !== 'string' || !args.query.trim()) {
    return { ok: false, error: 'recall: query is required' };
  }
  const query = args.query.trim();
  const scopes = Array.isArray(args.scope) && args.scope.length ? args.scope : DEFAULT_SCOPES;
  const k = Math.max(1, Math.min(MAX_K, Number(args.k) || 10));
  const filter = args.filter && typeof args.filter === 'object' ? args.filter : {};
  const t0 = Date.now();

  let out;
  if (_stubRecall) {
    try {
      out = await _stubRecall(query, { scope: scopes, k });
    } catch (err) {
      return { ok: false, error: `recall: stub threw — ${err?.message || err}` };
    }
  } else {
    try {
      // Skip the full-b-tree integrity_check on the read hot path. recall is
      // the most frequent reader and every CLI subcommand / agent worker is a
      // fresh process, so the check (which scales with index size) would be
      // paid on essentially every recall. It belongs in `doctor`, not here.
      openIndex(configDir, { runIntegrityCheck: false });
    } catch (err) {
      return { ok: false, error: `recall: openIndex failed — ${err?.message || err}` };
    }
    // Hybrid recall: when cfg.recall.embeddings is enabled, embed the query and
    // pass the vector so index_db re-ranks candidates by semantic similarity.
    // Opt-in + best-effort — any embed failure falls back to pure FTS5.
    let queryVector, weights;
    try {
      const cfg = _readCfg(configDir);
      const { getEmbedder } = await import('../embedder.mjs');
      const embedder = getEmbedder(cfg);
      if (embedder) {
        const [v] = await embedder.embed([query]);
        if (v && v.length) { queryVector = v; weights = cfg.recall?.embeddings?.weights; }
      }
    } catch { /* fall back to pure FTS */ }
    try {
      out = indexRecall(query, { configDir, scope: scopes, k, ...(queryVector ? { queryVector, weights } : {}) });
    } catch (err) {
      return { ok: false, error: `recall: query failed — ${err?.message || err}` };
    }
  }

  // Apply optional UNINDEXED filter (metadata-level equality / since predicate).
  let hits = Array.isArray(out.hits) ? out.hits : [];
  const filterKeys = Object.keys(filter);
  if (filterKeys.length) {
    hits = hits.filter((h) => {
      const meta = h.metadata || {};
      for (const key of filterKeys) {
        if (key === 'since') {
          // Only fts_sessions carries a ts column; skills/trajectories/
          // memories have no ts. A "since" bound must NOT silently drop
          // those ts-less hits — only drop a hit that HAS a ts older than
          // the bound. (meta.ts === undefined / '' means "no timestamp".)
          if (meta.ts !== undefined && meta.ts !== null && meta.ts !== '') {
            if (Number(meta.ts) < Number(filter.since)) return false;
          }
        } else if (String(meta[key] ?? '') !== String(filter[key])) {
          return false;
        }
      }
      return true;
    });
  }

  // M10 — cross-CLI provider-aware boost. For each `skills` hit, peek
  // at the skill file's cross_cli_tested[] frontmatter. If any entry's
  // provider is in the same family as workerProvider, promote the hit
  // above untested siblings. We do this AFTER the FTS5 ranking so the
  // base bm25 ordering still dominates — boosting is a tie-breaker /
  // small re-rank, not a wholesale replacement.
  const workerProvider = args.workerProvider ? String(args.workerProvider).trim() : '';
  if (workerProvider) {
    const boosted = hits.map((h, idx) => {
      if (h.scope !== 'skills') return { h, boost: 0, idx };
      const skillName = h.metadata?.skill_name || '';
      const tested = _readSkillCrossCli(skillName, configDir);
      const matched = tested.some((p) => sameFamily(p, workerProvider));
      return { h, boost: matched ? 1 : 0, idx };
    });
    // Stable sort: matching skills first (boost desc), then preserve
    // original FTS5 order via idx for ties.
    boosted.sort((a, b) => (b.boost - a.boost) || (a.idx - b.idx));
    hits = boosted.map((b) => ({ ...b.h, crossCliBoosted: b.boost > 0 }));
  }

  return {
    ok: true,
    query,
    hits: hits.slice(0, k),
    summary: null,           // v5.0: raw hits only; v5.1 wires trainer.
    summarizedBy: null,
    workerProvider: workerProvider || null,
    latencyMs: Date.now() - t0,
  };
}

export const TOOL = {
  name: NAME,
  category: 'learning',
  sensitive: false,
  description: DESCRIPTION,
  parameters: PARAMETERS,
  exec,
};
