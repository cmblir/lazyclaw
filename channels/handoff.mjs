// channels/handoff.mjs
//
// Migrates an active thread (sessionId) from one channel to another.
// Pure function over (threads store, live channel map) — the CLI slash
// and the daemon HTTP route both call this.

export async function runHandoff({ threads, channels, threadId, target, externalId, note = '' }) {
  const cur = threads.findByThread(threadId);
  if (!cur) {
    const err = new Error(`THREAD_NOT_FOUND: ${threadId}`);
    err.code = 'THREAD_NOT_FOUND';
    throw err;
  }
  if (!channels[target] || typeof channels[target].send !== 'function') {
    const err = new Error(`CHANNEL_NOT_AVAILABLE: ${target}`);
    err.code = 'CHANNEL_NOT_AVAILABLE';
    throw err;
  }
  const srcChannel = cur.channel;
  const srcExternal = cur.externalId;

  // 1. Persist the migration first so a crash mid-notify leaves us in the new home.
  const next = threads.handoff(threadId, { channel: target, externalId });

  // 2. Notify source (best-effort) so the human knows where the convo went.
  const tail = note ? ` — ${note}` : '';
  if (channels[srcChannel] && typeof channels[srcChannel].send === 'function') {
    try {
      await channels[srcChannel].send(srcExternal,
        `handoff: this conversation moved to ${target}${tail}`);
    } catch (e) {
      process.stderr.write(`[handoff] source notify failed: ${e.message}\n`);
    }
  }

  // 3. Notify target with a resume marker.
  await channels[target].send(externalId,
    `resumed from ${srcChannel} (session ${next.sessionId})${tail}`);

  return next;
}

// F6 — re-point a thread to `target`/`externalId` and (optionally) notify the
// target, rolling the binding BACK to its source if that notification throws.
// Unlike runHandoff, this takes a single `send(externalId, text)` notifier
// instead of a live channel map, so the daemon HTTP route can use it without a
// per-platform SDK. When `send` is omitted (the daemon has no live channel map
// yet) the migration is simply persisted and context follows on the next
// inbound to the target — there is nothing to roll back. Preserves sessionId.
export async function handoffWithRollback({ threads, threadId, target, externalId, note = '', send }) {
  const cur = threads.findByThread(threadId);
  if (!cur) {
    const err = new Error(`THREAD_NOT_FOUND: ${threadId}`);
    err.code = 'THREAD_NOT_FOUND';
    throw err;
  }
  if (!target || !externalId) {
    throw new Error('handoff requires target and externalId');
  }
  const prior = { channel: cur.channel, externalId: cur.externalId };
  // Persist the migration first (same ordering as runHandoff).
  const next = threads.handoff(threadId, { channel: target, externalId: String(externalId) });
  if (typeof send === 'function') {
    try {
      const tail = note ? ` — ${note}` : '';
      await send(String(externalId), `resumed from ${prior.channel} (session ${next.sessionId})${tail}`);
    } catch (e) {
      // Target never got the resume marker — roll the binding back so the
      // session isn't stranded on a channel that can't be reached.
      threads.handoff(threadId, prior);
      const err = new Error(`HANDOFF_SEND_FAILED: ${e?.message || e}`);
      err.code = 'HANDOFF_SEND_FAILED';
      throw err;
    }
  }
  return next;
}
