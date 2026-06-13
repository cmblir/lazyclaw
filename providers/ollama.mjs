// Ollama local-model streaming provider.
//
// Endpoint: POST {baseUrl}/api/chat (default baseUrl http://127.0.0.1:11434)
// Body: { model, messages: [{role, content}], stream: true }
// Response: newline-delimited JSON, one object per chunk:
//   {"message":{"role":"assistant","content":"hi"},"done":false}
//   {"done":true,"prompt_eval_count":N,"eval_count":N,...}
//
// Differences from anthropic/openai:
//   - No auth; opts.apiKey is ignored. We still accept it so the registry
//     `providers list` shape stays uniform.
//   - opts.baseUrl overrides the default endpoint (env OLLAMA_HOST also
//     respected so a single env var aligns this with the dashboard).
//   - opts.fetch test seam mirrors the other providers.
//
// Tools / thinking are not part of Ollama's chat API; we silently drop
// those opts rather than 400-ing so callers can swap providers without
// changing surrounding code.

const DEFAULT_BASE = 'http://127.0.0.1:11434';

class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT';
  }
}

class ApiError extends Error {
  constructor(status, body) {
    super(`ollama api ${status}: ${String(body).slice(0, 200)}`);
    this.name = 'OllamaApiError';
    this.status = status;
    this.body = body;
  }
}

class ConnectionError extends Error {
  constructor(baseUrl, cause) {
    super(`ollama: cannot reach ${baseUrl} (is the daemon running?)`);
    this.name = 'OllamaConnectionError';
    this.code = 'CONNECTION_REFUSED';
    this.cause = cause;
  }
}

class TimeoutError extends Error {
  constructor(idleMs) {
    super(`ollama: idle timeout — no stream activity for ${idleMs}ms`);
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
  throw new Error('ollama: response body is not iterable');
}

export const ollamaProvider = {
  name: 'ollama',
  /**
   * @param {Array<{role:string,content:string}>} messages
   * @param {{ model?:string, baseUrl?:string, fetch?:typeof fetch, signal?:AbortSignal, system?:string }} opts
   */
  async *sendMessage(messages, opts = {}) {
    const fetchFn = opts.fetch || globalThis.fetch;
    if (!fetchFn) throw new Error('ollama: no fetch implementation available');
    const baseUrl = (opts.baseUrl || process.env.OLLAMA_HOST || DEFAULT_BASE).replace(/\/$/, '');
    const model = opts.model || 'llama3.1';

    const apiMessages = [];
    const sys = opts.system || messages.find(m => m.role === 'system')?.content;
    if (sys) apiMessages.push({ role: 'system', content: String(sys) });
    for (const m of messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        apiMessages.push({ role: m.role, content: String(m.content ?? '') });
      }
    }

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

    let res;
    try {
      res = await fetchFn(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: apiMessages, stream: true }),
        signal: fetchSignal,
      });
    } catch (err) {
      // Distinguish "ollama isn't running" from generic network errors so
      // callers can show a useful prompt ("brew services start ollama")
      // instead of a confusing fetch trace.
      if (err && (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed/i.test(String(err.message)))) {
        throw new ConnectionError(baseUrl, err);
      }
      throw err;
    }

    if (!res.ok) {
      const text = typeof res.text === 'function' ? await res.text() : '';
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
      // Ollama is newline-delimited JSON, not SSE — split on '\n', parse
      // each non-empty line, leave trailing partial behind for the next read.
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.message?.content) yield obj.message.content;
          if (obj?.done) return;
          if (obj?.error) throw new ApiError(500, obj.error);
        } catch (err) {
          if (err instanceof ApiError) throw err;
          // malformed line — skip and keep streaming
        }
      }
    }
    } finally {
      if (opts.signal && typeof AbortSignal.any !== 'function') {
        opts.signal.removeEventListener('abort', forwardCallerAbort);
      }
    }
    // Any trailing bytes the decoder still holds onto get flushed and
    // parsed once. Empty after a clean stream.
    const tail = decoder.decode();
    if (tail.trim()) {
      try {
        const obj = JSON.parse(tail);
        if (obj?.message?.content) yield obj.message.content;
      } catch { /* malformed tail — drop */ }
    }
  },
};

export { ApiError, AbortError, ConnectionError };
