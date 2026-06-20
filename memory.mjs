// Layered memory for LazyClaw.
//
// Three storage shapes under <configDir>/memory/:
//   core.md                — single curated file. User-edited or LLM-edited.
//                            Long-lived; survives `dream()`. Mounted into
//                            every goal tick + every `/loop --use-memory`.
//   recent.jsonl           — append-only log of {sessionId, role, content,
//                            ts}, one line per call to sessions.appendTurn.
//                            Capped softly at RECENT_CAP entries; truncated
//                            hard to RECENT_KEEP_AFTER_DREAM after dream().
//   episodic/<topic>.md    — one file per topic produced by dream().
//                            Filenames are kebab-case slugs derived from
//                            the topic strings the provider returned.
//
// `appendRecent` is the only entry point sessions.appendTurn calls. It
// swallows every error — memory must not break the session-write path.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MEMORY_DIRNAME = 'memory';
const RECENT_CAP = 200;
const RECENT_KEEP_AFTER_DREAM = 50;

// Best-effort, lazy write-through into the durable FTS recall index. Lazy so
// better-sqlite3 stays off the chat hot path (this leaf module is touched on
// every turn via appendRecent) until something actually curates memory; the
// promise is swallowed so an index hiccup never breaks a memory write.
function _indexMemorySafe(row, configDir) {
  import('./mas/index_db.mjs')
    .then((idx) => { try { idx.indexMemory(row, configDir); } catch { /* best-effort */ } })
    .catch(() => { /* index module unavailable — recall just stays stale */ });
}

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

export function memoryDir(configDir = defaultConfigDir()) { return path.join(configDir, MEMORY_DIRNAME); }
export function corePath(configDir = defaultConfigDir()) { return path.join(memoryDir(configDir), 'core.md'); }
export function recentPath(configDir = defaultConfigDir()) { return path.join(memoryDir(configDir), 'recent.jsonl'); }
export function episodicDir(configDir = defaultConfigDir()) { return path.join(memoryDir(configDir), 'episodic'); }

export function loadCore(configDir = defaultConfigDir()) {
  const p = corePath(configDir);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

export function setCore(text, configDir = defaultConfigDir()) {
  fs.mkdirSync(memoryDir(configDir), { recursive: true });
  fs.writeFileSync(corePath(configDir), String(text || ''));
  // Mirror into the recall index so curated core memory is durably searchable
  // (the README "durable recall over … memory" claim) — not just readable.
  _indexMemorySafe({ topic: 'core', kind: 'core', content: String(text || '') }, configDir);
}

export function loadRecent(n = 20, configDir = defaultConfigDir()) {
  const p = recentPath(configDir);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const slice = n > 0 ? lines.slice(-n) : lines;
  const out = [];
  for (const l of slice) {
    try { out.push(JSON.parse(l)); } catch { /* skip malformed */ }
  }
  return out;
}

export function listEpisodic(configDir = defaultConfigDir()) {
  const dir = episodicDir(configDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3));
}

export function loadEpisodic(topic, configDir = defaultConfigDir()) {
  const p = path.join(episodicDir(configDir), `${topic}.md`);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

// Sync, swallowed-failure write-through called from sessions.appendTurn.
export function appendRecent(sessionId, role, content, configDir = defaultConfigDir()) {
  try {
    fs.mkdirSync(memoryDir(configDir), { recursive: true });
    const line = JSON.stringify({
      sessionId,
      role,
      content: String(content ?? ''),
      ts: Date.now(),
    }) + '\n';
    fs.appendFileSync(recentPath(configDir), line);
    // Cheap stat-based check to avoid read-rewrite on every append.
    const st = fs.statSync(recentPath(configDir));
    if (st.size > 1_000_000) {
      const lines = fs.readFileSync(recentPath(configDir), 'utf8').split('\n').filter(Boolean);
      if (lines.length > RECENT_CAP) {
        fs.writeFileSync(recentPath(configDir), lines.slice(-RECENT_CAP).join('\n') + '\n');
      }
    }
  } catch { /* swallow — memory failure must not break session writes */ }
}

// `dream(sessionId)` consolidates recent.jsonl into per-topic episodic
// files using the active provider, then truncates recent.jsonl to the
// last RECENT_KEEP_AFTER_DREAM entries. Returns { topics: [slug,...] }.
//
// The mock provider doesn't return JSON, so we accept any string and
// fall back to a single "recent-<date>" topic containing the raw reply.
// Real providers (Anthropic / OpenAI) typically obey the JSON instruction.
export async function dream(sessionId, { provider, model, apiKey } = {}, configDir = defaultConfigDir()) {
  if (!provider) throw new Error('dream() requires a provider');
  const turns = loadRecent(1000, configDir);
  if (turns.length === 0) return { topics: [] };

  const prompt = [
    'Below are recent chat turns. Group them under topics and summarise each topic in one paragraph.',
    'Dedupe aggressively. If two turns cover the same topic, merge.',
    'Output strict JSON of shape: {"topics": [{"topic": "kebab-case-slug", "summary": "..."}]}',
    '',
    'Turns:',
    ...turns.map(t => `- [${t.role}@${t.sessionId}]: ${String(t.content).slice(0, 500)}`),
  ].join('\n');

  let raw = '';
  for await (const chunk of provider.sendMessage([{ role: 'user', content: prompt }], { apiKey, model })) {
    raw += chunk;
  }
  let parsed = null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch { parsed = null; }
  const topics = (parsed?.topics && Array.isArray(parsed.topics) && parsed.topics.length)
    ? parsed.topics
    : [{ topic: 'recent-' + new Date().toISOString().slice(0, 10), summary: raw.slice(0, 4000) || '(no content)' }];

  fs.mkdirSync(episodicDir(configDir), { recursive: true });
  const written = [];
  // Index the episodic topics in the same pass. dream() is async, so we await
  // the (lazy) index import once for a deterministic write-through; a failure
  // is swallowed so consolidation still succeeds even if recall can't index.
  let indexDb = null;
  try { indexDb = await import('./mas/index_db.mjs'); } catch { /* recall stays stale */ }
  for (const t of topics) {
    if (!t || !t.topic) continue;
    const slug = String(t.topic).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
    const p = path.join(episodicDir(configDir), `${slug}.md`);
    fs.writeFileSync(p, `# ${slug}\n\n${t.summary || ''}\n`);
    if (indexDb) { try { indexDb.indexMemory({ topic: slug, kind: 'episodic', content: String(t.summary || '') }, configDir); } catch { /* best-effort */ } }
    written.push(slug);
  }

  // Hard truncate recent.jsonl after a successful dream.
  const rp = recentPath(configDir);
  if (fs.existsSync(rp)) {
    const lines = fs.readFileSync(rp, 'utf8').split('\n').filter(Boolean);
    if (lines.length > RECENT_KEEP_AFTER_DREAM) {
      fs.writeFileSync(rp, lines.slice(-RECENT_KEEP_AFTER_DREAM).join('\n') + '\n');
    }
  }
  return { topics: written };
}

// Returns a single string suitable for prepending to a tick / loop
// prompt. Core memory always comes first; episodic files are included
// only when their topic slug substring-matches a word ≥3 chars from
// the goal name + description.
export function getMemoryForGoal(name, description = '', configDir = defaultConfigDir()) {
  const parts = [];
  const core = loadCore(configDir);
  if (core.trim()) parts.push(`## Core memory\n${core}`);
  const keywords = String(name + ' ' + description).toLowerCase()
    .split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  if (keywords.length) {
    const topics = listEpisodic(configDir);
    for (const t of topics) {
      const tl = t.toLowerCase();
      if (keywords.some(k => tl.includes(k))) {
        const body = loadEpisodic(t, configDir);
        if (body.trim()) parts.push(`## Episodic: ${t}\n${body}`);
      }
    }
  }
  return parts.join('\n\n');
}

// Recall helper used by `/loop --recall "<query>"`. Tokenises the query,
// scores recent and episodic entries by overlap, returns the top-N
// matches as a single concatenated string. Cheap, no external index.
export function recall(query, { topN = 3 } = {}, configDir = defaultConfigDir()) {
  const tokens = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  if (!tokens.length) return '';
  const candidates = [];
  for (const slug of listEpisodic(configDir)) {
    const body = loadEpisodic(slug, configDir);
    candidates.push({ source: `episodic:${slug}`, body });
  }
  for (const turn of loadRecent(200, configDir)) {
    candidates.push({ source: `recent:${turn.sessionId || '?'}`, body: String(turn.content || '') });
  }
  const scored = candidates.map((c) => {
    const lower = c.body.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (lower.includes(t)) score += 1;
    }
    return { ...c, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topN);
  return scored.map(c => `## ${c.source} (score ${c.score})\n${c.body}`).join('\n\n');
}
