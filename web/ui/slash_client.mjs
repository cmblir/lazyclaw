// web/ui/slash_client.mjs — the streaming half of the dashboard's slash
// runner.
//
// POST /slash always answers one JSON envelope. Asking with
// `Accept: text/event-stream` additionally gets a `line` event per line of
// output as it is produced — but only for commands in STREAMING
// (daemon/lib/slash_http.mjs) — so a long /loop run shows progress instead of
// looking hung until it finishes. The buffered runSlash() helper belongs to
// the NEXT task (its dashboard wiring); this file adds only runSlashStream,
// which is what task 5 needs to prove the server side end to end.
import { apiRaw } from './api.mjs';
import { makeParser } from './stream.mjs';

/**
 * Run a command that may take a while, delivering lines as they arrive.
 * Falls back to the buffered JSON result if the server did not upgrade
 * (e.g. the command isn't in STREAMING).
 */
export async function runSlashStream(line, { onLine, confirm } = {}) {
  const body = confirm ? { line, confirm } : { line };
  const res = await apiRaw('/slash', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!/text\/event-stream/.test(res.headers.get('content-type') || '')) return res.json();

  // Reuse the frame parser GET /events already relies on (web/ui/stream.mjs)
  // instead of a second hand-rolled SSE splitter — it already handles frames
  // split across chunk boundaries.
  let final = { ok: false, error: 'stream ended without a result', code: 'SLASH_ERR' };
  const feed = makeParser((type, data) => {
    if (type === 'line') onLine?.(data.text);
    else if (type === 'done') final = data;
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    feed(decoder.decode(value, { stream: true }));
  }
  return final;
}
