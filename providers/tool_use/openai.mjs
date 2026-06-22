// OpenAI tool-use adapter.
//
// Calls POST /v1/chat/completions non-streaming and normalises the
// response into the same envelope shape Anthropic's adapter uses:
//   { kind: 'final',      text }
//   { kind: 'tool_calls', text?, calls, assistantContent }
//
// Wire-level differences vs Anthropic that this module hides:
//   - `function.arguments` is a JSON STRING; we parse it.
//   - `content` on the assistant message can be null when tool_calls is
//     present; downstream code receives `text: ''` in that case.
//   - Each tool result becomes its own message with role='tool' and the
//     `tool_call_id` field — so `toolResultMessages()` returns N
//     entries (vs Anthropic's single user-message wrapper).
//
// Docs: https://platform.openai.com/docs/guides/function-calling

const DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_MAX_TOKENS = 4096;

// OpenAI o-series reasoning models (o1/o3/o4...) reject `max_tokens` with
// HTTP 400 'Unsupported parameter: max_tokens, use max_completion_tokens'.
function isReasoningModel(model) {
  return /^o\d/i.test(String(model || ''));
}

export class OpenAIToolUseError extends Error {
  constructor(message, code, body) {
    super(message);
    this.name = 'OpenAIToolUseError';
    this.code = code || 'OPENAI_ERR';
    if (body) this.body = body;
  }
}

export function toOpenAITools(schemas) {
  return (schemas || []).map((s) => ({
    type: 'function',
    function: {
      name: s.name,
      description: s.description,
      parameters: s.parameters,
    },
  }));
}

export async function callOnce({
  messages,
  tools = [],
  model,
  apiKey,
  system,
  maxTokens = DEFAULT_MAX_TOKENS,
  baseUrl,
  fetchImpl,
  signal,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new OpenAIToolUseError('messages[] is required and non-empty', 'NO_MESSAGES');
  }
  if (!apiKey) {
    throw new OpenAIToolUseError('apiKey is required', 'NO_API_KEY');
  }
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/$/, '')}/chat/completions`;
  const fetchFn = fetchImpl || globalThis.fetch;

  // OpenAI carries the system prompt as the first message rather than a
  // separate field. We only prepend when the caller has NOT already
  // injected one (history replays may include the system turn).
  const fullMessages = [];
  const hasSystem = messages.some((m) => m?.role === 'system');
  if (!hasSystem && system && String(system).trim()) {
    fullMessages.push({ role: 'system', content: String(system) });
  }
  fullMessages.push(...messages);

  const body = {
    model: model || 'gpt-4.1',
    messages: fullMessages,
  };
  // Reasoning models take max_completion_tokens; everything else takes
  // max_tokens. Never emit both — the o-series rejects max_tokens.
  if (isReasoningModel(body.model)) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  if (tools && tools.length) body.tools = tools;

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let raw = '';
    try { raw = await res.text(); } catch { /* ignore */ }
    throw new OpenAIToolUseError(`HTTP ${res.status}: ${raw.slice(0, 300)}`, 'HTTP_FAIL', raw);
  }
  const json = await res.json();
  return parseResponse(json);
}

export function parseResponse(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  const msg = choice?.message || {};
  const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const text = typeof msg.content === 'string' ? msg.content : '';
  // finish_reason 'length' = the response was cut at the token ceiling, so the
  // content or a tool_call's arguments JSON is partial. Flag it so the runner
  // stops instead of acting on truncated output / empty-parsed args.
  const truncated = choice?.finish_reason === 'length';
  // Normalize token usage so agent_turn can accumulate spend across the loop
  // (and team turns can feed the cost cap). null when the response omits it.
  const usage = json?.usage
    ? { inputTokens: json.usage.prompt_tokens || 0, outputTokens: json.usage.completion_tokens || 0 }
    : null;
  if (rawToolCalls.length === 0) {
    return { kind: 'final', text, truncated, usage, raw: json };
  }
  const calls = rawToolCalls.map((tc) => {
    let input = {};
    let parseError = null;
    const a = tc?.function?.arguments;
    if (typeof a === 'string') {
      // Empty-string args mean "no arguments" → {}. A non-empty string that
      // fails to parse is malformed: record the error so agent_turn surfaces a
      // tool failure instead of silently running the tool with {}.
      if (a.trim() === '') input = {};
      else { try { input = JSON.parse(a); } catch (e) { input = {}; parseError = `malformed tool arguments: ${e.message}`; } }
    } else if (a && typeof a === 'object') {
      input = a;
    } else if (a !== undefined && a !== null) {
      // arguments is present but neither a string nor an object (e.g. a number
      // or boolean) — an unexpected wire shape. Surface it as a tool failure
      // instead of silently running the tool with {} (mirrors the malformed
      // JSON-string branch above).
      input = {};
      parseError = `unexpected tool arguments type: ${typeof a}`;
    }
    return { id: tc.id, name: tc?.function?.name, input, ...(parseError ? { parseError } : {}) };
  });
  return { kind: 'tool_calls', text, calls, truncated, usage, assistantContent: msg, raw: json };
}

// OpenAI accepts the agent_turn-native {role, content} shape directly.
export function normalizeHistory(turns) {
  return Array.isArray(turns) ? [...turns] : [];
}

export function initialUserMessage(text) {
  return { role: 'user', content: String(text) };
}

// Echo the assistant turn so the next request preserves the model's
// reasoning and tool_calls ids for correlation. OpenAI already gives us
// a full message object; we just wrap it.
export function assistantTurnMessages(resp) {
  return [resp.assistantContent];
}

// Each tool result becomes its own role:tool message.
export function toolResultMessages(results) {
  return (results || []).map((r) => ({
    role: 'tool',
    tool_call_id: r.id,
    content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
  }));
}
