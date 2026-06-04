// Nudge loop — Phase B (v5 §3.6).
//
// Periodically scans the tail of memory/recent.jsonl, clusters
// repeated user prompts, and (when a cluster crosses minCount) emits
// a `nudge.suggest_skill` event into the daemon's SSE bus so the
// curator UI can suggest "should I turn this into a skill?".
//
// v5.0 scope: emit only. Cross-channel push (Slack/Telegram) lands in
// v5.1 per spec §0.2.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_TAIL = 200;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;   // 5 min
const DEFAULT_MIN_COUNT = 3;

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

function recentPath(configDir) {
  return path.join(configDir, 'memory', 'recent.jsonl');
}

export function readRecent(configDir = defaultConfigDir(), n = DEFAULT_TAIL) {
  const p = recentPath(configDir);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean).slice(-n);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clusterRecent(entries, { minCount = DEFAULT_MIN_COUNT } = {}) {
  const byKey = new Map();
  for (const e of entries || []) {
    if (e.role && e.role !== 'user') continue;
    const key = normalise(e.content);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { key, count: 0, sample: e.content, firstTs: e.ts, lastTs: e.ts });
    const c = byKey.get(key);
    c.count += 1;
    c.lastTs = e.ts;
  }
  return [...byKey.values()].filter((c) => c.count >= minCount).sort((a, b) => b.count - a.count);
}

export function makeNudgeEvent({ cluster, ts = Date.now() } = {}) {
  return {
    kind: 'nudge.suggest_skill',
    ts,
    cluster: {
      count: cluster.count,
      sample: cluster.sample,
      firstTs: cluster.firstTs,
      lastTs: cluster.lastTs,
    },
    suggestion: `Repeated prompt: "${String(cluster.sample).slice(0, 80)}" (${cluster.count}×). Consider /skill create.`,
  };
}

export function startNudgeLoop({ configDir = defaultConfigDir(), intervalMs = DEFAULT_INTERVAL_MS, minCount = DEFAULT_MIN_COUNT, emit, logger } = {}) {
  if (typeof emit !== 'function') throw new Error('startNudgeLoop: emit(event) is required');
  let timer = null;
  let stopped = false;

  function tick() {
    if (stopped) return;
    try {
      const entries = readRecent(configDir);
      const clusters = clusterRecent(entries, { minCount });
      for (const c of clusters) emit(makeNudgeEvent({ cluster: c }));
    } catch (err) {
      try { logger?.warn?.('nudge_tick_failed', { err: err.message }); } catch { /* ignore */ }
    }
  }

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
    runOnce: tick,
  };
}
