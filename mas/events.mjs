// mas/events.mjs — tiny in-process event bus for live agent activity.
//
// Zero-dependency pub/sub plus a bounded ring buffer for replay-on-connect.
// The daemon's GET /events SSE route subscribes here and streams events to the
// dashboard; mention_router / agent_turn / delegation emit as agents work.
//
// emit() NEVER throws into the caller: an agent turn must not break because a
// dashboard subscriber errored or because the bus is busy. Events are
// process-local — in the always-on gateway/daemon (where Slack-routed tasks run
// and SSE clients connect) they reach the dashboard; in a one-shot CLI process
// with no subscriber they are simply buffered and dropped, which is harmless.

const RING_MAX = 200;
const _subs = new Set();
const _ring = [];
let _seq = 0;

/**
 * Publish an event. Returns the stamped event ({seq, ts, type, ...payload}).
 * @param {string} type  e.g. 'turn.start' | 'tool.call' | 'delegate'
 * @param {object} [payload]
 */
export function emit(type, payload = {}) {
  const evt = { seq: ++_seq, ts: Date.now(), type, ...payload };
  _ring.push(evt);
  if (_ring.length > RING_MAX) _ring.shift();
  for (const fn of _subs) {
    try { fn(evt); } catch { /* a bad subscriber must never break emit */ }
  }
  return evt;
}

/**
 * Subscribe to every subsequent event. Returns an unsubscribe function.
 * @param {(evt: object) => void} fn
 * @returns {() => void}
 */
export function subscribe(fn) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

/**
 * Replay buffered events, optionally only those newer than `sinceSeq`. Used by
 * the SSE route so a freshly-connected dashboard converges to current state.
 * @param {number} [sinceSeq]
 */
export function recent(sinceSeq = 0) {
  return sinceSeq ? _ring.filter((e) => e.seq > sinceSeq) : _ring.slice();
}

/** Test seam — clear subscribers + buffer + sequence. */
export function _reset() {
  _subs.clear();
  _ring.length = 0;
  _seq = 0;
}
