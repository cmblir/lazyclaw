// daemon/lib/inbound_dedup.mjs — idempotency store for POST /inbound.
//
// A channel retry (Slack event redelivery, a listener restart replaying its
// backlog, app_mention+message double-fire arriving from two listener
// processes) must not run the provider twice or append duplicate turns to the
// session. Callers claim `${channel}:${messageId}` BEFORE persisting the user
// turn, record the reply after, and a duplicate replays the recorded reply.
//
// Persistence: append-only JSONL at <cfgDir>/inbound_seen.jsonl (0600 — the
// recorded replies are conversation content), loaded on open, compacted to
// the newest `cap` entries when the file grows past 4×cap lines. Pending
// (claimed-but-unrecorded) keys are memory-only with a TTL so a crash between
// claim and record can never permanently wedge a message id.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CAP = 500;
const DEFAULT_PENDING_TTL_MS = 120_000;

// One instance per config dir — the daemon is long-lived and the store keeps
// its working set in memory; reopening per request would re-read the file.
const _instances = new Map();
export function _resetDedupCache() { _instances.clear(); }

export function openDedup(cfgDir, { cap = DEFAULT_CAP, pendingTtlMs = DEFAULT_PENDING_TTL_MS, now = Date.now } = {}) {
  const existing = _instances.get(cfgDir);
  if (existing) return existing;

  const file = path.join(cfgDir, 'inbound_seen.jsonl');
  /** @type {Map<string, {reply: string, threadId: string|null, sessionId: string|null, at: number}>} */
  const entries = new Map(); // insertion order == age order
  /** @type {Map<string, number>} pending claim -> claimed-at ms */
  const pending = new Map();

  const load = () => {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { return; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; } // skip corrupt lines
      if (!rec || typeof rec.key !== 'string') continue;
      entries.delete(rec.key); // re-insert to refresh age order
      entries.set(rec.key, { reply: rec.reply ?? '', threadId: rec.threadId ?? null, sessionId: rec.sessionId ?? null, at: rec.at ?? 0 });
    }
    trim();
  };

  const trim = () => {
    while (entries.size > cap) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
  };

  const compactIfNeeded = () => {
    let lines = 0;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') lines++;
    } catch { return; }
    if (lines <= cap * 4) return;
    const out = [...entries.entries()]
      .map(([key, e]) => JSON.stringify({ key, ...e }))
      .join('\n') + '\n';
    try { fs.writeFileSync(file, out, { mode: 0o600 }); } catch { /* compaction is best-effort */ }
  };

  const store = {
    claim(key) {
      const hit = entries.get(key);
      if (hit) return { dup: true, pending: false, entry: hit };
      const claimedAt = pending.get(key);
      if (claimedAt != null && now() - claimedAt < pendingTtlMs) {
        return { dup: true, pending: true, entry: null };
      }
      pending.set(key, now());
      return { dup: false, pending: false, entry: null };
    },
    record(key, { reply = '', threadId = null, sessionId = null } = {}) {
      pending.delete(key);
      const entry = { reply, threadId, sessionId, at: now() };
      entries.delete(key);
      entries.set(key, entry);
      trim();
      try {
        fs.appendFileSync(file, JSON.stringify({ key, ...entry }) + '\n', { mode: 0o600 });
      } catch { /* persistence is best-effort; memory dedup still holds */ }
      compactIfNeeded();
    },
    release(key) { pending.delete(key); },
  };

  load();
  _instances.set(cfgDir, store);
  return store;
}
