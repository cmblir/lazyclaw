// Shared provider tool-use adapter resolver + text-completion scaffold —
// Phase 24.
//
// agent_memory.reflectOnce and skill_synth.synthesizeSkill both used to
// carry their own copy of the same two things:
//
//   1. a pickAdapter() switch dynamic-importing
//      providers/tool_use/<provider>.mjs, and
//   2. the no-tools callOnce scaffold — wrap the user message, call
//      callOnce with tools:[], reject any non-'final' envelope, return
//      resp.text.
//
// Both are pure text completions (reflection lessons / a distilled
// skill), so the only thing that differs between the two callers is the
// prompt they build and what they do with the returned string. That
// caller-specific logic stays in each module; the mechanics live here.

export class ProviderAdapterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProviderAdapterError';
    this.code = code || 'PROVIDER_ADAPTER_ERR';
  }
}

// Dynamic-import the tool-use adapter for a provider. The four supported
// providers each expose a uniform { callOnce, initialUserMessage, ... }
// surface (see providers/tool_use/*.mjs). Throws on an unknown provider
// so callers surface a clear "this provider can't do text completion"
// error rather than a missing-module stack trace.
//
// Every returned adapter also carries a `toolSchemas` mapper: the agentic
// turn loop (mas/agent_turn.mjs) feeds it the provider-neutral tool
// schemas and gets back the provider's native tool shape. Each module
// exposes its mapper under a provider-specific name (toAnthropicTools /
// toOpenAITools / toGeminiTools); claude-cli runs the tool-use loop inside
// the binary and takes the schemas verbatim, so its mapper is identity.
export async function resolveToolUseAdapter(provider) {
  switch (provider) {
    case 'anthropic':  return _withToolSchemas(await import('../providers/tool_use/anthropic.mjs'), (m) => m.toAnthropicTools);
    case 'openai':     return _withToolSchemas(await import('../providers/tool_use/openai.mjs'), (m) => m.toOpenAITools);
    case 'gemini':     return _withToolSchemas(await import('../providers/tool_use/gemini.mjs'), (m) => m.toGeminiTools);
    case 'claude-cli': return _withToolSchemas(await import('../providers/tool_use/claude_cli.mjs'), () => (s) => s);
    default:
      return await _openAICompatAdapter(provider);
  }
}

// Copy a tool-use module namespace into a plain object and attach the
// `toolSchemas` mapper the agentic loop needs. Module namespaces are
// read-only, so we spread into a new object rather than mutate. `pick`
// selects the module's native mapper (or returns identity for claude-cli).
function _withToolSchemas(mod, pick) {
  return { ...mod, toolSchemas: pick(mod) };
}

// Any OpenAI-wire-compatible provider — the built-in compat vendors
// (nim/openrouter/groq/together/xai/deepseek/mistral/fireworks) and custom
// providers — can drive tool-use through the OpenAI adapter, just at a
// different base URL. They advertise as first-class providers, so agents,
// teams, and the trainer must work for them too (previously they threw
// "does not support text completion"). We bind the provider's baseUrl so the
// caller doesn't have to know it; an explicit baseUrl in the call still wins.
async function _openAICompatAdapter(provider) {
  let info;
  try {
    const reg = await import('../providers/registry.mjs');
    info = reg.PROVIDER_INFO && reg.PROVIDER_INFO[provider];
  } catch { info = null; }
  if (!info || !(info.builtinOpenAICompat || info.custom || info.baseUrl)) {
    throw new ProviderAdapterError(
      `provider "${provider}" does not support text completion`,
      'PROVIDER_ADAPTER_UNKNOWN',
    );
  }
  const base = await import('../providers/tool_use/openai.mjs');
  // custom without a stored baseUrl — caller supplies it; still needs the
  // OpenAI tool-schema mapper so the agentic loop can run.
  if (!info.baseUrl) return _withToolSchemas(base, (m) => m.toOpenAITools);
  return {
    ...base,
    toolSchemas: base.toOpenAITools,
    callOnce: (opts = {}) => base.callOnce({ baseUrl: info.baseUrl, ...opts }),
  };
}

// Run one no-tools text completion through the provider's tool-use
// adapter and return the model's text (or '' when it produced none).
//
// The caller owns the prompt: `system` is the agent's role, `userMessage`
// is the fully-built instruction (transcript + ask). We advertise no
// tools — these calls are pure text — and treat anything but a 'final'
// envelope as an error, since a tool_call here means the model ignored
// the no-tools contract.
export async function runTextCompletion({
  provider,
  model,
  system,
  userMessage,
  apiKey,
  baseUrl,
  fetchImpl,
} = {}) {
  const adapter = await resolveToolUseAdapter(provider);
  const initialUser = adapter.initialUserMessage
    ? adapter.initialUserMessage(userMessage)
    : { role: 'user', content: userMessage };

  const resp = await adapter.callOnce({
    messages: [initialUser],
    tools: [],
    model,
    apiKey,
    system: system || '',
    baseUrl,
    fetchImpl,
  });
  if (resp.kind !== 'final') {
    throw new ProviderAdapterError(
      `text completion expected a final text reply, got ${resp.kind}`,
      'PROVIDER_ADAPTER_NO_TEXT',
    );
  }
  return resp.text || '';
}
