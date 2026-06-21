// HTTP request/response helpers for the daemon: body readers, JSON/SSE
// writers, provider-error status mapping, and a small fs existence check.
// Pure — no daemon state — so any route module can import these freely.

import fs from 'node:fs';

export async function fileExists(p) {
  try { await fs.promises.access(p); return true; }
  catch { return false; }
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', d => { buf += d; if (buf.length > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(new Error(`invalid JSON body: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

// Raw body reader — used for `PUT /skills/<name>` where the body is
// markdown rather than JSON. Same 1 MiB cap as the CLI's `--from-url`
// path so HTTP can't sneak past the safeguard the CLI enforces.
export const SKILL_MAX_BYTES = 1_048_576;
export function readTextBody(req, maxBytes = SKILL_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', d => {
      buf += d;
      if (buf.length > maxBytes) {
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        req.destroy();
      }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

export function writeJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

// Map provider error codes to HTTP statuses so clients can branch on
// res.status instead of parsing error messages. Returns
// { status, headers? } so 429 can attach a Retry-After.
//
// Exported for unit testing without spinning up an actual provider that
// would only fail under live network conditions.
export function statusForProviderError(err) {
  if (err?.code === 'INVALID_KEY') return { status: 401 };
  if (err?.code === 'RATE_LIMIT') {
    const retrySeconds = Math.max(1, Math.ceil((err.retryAfterMs || 1000) / 1000));
    return { status: 429, headers: { 'retry-after': String(retrySeconds) } };
  }
  if (err?.status && err.status >= 400 && err.status < 600) return { status: err.status };
  return { status: 502 };
}

export function writeSseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'close',
  });
}

// Returns the data-frame res.write() result: false when the socket's write
// buffer is full (backpressure), true otherwise. Streaming loops use this to
// yield the event loop ONLY when the buffer is full, instead of paying an
// event-loop turn on every token.
export function writeSse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  return res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Opt-in wall-clock cap for a streaming response. The provider's per-chunk
// idle timeout can't bound a model that streams steadily for minutes, so a
// caller can abort the whole turn after `maxMs`. Aborting `ac` stops the
// provider; the loop then breaks and the caller can tell the client it was
// truncated (vs a client disconnect) via hit(). No-op when maxMs is unset/<=0.
// The timer is unref'd so it never keeps the process alive.
export function armStreamDeadline(ac, maxMs) {
  const ms = Number(maxMs) || 0;
  if (ms <= 0) return { disarm: () => {}, hit: () => false };
  let fired = false;
  const t = setTimeout(() => { fired = true; try { ac.abort(); } catch { /* already done */ } }, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return { disarm: () => clearTimeout(t), hit: () => fired };
}
