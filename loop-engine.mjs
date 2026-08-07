// Engine for `/loop` REPL command and `pompos loop` detached subcommand.
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

// Evaluate the opt-in budget ceilings for an unattended loop/tick. Returns a
// stop reason ('budget' | 'timeout') when a ceiling is hit, else null. Pure +
// additive: callers that pass no `budget` never reach this, so default
// behavior is byte-stable.
//
//   budget = {
//     wallClockMs?: number,   // stop once now()-startedAt exceeds this
//     maxTokens?:   number,   // stop once accumulated tokens exceed this
//     maxCost?:     number,   // stop once accumulated cost exceeds this
//     killSwitch?:  () => boolean,        // global kill (env / config flag)
//     getUsage?:    () => { tokens?, cost? }, // caller-fed running totals
//     now?:         () => number,         // clock injection (tests)
//   }
export function checkBudget(budget, startedAt) {
  if (!budget) return null;
  if (typeof budget.killSwitch === 'function' && budget.killSwitch()) return 'budget';
  const now = typeof budget.now === 'function' ? budget.now() : Date.now();
  if (Number.isFinite(budget.wallClockMs) && budget.wallClockMs > 0 && now - startedAt >= budget.wallClockMs) {
    return 'timeout';
  }
  if ((Number.isFinite(budget.maxTokens) && budget.maxTokens > 0) ||
      (Number.isFinite(budget.maxCost) && budget.maxCost > 0)) {
    const u = (typeof budget.getUsage === 'function' ? budget.getUsage() : null) || {};
    if (Number.isFinite(budget.maxTokens) && budget.maxTokens > 0 && Number(u.tokens) >= budget.maxTokens) {
      return 'budget';
    }
    if (Number.isFinite(budget.maxCost) && budget.maxCost > 0 && Number(u.cost) >= budget.maxCost) {
      return 'budget';
    }
  }
  return null;
}

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
 * @param {object|undefined} o.budget  opt-in wall-clock/token/cost ceilings + kill-switch (see checkBudget)
 * @returns {Promise<{ iterations: number, stoppedBy: 'max'|'until'|'abort'|'budget'|'timeout', lastReply: string }>}
 */
export async function runLoop({ prompt, max, until, messages, sendOnce, persist, onIteration, signal, buildSystem, budget }) {
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
  // Anchor the wall-clock budget at loop start. A budget-injected now() lets
  // tests advance a virtual clock without real sleeps.
  const budgetStart = budget && typeof budget.now === 'function' ? budget.now() : Date.now();
  while (i < max) {
    if (signal?.aborted) { stoppedBy = 'abort'; break; }
    // Budget gate BEFORE spending a turn — a tiny wall-clock/token/cost cap
    // (or the global kill-switch) stops the loop before the next paid call.
    const preStop = checkBudget(budget, budgetStart);
    if (preStop) { stoppedBy = preStop; break; }
    i++;
    // Per-iteration system rebuild. The caller decides what `sys` is —
    // memory.loadCore(), recall results, the chat's prior skill block,
    // or any combination. Empty / falsy return = remove the system
    // message. The rebuild runs every iteration so a parallel writer
    // mutating core.md mid-loop is reflected in the next call.
    if (buildSystem) {
      const sys = buildSystem();
      const sysIdx = messages.findIndex(m => m.role === 'system');
      if (sys && String(sys).trim()) {
        if (sysIdx >= 0) messages[sysIdx] = { role: 'system', content: sys };
        else messages.unshift({ role: 'system', content: sys });
      } else if (sysIdx >= 0) {
        messages.splice(sysIdx, 1);
      }
    }
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
    // Post-iteration budget gate: usage the turn just consumed (tokens/cost)
    // is now visible via getUsage(), so a ceiling crossed mid-run stops the
    // loop instead of running one more paid iteration.
    const postStop = checkBudget(budget, budgetStart);
    if (postStop) { stoppedBy = postStop; break; }
  }
  return { iterations: i, stoppedBy, lastReply };
}
