// Anthropic tool-use adapter.
//
// Unlike providers/anthropic.mjs (which streams a single text response),
// this module makes ONE non-streaming Messages API call at a time and
// parses the result into a normalized envelope the agent-turn runner
// can act on:
//
//   { kind: 'final',      text }
//   { kind: 'tool_calls', text?, calls: [{id, name, input}], assistantContent }
//
// `assistantContent` is the raw `content` array from the API response;
// the caller echoes it back verbatim on the next request so the model
// can correlate tool_result blocks with the right tool_use ids.
//
// Anthropic's docs (Messages API tool-use, accessed Jan 2026):
//   https://docs.anthropic.com/en/api/messages
//   https://docs.anthropic.com/en/docs/build-with-claude/tool-use

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_BASE = 'https://api.anthropic.com/v1';

export class AnthropicToolUseError extends Error {
  constructor(message, code, body) {
    super(message);
    this.name = 'AnthropicToolUseError';
    this.code = code || 'ANTHROPIC_ERR';
    if (body) this.body = body;
  }
}

// Convert a registry schema entry into Anthropic's `input_schema` shape.
// Today the two are identical (both JSON Schema). We materialise this
// helper anyway so future divergences (e.g. Anthropic-specific keys)
// have a single place to land.
export function toAnthropicTools(schemas) {
  return (schemas || []).map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.parameters,
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
    throw new AnthropicToolUseError('messages[] is required and non-empty', 'NO_MESSAGES');
  }
  if (!apiKey) {
    throw new AnthropicToolUseError('apiKey is required', 'NO_API_KEY');
  }
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/$/, '')}/messages`;
  const fetchFn = fetchImpl || globalThis.fetch;
  const body = {
    model: model || 'claude-opus-4-7',
    max_tokens: maxTokens,
    messages,
  };
  if (system && String(system).trim()) body.system = String(system);
  if (tools && tools.length) body.tools = tools;

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let raw = '';
    try { raw = await res.text(); } catch { /* ignore */ }
    throw new AnthropicToolUseError(`HTTP ${res.status}: ${raw.slice(0, 300)}`, 'HTTP_FAIL', raw);
  }
  const json = await res.json();
  return parseResponse(json);
}

export function parseResponse(json) {
  const content = Array.isArray(json?.content) ? json.content : [];
  const textParts = [];
  const calls = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      if (!block.id || !block.name) continue;
      calls.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  const text = textParts.join('');
  if (calls.length === 0) {
    return { kind: 'final', text, raw: json };
  }
  return { kind: 'tool_calls', text, calls, assistantContent: content, raw: json };
}

// Anthropic accepts the agent_turn-native {role, content} shape
// directly; no transformation needed. These helpers exist so the
// agent-turn runner can call the same names across all adapters.
export function normalizeHistory(turns) {
  return Array.isArray(turns) ? [...turns] : [];
}

export function initialUserMessage(text) {
  return { role: 'user', content: String(text) };
}

// Build the `messages` entries the runner appends to record the model's
// own turn. Anthropic packs everything into one assistant message whose
// content is the array of blocks the API returned, so we return that
// inside a one-element array for shape parity with adapters that need
// multiple entries (OpenAI).
export function assistantTurnMessages(resp) {
  return [{ role: 'assistant', content: resp.assistantContent }];
}

// Build the `messages` entries the runner appends after executing tools
// so the next callOnce request has correctly-shaped tool_result blocks.
// Anthropic groups all results inside a single user-role message; the
// array wrapper exists for shape parity with adapters that emit one
// tool-result message per call (OpenAI).
//
// `results` is an array aligned with the assistant turn's tool_calls:
//   [{ id, content, isError? }]
export function toolResultMessages(results) {
  const content = (results || []).map((r) => ({
    type: 'tool_result',
    tool_use_id: r.id,
    content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
    ...(r.isError ? { is_error: true } : {}),
  }));
  return [{ role: 'user', content }];
}

// Back-compat alias kept until external callers migrate.
export function buildToolResultsMessage(results) {
  return toolResultMessages(results)[0];
}
