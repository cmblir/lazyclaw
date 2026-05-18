// Engine for `/loop` REPL command and `lazyclaw loop` detached subcommand.
//
// Repeats one prompt against the active provider up to N times, stopping
// early when (a) an `--until` regex matches the latest assistant turn, or
// (b) an external `AbortSignal` fires (Ctrl+C in the REPL, SIGTERM in the
// detached worker).
//
// Design constraints from spec:
//   - Default --max is 3, hard ceiling 50 (refuse otherwise — runaway guard)
//   - Per-iteration persistence: both the user and assistant turns must
//     reach the session jsonl. On abort mid-iteration only completed
//     pairs land — we defer the user-turn `persist` call until the
//     assistant turn succeeds so a Ctrl+C between them leaves no orphan.
//   - The engine is pure: callers inject `sendOnce` and `persist`. This
//     lets the REPL stream chunks to stdout while the detached worker
//     buffers silently and writes to its own iterations.log.

export const LOOP_MAX_CEILING = 50;
export const LOOP_MAX_DEFAULT = 3;

export class LoopError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LoopError';
    this.code = code || 'LOOP_ERR';
  }
}

// Lightweight tokenizer for the `/loop` argument tail. Honors double
// quotes so `/loop "say hi" --until "DONE"` produces three tokens. No
// escape sequences, no nested quotes — the spec doesn't require shell
// fidelity and adding it would just give the user more rope.
export function splitArgs(raw) {
  const out = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (inQuote) throw new LoopError('unterminated quoted argument', 'LOOP_BAD_QUOTE');
  if (buf) out.push(buf);
  return out;
}

export function parseLoopArgs(raw) {
  const argv = splitArgs(raw);
  let max = LOOP_MAX_DEFAULT;
  let until = null;
  let session = null;
  let detach = false;
  let useMemory = false;
  let recall = null;
  const promptParts = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--max') {
      const v = argv[++i];
      if (v === undefined) throw new LoopError('--max requires a value', 'LOOP_BAD_FLAG');
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        throw new LoopError(`--max must be a positive integer, got "${v}"`, 'LOOP_BAD_FLAG');
      }
      max = n;
    } else if (t === '--until') {
      const v = argv[++i];
      if (v === undefined) throw new LoopError('--until requires a regex', 'LOOP_BAD_FLAG');
      until = v;
    } else if (t === '--session') {
      const v = argv[++i];
      if (v === undefined) throw new LoopError('--session requires an id', 'LOOP_BAD_FLAG');
      session = v;
    } else if (t === '--detach') {
      detach = true;
    } else if (t === '--use-memory') {
      useMemory = true;
    } else if (t === '--recall') {
      const v = argv[++i];
      if (v === undefined) throw new LoopError('--recall requires a query', 'LOOP_BAD_FLAG');
      recall = v;
    } else if (t.startsWith('--')) {
      throw new LoopError(`unknown flag ${t}`, 'LOOP_BAD_FLAG');
    } else {
      promptParts.push(t);
    }
  }
  if (max > LOOP_MAX_CEILING) {
    throw new LoopError(
      `--max ${max} exceeds ceiling ${LOOP_MAX_CEILING} (runaway guard). Refusing.`,
      'LOOP_OVER_CEILING',
    );
  }
  return { prompt: promptParts.join(' '), max, until, session, detach, useMemory, recall };
}

export function compileUntil(pattern) {
  if (!pattern) return null;
  try { return new RegExp(pattern); }
  catch (e) { throw new LoopError(`bad --until regex: ${e?.message || e}`, 'LOOP_BAD_REGEX'); }
}

/**
 * Run one prompt N times. Mutates `messages` in place.
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {number} o.max
 * @param {RegExp|null} o.until
 * @param {Array<{role:string,content:string}>} o.messages
 * @param {(messages: any[], signal: AbortSignal|undefined) => Promise<string>} o.sendOnce
 * @param {((role: 'user'|'assistant', content: string) => void)|undefined} o.persist
 * @param {((evt: { i: number, max: number, reply: string }) => void)|undefined} o.onIteration
 * @param {AbortSignal|undefined} o.signal
 * @returns {Promise<{ iterations: number, stoppedBy: 'max'|'until'|'abort', lastReply: string }>}
 */
export async function runLoop({ prompt, max, until, messages, sendOnce, persist, onIteration, signal }) {
  if (!prompt || !prompt.trim()) {
    throw new LoopError('prompt is required', 'LOOP_NO_PROMPT');
  }
  if (!Number.isInteger(max) || max <= 0) {
    throw new LoopError('max must be a positive integer', 'LOOP_BAD_MAX');
  }
  if (max > LOOP_MAX_CEILING) {
    throw new LoopError(`max ${max} exceeds ceiling ${LOOP_MAX_CEILING}`, 'LOOP_OVER_CEILING');
  }
  if (typeof sendOnce !== 'function') {
    throw new LoopError('sendOnce is required', 'LOOP_NO_SENDER');
  }
  let i = 0;
  let lastReply = '';
  let stoppedBy = 'max';
  while (i < max) {
    if (signal?.aborted) { stoppedBy = 'abort'; break; }
    i++;
    messages.push({ role: 'user', content: prompt });
    let reply;
    try {
      reply = await sendOnce(messages, signal);
    } catch (err) {
      // Roll back the unpaired user turn so the in-memory messages stay
      // consistent. The persist() call hasn't happened yet for this
      // iteration, so the session jsonl is untouched.
      messages.pop();
      if (err?.code === 'ABORT' || signal?.aborted) {
        stoppedBy = 'abort';
        i--;
        break;
      }
      throw err;
    }
    lastReply = reply;
    persist?.('user', prompt);
    messages.push({ role: 'assistant', content: lastReply });
    persist?.('assistant', lastReply);
    onIteration?.({ i, max, reply: lastReply });
    if (until && until.test(lastReply)) {
      stoppedBy = 'until';
      break;
    }
  }
  return { iterations: i, stoppedBy, lastReply };
}
