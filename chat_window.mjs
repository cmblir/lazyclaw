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
// conversation history lazyclaw actually holds — NOT a provider's self-reported
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
