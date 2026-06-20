// GET /events — Server-Sent Events stream of live agent activity for the
// dashboard's Team view. On connect we replay the recent ring buffer (so a
// freshly-opened dashboard converges to current state), then stream every
// subsequent event. Auth is enforced by the daemon's pre-dispatch gate, so the
// handler can assume the request is authorized.
//
// The handler keeps the connection open; it cleans up its subscription +
// heartbeat when the client disconnects (req 'aborted' / res 'close').

import { writeSseHead, writeSse } from '../lib/respond.mjs';
import { subscribe, recent } from '../../mas/events.mjs';

const HEARTBEAT_MS = 25_000;

export function events(c) {
  const { req, res } = c;
  writeSseHead(res);

  // Replay buffered events. The dashboard dedupes by `seq`, so a full replay on
  // (re)connect is safe and lets a late subscriber catch up.
  for (const evt of recent()) {
    try { writeSse(res, evt.type, evt); } catch { /* client already gone */ }
  }

  const unsub = subscribe((evt) => {
    try { writeSse(res, evt.type, evt); } catch { /* client gone — cleanup below */ }
  });

  // Comment heartbeat so intermediaries don't drop an idle stream.
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { /* gone */ }
  }, HEARTBEAT_MS);
  if (typeof hb.unref === 'function') hb.unref();

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    unsub();
    if (!res.writableEnded) { try { res.end(); } catch { /* already ended */ } }
  };
  req.on('aborted', cleanup);
  res.on('close', cleanup);
}
