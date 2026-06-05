// channels/threads.mjs
//
// threadId -> { channel, externalId, sessionId, lastTurnAt } JSONL store.
// Append-only on disk; in-memory map for read. The threadId is stable
// across /handoff so cross-channel migrations preserve session context.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const FILE = 'threads.jsonl';

function readAll(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt */ }
  }
  return out;
}

function newThreadId() {
  return 'th_' + crypto.randomBytes(8).toString('hex');
}

export function openThreads(configDir) {
  const dir = String(configDir || '.');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE);

  /** @type {Map<string, {threadId,channel,externalId,sessionId,lastTurnAt}>} */
  const byThread = new Map();
  /** @type {Map<string, string>} channel|externalId -> threadId */
  const byExternal = new Map();

  function externalKey(channel, externalId) {
    return `${channel}|${externalId}`;
  }

  function apply(row) {
    if (row.op === 'delete') {
      const existing = byThread.get(row.threadId);
      if (existing) {
        byExternal.delete(externalKey(existing.channel, existing.externalId));
        byThread.delete(row.threadId);
      }
      return;
    }
    const prev = byThread.get(row.threadId);
    if (prev) byExternal.delete(externalKey(prev.channel, prev.externalId));
    byThread.set(row.threadId, {
      threadId: row.threadId,
      channel: row.channel,
      externalId: row.externalId,
      sessionId: row.sessionId,
      lastTurnAt: row.lastTurnAt,
    });
    byExternal.set(externalKey(row.channel, row.externalId), row.threadId);
  }

  for (const row of readAll(file)) apply(row);

  function append(row) {
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    apply(row);
  }

  function upsert({ channel, externalId, sessionId, threadId }) {
    if (!channel || !externalId || !sessionId) {
      throw new Error('upsert requires channel, externalId, sessionId');
    }
    const existingId = byExternal.get(externalKey(channel, externalId));
    const id = threadId || existingId || newThreadId();
    const row = {
      op: 'upsert', threadId: id, channel, externalId, sessionId,
      lastTurnAt: Date.now(),
    };
    append(row);
    return byThread.get(id);
  }

  function findByExternal(channel, externalId) {
    const id = byExternal.get(externalKey(channel, externalId));
    return id ? byThread.get(id) : null;
  }

  function findByThread(threadId) {
    return byThread.get(threadId) || null;
  }

  function handoff(threadId, { channel, externalId }) {
    const cur = byThread.get(threadId);
    if (!cur) {
      const err = new Error(`THREAD_NOT_FOUND: ${threadId}`);
      err.code = 'THREAD_NOT_FOUND';
      throw err;
    }
    if (!channel || !externalId) {
      throw new Error('handoff requires channel and externalId');
    }
    const row = {
      op: 'upsert', threadId, channel, externalId,
      sessionId: cur.sessionId, lastTurnAt: Date.now(),
    };
    append(row);
    return byThread.get(threadId);
  }

  function list() {
    return Array.from(byThread.values());
  }

  return { upsert, findByExternal, findByThread, handoff, list };
}
