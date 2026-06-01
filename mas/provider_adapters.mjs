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
export async function resolveToolUseAdapter(provider) {
  switch (provider) {
    case 'anthropic':  return await import('../providers/tool_use/anthropic.mjs');
    case 'openai':     return await import('../providers/tool_use/openai.mjs');
    case 'gemini':     return await import('../providers/tool_use/gemini.mjs');
    case 'claude-cli': return await import('../providers/tool_use/claude_cli.mjs');
    default:
      throw new ProviderAdapterError(
        `provider "${provider}" does not support text completion`,
        'PROVIDER_ADAPTER_UNKNOWN',
      );
  }
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
