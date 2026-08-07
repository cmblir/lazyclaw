// Group B / M6 — chat sliding window helper.
//
// A multi-day chat session accumulates hundreds of turns; without a
// cap the prompt grows linearly and the Anthropic prompt cache
// breakpoint advances past the useful prefix. The window keeps the
// last N turns (default 20) AND honours a token budget (default ~8K
// chars-as-tokens, since `inputTokens` from the model isn't available
// pre-call). The system message at index 0 is always preserved — it's
// the agent.role + workspace + skills index that the static cache
// prefix depends on.
//
// Env overrides let operators stretch the window for long-running
// research sessions without recompiling. Lives in its own file so it
// can be imported by tests without invoking cli.mjs::main().

export const CHAT_WINDOW_TURNS = Number(process.env.LAZYCLAW_CHAT_WINDOW_TURNS) || 20;
export const CHAT_WINDOW_TOKEN_BUDGET = Number(process.env.LAZYCLAW_CHAT_WINDOW_TOKENS) || 8000;

// Approximate token count of a messages[] array (4 chars/token, same heuristic
// the window cap uses). Drives the status-bar context gauge so it reflects the
// conversation history pompos actually holds — NOT a provider's self-reported
// usage, which for CLI providers (codex/claude/gemini) includes their own
// system prompt + tool defs per call and has nothing to do with this budget.
export function estimateMessagesTokens(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  return Math.ceil(arr.reduce((n, m) => n + String(m?.content || '').length, 0) / 4);
}

// Trim a hydrated messages[] array to fit the sliding window. Returns
// { messages, dropped } so the caller can log a one-shot "dropped N
// older turns" line at session start. The first message is preserved
// when its role is 'system' (cacheable static prefix). Token budget
// is approximated as 4 chars/token — accurate enough for a soft cap
// when the goal is "don't pay for messages the model won't use".
export function applyChatWindow(messages, { turns = CHAT_WINDOW_TURNS, tokens = CHAT_WINDOW_TOKEN_BUDGET } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, dropped: 0 };
  const out = [...messages];
  const sys = out[0]?.role === 'system' ? out.shift() : null;
  const before = out.length;
  // Turn count cap: drop oldest non-system turns until length ≤ turns.
  while (out.length > turns) out.shift();
  // Token budget cap: estimate 4 chars / token, then trim from the
  // front (oldest) until estimated tokens ≤ budget.
  while (out.length > 1 && estimateMessagesTokens(out) > tokens) out.shift();
  const dropped = before - out.length;
  if (sys) out.unshift(sys);
  return { messages: out, dropped };
}

// Phase 1 (compaction-budget). Cheap-first, layered, $0, deterministic context
// compaction for the AGENT tool-use loop (mas/agent_turn.mjs), where the
// transcript carries provider-shaped tool-use/tool_result blocks rather than the
// plain {role,content:string} chat turns applyChatWindow handles. It never calls
// a model — the estimator is the same 4-chars/token heuristic as the rest of
// this file. Two layers, applied in order:
//
//   Layer 1 — cap oversized tool RESULT blocks. Tool outputs (a file read, a
//     fetched page, an sql dump) are the single biggest context hog. Each result
//     block longer than `toolResultMaxChars` is truncated with a clear elision
//     marker so the model still sees the head of the output and knows the rest
//     was cut. Recognises both provider shapes:
//       - Anthropic: { role:'user', content:[{ type:'tool_result', content }] }
//       - OpenAI:    { role:'tool', content:'<string>' }
//
//   Layer 2 — when the transcript STILL exceeds `maxTokens`, drop the OLDEST
//     turns, keeping the leading system message plus the most-recent
//     `keepRecentTurns` turns verbatim, and splice in one synthetic
//     "[...N earlier turns elided...]" note in their place.
//
// A pluggable LLM-summary layer (summarise the elided span instead of dropping
// it) is deliberately a NO-OP stub for now: `summarizeElided` defaults to a
// function that returns the count-only note, so the hot path never makes a
// provider call. A caller may pass their own async-free summariser later.
//
// Returns { messages, elidedTurns, truncatedResults } and NEVER mutates the
// input array (deep-copies only the blocks it rewrites).

export const COMPACT_TOOL_RESULT_MAX_CHARS = Number(process.env.LAZYCLAW_COMPACT_TOOL_RESULT_CHARS) || 8000;
export const COMPACT_KEEP_RECENT_TURNS = Number(process.env.LAZYCLAW_COMPACT_KEEP_TURNS) || 8;

// Truncate a string result body, leaving a marker that names how much was cut.
function _elideText(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return { text: s, cut: false };
  const head = s.slice(0, maxChars);
  const removed = s.length - maxChars;
  return { text: `${head}\n\n[...tool result truncated: ${removed} chars elided...]`, cut: true };
}

// Default (no-op) summary layer: produce the count-only elision note. Kept as a
// seam so a future LLM-summary layer can be dropped in without touching callers.
function _defaultSummarizeElided(elidedTurns) {
  return `[...${elidedTurns} earlier turns elided...]`;
}

export function compactMessages(messages, {
  maxTokens,
  toolResultMaxChars = COMPACT_TOOL_RESULT_MAX_CHARS,
  keepRecentTurns = COMPACT_KEEP_RECENT_TURNS,
  summarizeElided = _defaultSummarizeElided,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, elidedTurns: 0, truncatedResults: 0 };
  }

  // Layer 1 — copy the array, rewriting only oversized tool_result blocks.
  let truncatedResults = 0;
  const layer1 = messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    // OpenAI shape: role:'tool' with a string content body.
    if (m.role === 'tool' && typeof m.content === 'string') {
      const { text, cut } = _elideText(m.content, toolResultMaxChars);
      if (!cut) return m;
      truncatedResults++;
      return { ...m, content: text };
    }
    // Anthropic shape: content is an array that may hold tool_result blocks.
    if (Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result')) {
      let touched = false;
      const content = m.content.map((b) => {
        if (!b || b.type !== 'tool_result') return b;
        const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        const { text, cut } = _elideText(body, toolResultMaxChars);
        if (!cut) return b;
        touched = true;
        truncatedResults++;
        return { ...b, content: text };
      });
      return touched ? { ...m, content } : m;
    }
    return m;
  });

  // Layer 2 — only when a finite budget is set AND we're still over it.
  const budget = Number.isFinite(maxTokens) ? maxTokens : Infinity;
  if (budget === Infinity || estimateMessagesTokens(layer1) <= budget) {
    return { messages: layer1, elidedTurns: 0, truncatedResults };
  }

  const sys = layer1[0]?.role === 'system' ? layer1[0] : null;
  const bodyStart = sys ? 1 : 0;
  const body = layer1.slice(bodyStart);

  // Drop oldest body turns until either the budget fits or only the most-recent
  // keepRecentTurns remain. The recent tail is always kept verbatim.
  let elidedTurns = 0;
  const kept = [...body];
  while (kept.length > keepRecentTurns) {
    const trial = sys ? [sys, ...kept.slice(1)] : kept.slice(1);
    if (estimateMessagesTokens(trial) <= budget) break;
    kept.shift();
    elidedTurns++;
  }

  if (elidedTurns === 0) {
    return { messages: layer1, elidedTurns: 0, truncatedResults };
  }

  const note = { role: 'user', content: summarizeElided(elidedTurns) };
  const out = sys ? [sys, note, ...kept] : [note, ...kept];
  return { messages: out, elidedTurns, truncatedResults };
}
