// Gemini tool-use adapter.
//
// Calls POST /v1beta/models/{model}:generateContent non-streaming and
// normalises the response into the agent_turn envelope shape:
//   { kind: 'final',      text }
//   { kind: 'tool_calls', text?, calls, assistantContent }
//
// Wire-level peculiarities this module hides:
//   - role names are "user" and "model" (not "assistant")
//   - message body is `parts: [{text}, {functionCall}, ...]`
//   - functionCall.args is a native JSON object (no string parsing)
//   - functionResponse goes back in a role:user message inside its own
//     `parts` block; correlation is by `name`, not an id
//   - system prompt rides on `system_instruction.parts[0].text`
//   - tools are declared inside ONE `tools[0].function_declarations` list
//   - some JSON-Schema keys (`additionalProperties`, `$schema`,
//     `examples`) are rejected by Gemini; we strip them before sending
//
// Docs: https://ai.google.dev/api/rest/v1beta/models/generateContent

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiToolUseError extends Error {
  constructor(message, code, body) {
    super(message);
    this.name = 'GeminiToolUseError';
    this.code = code || 'GEMINI_ERR';
    if (body) this.body = body;
  }
}

// Gemini's function_declarations.parameters schema is a strict subset of
// JSON Schema. Strip the keys it rejects so a registry-shared schema can
// be reused across providers without forcing the runner to know about
// per-provider quirks.
function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  const { additionalProperties, $schema, examples, ...rest } = schema;
  const out = {};
  for (const [k, v] of Object.entries(rest)) {
    out[k] = sanitizeGeminiSchema(v);
  }
  return out;
}

export function toGeminiTools(schemas) {
  if (!schemas || schemas.length === 0) return [];
  const declarations = schemas.map((s) => ({
    name: s.name,
    description: s.description,
    parameters: sanitizeGeminiSchema(s.parameters),
  }));
  return [{ function_declarations: declarations }];
}

// agent_turn passes history as plain [{role:'user'|'assistant', content:'text'}].
// Convert each entry into Gemini's parts shape. Anything that looks like
// an already-Gemini message (has `parts`) is passed through unchanged so
// callers can pre-build native turns when they need to.
export function normalizeHistory(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.map((t) => {
    if (t && typeof t === 'object' && Array.isArray(t.parts)) return t;
    const role = t?.role === 'assistant' ? 'model' : (t?.role || 'user');
    const text = typeof t?.content === 'string' ? t.content : '';
    return { role, parts: [{ text }] };
  });
}

export function initialUserMessage(text) {
  return { role: 'user', parts: [{ text: String(text) }] };
}

export async function callOnce({
  messages,
  tools = [],
  model,
  apiKey,
  system,
  baseUrl,
  fetchImpl,
  signal,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GeminiToolUseError('messages[] is required and non-empty', 'NO_MESSAGES');
  }
  if (!apiKey) {
    throw new GeminiToolUseError('apiKey is required', 'NO_API_KEY');
  }
  const m = model || 'gemini-2.5-pro';
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/$/, '')}/models/${encodeURIComponent(m)}:generateContent`;
  const fetchFn = fetchImpl || globalThis.fetch;

  const body = { contents: messages };
  if (tools && tools.length) body.tools = tools;
  if (system && String(system).trim()) {
    body.system_instruction = { parts: [{ text: String(system) }] };
  }

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let raw = '';
    try { raw = await res.text(); } catch { /* ignore */ }
    throw new GeminiToolUseError(`HTTP ${res.status}: ${raw.slice(0, 300)}`, 'HTTP_FAIL', raw);
  }
  const json = await res.json();
  return parseResponse(json);
}

export function parseResponse(json) {
  const candidate = json?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const textParts = [];
  const calls = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string') textParts.push(p.text);
    else if (p.functionCall && p.functionCall.name) {
      // Gemini has no `id` field; we synthesise a stable one from the
      // call index + name so multi-call turns can still be correlated
      // by the runner. We strip the id again before sending the
      // functionResponse back (Gemini matches by name).
      calls.push({
        id: `gem_${calls.length}_${p.functionCall.name}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      });
    }
  }
  const text = textParts.join('');
  // finishReason MAX_TOKENS = the turn was cut at the output ceiling; the text
  // or functionCall args are partial. Flag it so the runner stops.
  const fr = candidate?.finishReason;
  const truncated = fr === 'MAX_TOKENS' || fr === 'SAFETY' || fr === 'RECITATION';
  // Normalize token usage so agent_turn can accumulate spend across the loop
  // (and team turns can feed the cost cap). null when the response omits it.
  const um = json?.usageMetadata;
  const usage = um
    ? {
        // promptTokenCount is cache-INCLUSIVE; report NET (minus cached) to
        // match Anthropic's convention so the cost cap doesn't bill the cached
        // tokens at BOTH the input rate and the cache-read rate.
        inputTokens: (um.promptTokenCount || 0) - (um.cachedContentTokenCount || 0),
        outputTokens: um.candidatesTokenCount || 0,
        cacheReadInputTokens: um.cachedContentTokenCount || 0,
      }
    : null;
  if (calls.length === 0) {
    return { kind: 'final', text, truncated, usage, raw: json };
  }
  // assistantContent is the entire model turn so the runner can echo it
  // back into `contents` for the next request.
  return {
    kind: 'tool_calls',
    text,
    truncated,
    calls,
    usage,
    assistantContent: candidate?.content || { role: 'model', parts },
    raw: json,
  };
}

export function assistantTurnMessages(resp) {
  // Echo the model turn straight back so the next request includes the
  // functionCall parts the API expects to see paired with responses.
  return [resp.assistantContent];
}

export function toolResultMessages(results) {
  // All tool responses fit into a SINGLE user-role message whose parts
  // are functionResponse entries. Gemini matches by name, so we drop
  // the synthetic id.
  const parts = (results || []).map((r) => ({
    functionResponse: {
      name: nameFromSyntheticId(r.id),
      response: normaliseToolResponse(r.content, r.isError),
    },
  }));
  return [{ role: 'user', parts }];
}

function nameFromSyntheticId(id) {
  if (typeof id !== 'string') return String(id || 'unknown');
  // synthetic shape: `gem_<idx>_<name>`. Strip the prefix.
  const m = /^gem_\d+_(.+)$/.exec(id);
  return m ? m[1] : id;
}

function normaliseToolResponse(content, isError) {
  // Gemini wants an object, not a free-form string. Wrap primitives.
  let body;
  if (content === null || content === undefined) body = {};
  else if (typeof content === 'string') body = { content };
  else if (typeof content === 'object') body = content;
  else body = { content: String(content) };
  if (isError) return { ...body, is_error: true };
  return body;
}
