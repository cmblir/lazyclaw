// Agent turn runner — given an agent record, a thread of history, and
// a new user message, drives the provider-specific tool-use loop until
// the model emits a final text reply (or the iteration budget runs
// out).
//
// Provider routing:
//   anthropic → providers/tool_use/anthropic.mjs   (Phase 12b)
//   openai    → providers/tool_use/openai.mjs      (Phase 12c — todo)
//   gemini    → providers/tool_use/gemini.mjs      (Phase 12d — todo)
//   claude-cli → not supported (subprocess provider — Phase 12 scope
//                excludes it; runAgentTurn throws so callers can flag
//                the agent in the dashboard).
//
// The loop:
//   1. Build messages = [...history, {role:user, content:input}]
//   2. Call adapter.callOnce → response
//   3. If response.kind === 'final', return { text, turns, iterations }
//   4. Else (tool_calls): for each call, run the tool, append a
//      tool_result message, loop back to step 2.
//   5. If iterations > opts.maxIterations (default 10), bail with
//      partial text and `stoppedBy: 'budget'`.

import { listToolSchemas, runTool, ToolError } from './tool_runner.mjs';
import * as anthropic from '../providers/tool_use/anthropic.mjs';
import * as openai from '../providers/tool_use/openai.mjs';
import * as gemini from '../providers/tool_use/gemini.mjs';
import * as claudeCli from '../providers/tool_use/claude_cli.mjs';

export class AgentTurnError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentTurnError';
    this.code = code || 'AGENT_TURN_ERR';
  }
}

const DEFAULT_MAX_ITERATIONS = 10;

function adapterFor(provider) {
  switch (provider) {
    case 'anthropic':  return { ...anthropic,  toolSchemas: anthropic.toAnthropicTools };
    case 'openai':     return { ...openai,     toolSchemas: openai.toOpenAITools };
    case 'gemini':     return { ...gemini,     toolSchemas: gemini.toGeminiTools };
    // claude-cli runs the tool-use loop INSIDE the binary. Our adapter
    // resolves every call to kind:'final' so the mention router still
    // gets a normalised reply, even though no tool_calls envelope is
    // ever observed.
    case 'claude-cli': return { ...claudeCli, toolSchemas: (s) => s };
    default:
      throw new AgentTurnError(`provider "${provider}" does not support tool-use yet`, 'PROVIDER_UNSUPPORTED');
  }
}

// Run one full agent turn. Returns:
//   { text, iterations, stoppedBy: 'final' | 'budget' | 'tool_error', toolCalls }
//
// `toolCalls` lists every tool invocation that actually ran (with its
// result). `stoppedBy: 'tool_error'` means the runner aborted because a
// tool denied/threw; the previous text (if any) is returned but the
// next provider call was skipped.
export async function runAgentTurn({
  agent,
  userMessage,
  history = [],
  taskId,
  configDir,
  cwd,
  fetchImpl,
  baseUrl,
  apiKey,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  signal,
} = {}) {
  if (!agent) throw new AgentTurnError('agent is required', 'NO_AGENT');
  const adapter = adapterFor(agent.provider);

  const tools = adapter.toolSchemas(listToolSchemas(agent.tools));

  // Seed messages from prior history + the new user input. Callers
  // pass history in a provider-neutral [{role, content}] shape; the
  // adapter normalises it into its native message format (e.g. Gemini's
  // `parts: [...]` representation). The new user message is wrapped
  // identically.
  const normalize = adapter.normalizeHistory || ((h) => [...h]);
  const initialUser = adapter.initialUserMessage || ((t) => ({ role: 'user', content: t }));
  const messages = normalize(history);
  if (userMessage && String(userMessage).trim()) {
    messages.push(initialUser(String(userMessage)));
  }

  const toolCalls = [];
  let iterations = 0;
  let lastText = '';

  while (iterations < maxIterations) {
    if (signal?.aborted) return { text: lastText, iterations, stoppedBy: 'abort', toolCalls };
    iterations++;
    const resp = await adapter.callOnce({
      messages, tools, model: agent.model, apiKey, system: agent.role,
      fetchImpl, baseUrl, signal,
    });
    if (resp.text) lastText = resp.text;

    if (resp.kind === 'final') {
      return { text: resp.text || '', iterations, stoppedBy: 'final', toolCalls };
    }

    // tool_calls path: echo the model's assistant turn back so future
    // tool_result messages correlate, then run each tool and append the
    // adapter-shaped tool-result entries (one for Anthropic, N for
    // OpenAI, …).
    messages.push(...adapter.assistantTurnMessages(resp));
    const results = [];
    let toolErrored = false;
    for (const call of resp.calls) {
      let result;
      let ok = true;
      try {
        result = await runTool({
          agent, tool: call.name, args: call.input,
          taskId, configDir, cwd,
        });
        if (result && result.ok === false) ok = false;
      } catch (err) {
        ok = false;
        if (err instanceof ToolError) {
          result = { ok: false, error: err.message, code: err.code };
        } else {
          result = { ok: false, error: `runTool threw: ${err?.message || err}` };
        }
      }
      toolCalls.push({ id: call.id, name: call.name, input: call.input, result, ok });
      results.push({ id: call.id, content: result, isError: !ok });
      if (!ok) toolErrored = true;
    }
    messages.push(...adapter.toolResultMessages(results));

    // We feed every tool error (denied/unknown/runtime) back to the
    // model so it can recover. Only an extraordinary error (e.g. the
    // provider returned a malformed envelope) bails out here.
    if (toolErrored && process.env.LAZYCLAW_TOOL_STRICT === '1') {
      return { text: lastText, iterations, stoppedBy: 'tool_error', toolCalls };
    }
  }

  return { text: lastText, iterations, stoppedBy: 'budget', toolCalls };
}
