// Google Gemini (Generative Language API) streaming provider.
//
// Wire format:
//   POST https://generativelanguage.googleapis.com/v1/models/{model}:streamGenerateContent?alt=sse&key={apiKey}
//   { "contents": [...], "systemInstruction"?: {...} }
//
// Auth quirk: Gemini takes `?key=...` in the query string rather than a
// header. We still accept opts.apiKey via the same shape as the other
// providers and append it to the URL ourselves so callers don't have to
// remember the difference.
//
// Streaming format with `alt=sse`: standard SSE — `data: <json>\n\n` per
// chunk. Each JSON payload contains
// `candidates[0].content.parts[0].text` for text deltas. There's no
// terminator like `[DONE]`; the stream simply ends.
//
// Test seam: opts.fetch overrides globalThis.fetch.

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1';

class InvalidApiKeyError extends Error {
  constructor(message = 'invalid api key') {
    super(message);
    this.name = 'InvalidApiKeyError';
    this.code = 'INVALID_KEY';
  }
}
class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT';
  }
}
class RateLimitError extends Error {
  constructor(retryAfterMs, body = '') {
    super(`gemini api 429: rate limited (retry-after ${retryAfterMs}ms)`);
    this.name = 'RateLimitError';
    this.code = 'RATE_LIMIT';
    this.status = 429;
    this.retryAfterMs = retryAfterMs;
    this.body = body;
  }
}
class ApiError extends Error {
  constructor(status, body) {
    super(`gemini api ${status}: ${String(body).slice(0, 200)}`);
    this.name = 'GeminiApiError';
    this.status = status;
    this.body = body;
  }
}
class TimeoutError extends Error {
  constructor(idleMs) {
    super(`gemini: idle timeout — no stream activity for ${idleMs}ms`);
    this.name = 'TimeoutError';
    this.code = 'TIMEOUT';
    this.idleMs = idleMs;
  }
}

const DEFAULT_IDLE_TIMEOUT_MS = 120000;

// Resolve the IDLE (inter-chunk) timeout once per request: opts override
// wins, then env LAZYCLAW_REQUEST_TIMEOUT_MS (positive int), else 120s.
function resolveIdleTimeoutMs(opts) {
  if (Number.isFinite(opts?.idleTimeoutMs) && opts.idleTimeoutMs > 0) return opts.idleTimeoutMs;
  const raw = parseInt(process.env.LAZYCLAW_REQUEST_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_IDLE_TIMEOUT_MS;
}

// Wrap a chunk iterator with an IDLE timeout: abort only when NO chunk has
// arrived for idleMs (the timer resets on every received chunk, and also
// guards the connect/first-byte phase). This is NOT a total-duration cap,
// so a long but healthy generation that streams steadily is never aborted.
// `controller` is aborted on idle expiry so the real connection tears down.
async function* iterateWithIdleTimeout(body, idleMs, controller) {
  const iterator = iterateBody(body)[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer;
      const idle = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TimeoutError(idleMs));
        }, idleMs);
      });
      let step;
      try {
        step = await Promise.race([iterator.next(), idle]);
      } finally {
        clearTimeout(timer);
      }
      if (step.done) return;
      yield step.value;
    }
  } finally {
    // Best-effort, NON-awaited cleanup: on idle abort the underlying reader
    // may be suspended on a read that never settles, so awaiting return()
    // would re-hang us. The controller abort already tears down the socket.
    if (typeof iterator.return === 'function') {
      try { Promise.resolve(iterator.return()).catch(() => {}); } catch { /* ignore */ }
    }
  }
}

function parseRetryAfterMs(headers) {
  let raw = null;
  if (headers && typeof headers.get === 'function') raw = headers.get('retry-after') || headers.get('Retry-After');
  else if (headers) raw = headers['retry-after'] || headers['Retry-After'];
  if (!raw) return 1000;
  const asInt = parseInt(String(raw), 10);
  if (!Number.isNaN(asInt)) return Math.max(0, asInt * 1000);
  const date = Date.parse(String(raw));
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 1000;
}

async function* iterateBody(body) {
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
    return;
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield chunk;
    return;
  }
  if (typeof body === 'string') { yield new TextEncoder().encode(body); return; }
  if (body instanceof Uint8Array) { yield body; return; }
  throw new Error('gemini: response body is not iterable');
}

function* parseSseFrames(buffer) {
  let cursor = 0;
  while (true) {
    const sep = buffer.indexOf('\n\n', cursor);
    if (sep < 0) break;
    const frame = buffer.slice(cursor, sep);
    cursor = sep + 2;
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    yield { data: dataLines.join('\n'), nextCursor: cursor };
  }
}

// Translate the canonical {role:user|assistant|system, content:string}
// message shape to Gemini's contents+systemInstruction shape.
//   - assistant → "model" (Gemini's name for it)
//   - system → bubbled up to systemInstruction (most recent wins on conflict)
function toGeminiBody(messages, opts) {
  const contents = [];
  let systemText = opts.system || null;
  for (const m of messages) {
    if (m.role === 'system') {
      systemText = String(m.content ?? '');
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content ?? '') }],
    });
  }
  const body = { contents };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  return body;
}

export const geminiProvider = {
  name: 'gemini',
  /**
   * @param {Array<{role:string,content:string}>} messages
   * @param {{ apiKey?:string, model?:string, baseUrl?:string, fetch?:typeof fetch, signal?:AbortSignal, system?:string }} opts
   */
  async *sendMessage(messages, opts = {}) {
    if (!opts.apiKey) throw new InvalidApiKeyError('missing api key');
    const fetchFn = opts.fetch || globalThis.fetch;
    if (!fetchFn) throw new Error('gemini: no fetch implementation available');
    const baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
    const model = opts.model || 'gemini-2.5-pro';

    if (opts.signal?.aborted) throw new AbortError('aborted before request');

    // Compose the caller's signal with an internal controller that the idle
    // timeout aborts. The composed signal goes to fetch so a stalled
    // connection (or a user cancel) tears down the real socket.
    const idleMs = resolveIdleTimeoutMs(opts);
    const idleController = new AbortController();
    const fetchSignal = opts.signal
      ? (typeof AbortSignal.any === 'function'
          ? AbortSignal.any([opts.signal, idleController.signal])
          : idleController.signal)
      : idleController.signal;
    const forwardCallerAbort = () => idleController.abort();
    if (opts.signal && typeof AbortSignal.any !== 'function') {
      opts.signal.addEventListener('abort', forwardCallerAbort, { once: true });
    }

    const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(opts.apiKey)}`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toGeminiBody(messages, opts)),
      signal: fetchSignal,
    });

    if (!res.ok) {
      const text = typeof res.text === 'function' ? await res.text() : '';
      if (res.status === 401 || res.status === 403) throw new InvalidApiKeyError(text || 'unauthorized');
      if (res.status === 429) throw new RateLimitError(parseRetryAfterMs(res.headers), text || '');
      throw new ApiError(res.status, text || '');
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    let buffer = '';
    try {
    for await (const chunk of iterateWithIdleTimeout(res.body, idleMs, idleController)) {
      // A user cancel surfaces as an idle-controller abort too; map it back
      // to ABORT so it stays distinguishable from a TIMEOUT.
      if (opts.signal?.aborted) throw new AbortError('aborted mid-stream');
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let consumed = 0;
      for (const frame of parseSseFrames(buffer)) {
        consumed = frame.nextCursor;
        if (!frame.data) continue;
        try {
          const obj = JSON.parse(frame.data);
          // Gemini may stream multiple parts; concatenate any text fields
          // we recognize. The path is candidates[0].content.parts[*].text.
          const parts = obj?.candidates?.[0]?.content?.parts;
          if (Array.isArray(parts)) {
            for (const p of parts) {
              if (typeof p?.text === 'string' && p.text) yield p.text;
            }
          }
          // Some error responses surface mid-stream as {error: {...}}.
          if (obj?.error) {
            const message = obj.error.message || JSON.stringify(obj.error);
            throw new ApiError(obj.error.code || 500, message);
          }
        } catch (err) {
          if (err instanceof ApiError) throw err;
          // malformed frame — skip and keep streaming
        }
      }
      if (consumed > 0) buffer = buffer.slice(consumed);
    }
    } finally {
      if (opts.signal && typeof AbortSignal.any !== 'function') {
        opts.signal.removeEventListener('abort', forwardCallerAbort);
      }
    }
  },
};

export { InvalidApiKeyError, ApiError, AbortError, RateLimitError };
