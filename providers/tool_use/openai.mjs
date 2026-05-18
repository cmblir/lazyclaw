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
    max_tokens: maxTokens,
  };
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
  if (rawToolCalls.length === 0) {
    return { kind: 'final', text, raw: json };
  }
  const calls = rawToolCalls.map((tc) => {
    let input = {};
    const a = tc?.function?.arguments;
    if (typeof a === 'string') {
      try { input = JSON.parse(a); } catch { input = {}; }
    } else if (a && typeof a === 'object') {
      input = a;
    }
    return { id: tc.id, name: tc?.function?.name, input };
  });
  return { kind: 'tool_calls', text, calls, assistantContent: msg, raw: json };
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
