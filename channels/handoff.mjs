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
