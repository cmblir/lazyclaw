// web/ui/slash_client.mjs — the browser half of the dashboard's single
// write path.
//
// POST /slash always answers one JSON envelope: {ok:true, lines, data?} on
// success, {ok:false, error, code} on failure, where code is one of
// SLASH_ERR, CONFIRM_REQUIRED (+prompt, +token), NO_SESSION, NEEDS_TERMINAL
// (+hint), CONFIG_DIR_MISMATCH, PERSIST_FAILED — or an unrecognised future
// code, which callers must still be able to see. Asking with
// `Accept: text/event-stream` additionally gets a `line` event per line of
// output as it is produced — but only for commands in STREAMING
// (daemon/lib/slash_http.mjs) — so a long /loop run shows progress instead of
// looking hung until it finishes. runSlashStream is what task 5 needed to
// prove the server side end to end; runSlash and fetchCommands are the
// buffered dashboard wiring the confirm dialog and the panels call through.
import { api, apiRaw } from './api.mjs';
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

/**
 * Run a slash command and wait for the buffered result.
 *
 * Every mutating action in the dashboard funnels through this — composing
 * the exact line a user would type in the REPL — so panels never build a
 * second grammar, and there is no second endpoint to keep in step.
 *
 * Returns the envelope for EVERY outcome, including a 409 confirmation:
 * `api()` throws on non-2xx, but a confirmation is a normal answer the
 * caller has to act on (the confirm dialog retries with the returned
 * token), not an exception — so this goes through apiRaw instead. A network
 * failure or a response body that isn't JSON is just another way the call
 * didn't succeed, and is folded into the same {ok:false, code:'SLASH_ERR'}
 * shape rather than thrown, so callers only ever branch on the envelope.
 * Any other body — including a future `code` this client doesn't know about
 * yet — is passed through unchanged: normalising it here would be exactly
 * the kind of caller being told something different from what the daemon
 * said that this endpoint exists to avoid.
 *
 * @param {string} line e.g. '/team remove crew'
 * @param {{confirm?: string}} [opts]
 * @returns {Promise<{ok: boolean, lines?: string[], data?: unknown, error?: string, code?: string, prompt?: string, token?: string, hint?: string}>}
 */
export async function runSlash(line, { confirm } = {}) {
  const body = confirm ? { line, confirm } : { line };
  try {
    const res = await apiRaw('/slash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: 'SLASH_ERR' };
  }
}

/** The command list the dashboard's autocomplete reads. */
export async function fetchCommands() {
  return api('/slash/commands');
}
