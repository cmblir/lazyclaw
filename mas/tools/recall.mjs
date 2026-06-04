// recall — agent-callable wrapper around the Phase B recall() function.
// The actual FTS5 backed recall lives in mas/recall.mjs (Phase B); we
// dynamically import to avoid forcing better-sqlite3 to load when an agent
// never calls recall. __setRecall lets tests inject a stub.

let _recall = null;

export function __setRecall(fn) { _recall = fn; }

async function getRecall() {
  if (_recall) return _recall;
  const mod = await import('../recall.mjs').catch(() => null);
  if (!mod || typeof mod.recall !== 'function') {
    throw new Error('recall: Phase B (mas/recall.mjs) not available');
  }
  _recall = mod.recall;
  return _recall;
}

export const TOOL = {
  name: 'recall',
  category: 'learning',
  sensitive: false,
  description: 'Search past sessions, skills, trajectories, and memories. Returns ranked snippets.',
  parameters: {
    type: 'object',
    properties: {
      query:     { type: 'string', description: 'Free-text query.' },
      scope:     { type: 'array', items: { type: 'string', enum: ['sessions', 'skills', 'trajectories', 'memories'] } },
      k:         { type: 'number', description: 'Max hits (default 10, max 50).' },
      summarize: { type: 'boolean', description: 'Ask trainer to summarise hits.' },
    },
    required: ['query'],
  },
  async exec(args) {
    if (!args || typeof args.query !== 'string' || !args.query.trim()) return { ok: false, error: 'recall: query required' };
    try {
      const fn = await getRecall();
      const out = await fn(args.query, {
        scope: args.scope,
        k: args.k,
        summarize: args.summarize,
      });
      return { ok: true, ...out };
    } catch (e) {
      return { ok: false, error: `recall: ${e.message}` };
    }
  },
};
