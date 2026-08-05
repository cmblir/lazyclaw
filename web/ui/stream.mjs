// web/ui/stream.mjs — one app-level subscription to GET /events.
//
// Read with fetch, not EventSource: EventSource cannot set an Authorization
// header, and the daemon's data routes are token-gated. The frame format is
// plain SSE — records separated by a blank line, `event:` and `data:` lines
// inside — so the parser is pure and unit-tested separately from the socket.
import { apiRaw } from './api.mjs';

/**
 * Build a chunk feeder. Buffers across chunk boundaries and emits one
 * (type, data) per complete frame. A frame whose data is not JSON is skipped:
 * one bad record must never stop the stream.
 */
export function makeParser(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let type = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;                       // comment heartbeat or empty frame
      try { onEvent(type, JSON.parse(data)); } catch { /* skip a bad frame */ }
    }
  };
}

const subs = new Set();
let running = false;

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function fanOut(type, data) {
  for (const fn of subs) {
    try { fn(type, data); } catch { /* a bad subscriber must not break the stream */ }
  }
}

// Reflects the socket's state in the topbar. There is no module-level mirror of
// it: connectionState() was the only reader and went with the dead-code sweep,
// so keeping a variable nothing reads would just be a second source of truth.
function setState(next) {
  const node = document.getElementById('daemon-state');
  if (node) node.textContent = next === 'live' ? 'live' : next === 'retrying' ? 'reconnecting…' : 'connecting…';
}

/**
 * Connect and keep connected. Idempotent — a second call while a reader is
 * alive is a no-op. On a drop, retry with exponential backoff (1s doubling to
 * 30s) instead of stopping at "disconnected" the way the old Team Live reader
 * did.
 */
export function connect() {
  if (running) return;
  running = true;
  let delay = 1000;

  (async () => {
    const feed = makeParser(fanOut);
    for (;;) {
      try {
        setState('connecting');
        const r = await apiRaw('/events', {});
        if (!r.ok || !r.body) throw new Error('events unavailable: HTTP ' + r.status);
        setState('live');
        delay = 1000;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          feed(dec.decode(value, { stream: true }));
        }
      } catch (_) {
        // Fall through to the backoff below; the reason is not actionable for
        // the user beyond "reconnecting".
      }
      setState('retrying');
      await new Promise((res) => setTimeout(res, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  })();
}
