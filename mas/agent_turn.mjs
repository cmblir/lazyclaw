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
import { put as _trajPut } from './trajectory_store.mjs';
import { composePromptStack } from './prompt_stack.mjs';

export class AgentTurnError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentTurnError';
    this.code = code || 'AGENT_TURN_ERR';
  }
}

const DEFAULT_MAX_ITERATIONS = 10;

// Mark the last content block in an Anthropic-shaped message array
// with cache_control:ephemeral so the prompt-cache breakpoint advances
// per loop iteration. Operates on the LAST message in the array (the
// one we just appended) — if its content is an array of blocks, the
// final block carries the marker; if it's a plain string we lift it
// into a single text block. Mutates in place — caller owns the array.
function _markLastContentCacheable(msgs) {
  if (!Array.isArray(msgs) || msgs.length === 0) return;
  const last = msgs[msgs.length - 1];
  if (!last || typeof last !== 'object') return;
  if (Array.isArray(last.content)) {
    if (last.content.length === 0) return;
    const block = last.content[last.content.length - 1];
    if (block && typeof block === 'object') {
      block.cache_control = { type: 'ephemeral' };
    }
  } else if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  }
}

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
  approve,
  security,
  // v5 (Group A — C3): trajectoryRef is OPT-OUT, not opt-in. A caller
  // that doesn't pass one but DOES pass a configDir gets a
  // default-stamped record so every production agent turn lands in
  // trajectory_store. Two opt-outs exist for callers that don't want
  // disk side effects (tool-use unit tests, sandboxed harnesses):
  //   - set process.env.LAZYCLAW_NO_TRAJECTORY='1'
  //   - omit configDir (legacy unit-test surface — see _maybePersistTrajectory)
  trajectoryRef = { startedAt: Date.now() },
  // v5 (canonical decision C5) — when true, the system slot passed to
  // the adapter is the full 8-layer composePromptStack output instead
  // of the bare agent.role. Default `false` for byte-stability with
  // existing tool-use tests; callers that have NOT already pre-built
  // the stack (e.g. the future delegation tool, direct API consumers)
  // should opt in.
  usePromptStack = false,
  // Group B / C9 — prompt caching. Off by default to preserve the
  // byte-stable adapter shape that phase 12b et al. depend on; the
  // mention router (production caller) flips it on so every MAS turn
  // hits the Anthropic prompt cache.
  cache = false,
} = {}) {
  if (!agent) throw new AgentTurnError('agent is required', 'NO_AGENT');
  const adapter = adapterFor(agent.provider);

  const tools = adapter.toolSchemas(listToolSchemas(agent.tools));

  // Compose the layered system prompt once, up front, so every adapter
  // round-trip in the loop sees the same string. composePromptStack
  // returns '' on a fresh install — when it does, we fall back to
  // agent.role so the legacy single-layer shape is preserved.
  let systemPrompt = agent.role || '';
  if (usePromptStack) {
    try {
      const stacked = composePromptStack({
        cfgDir: configDir,
        agent,
        workspace: agent.workspace || '',
      });
      if (stacked && stacked.trim()) systemPrompt = stacked;
    } catch { /* best-effort — never block a turn on stack composition */ }
  }

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
  if (trajectoryRef && typeof trajectoryRef === 'object' && !trajectoryRef.startedAt) trajectoryRef.startedAt = Date.now();

  const _maybePersistTrajectory = async (outcome) => {
    if (process.env.LAZYCLAW_NO_TRAJECTORY === '1') return;
    if (!trajectoryRef) return;
    // Defence-in-depth: callers that don't pass configDir (legacy unit
    // tests of the tool-use loop) shouldn't see a side-effect on
    // ~/.lazyclaw. The canonical post-task funnel (mas/learning.mjs)
    // always passes configDir, so production paths still persist.
    if (!configDir) return;
    try {
      await _trajPut({
        taskId, agentName: agent.name || 'agent',
        workerProvider: agent.provider, workerModel: agent.model,
        startedAt: trajectoryRef.startedAt || Date.now(),
        endedAt: Date.now(),
        systemPrompt: agent.role || '',
        userMessages: userMessage ? [String(userMessage)] : [],
        turns: toolCalls.map((c, i) => ({
          turnIdx: i, role: 'tool', content: '',
          toolCalls: [{ name: c.name, args: c.input, result: JSON.stringify(c.result), success: c.ok, durationMs: 0 }],
        })).concat(lastText ? [{
          turnIdx: toolCalls.length, role: 'assistant', content: lastText, toolCalls: [],
        }] : []),
        finalAnswer: lastText,
        outcome,
      }, { configDir });
    } catch { /* trajectory failure must not break the agent turn */ }
  };

  while (iterations < maxIterations) {
    if (signal?.aborted) return { text: lastText, iterations, stoppedBy: 'abort', toolCalls };
    iterations++;
    const resp = await adapter.callOnce({
      messages, tools, model: agent.model, apiKey, system: systemPrompt,
      fetchImpl, baseUrl, signal, cache,
    });
    if (resp.text) lastText = resp.text;

    if (resp.kind === 'final') {
      await _maybePersistTrajectory('done');
      return { text: resp.text || '', iterations, stoppedBy: 'final', toolCalls };
    }

    // tool_calls path: echo the model's assistant turn back so future
    // tool_result messages correlate, then run each tool and append the
    // adapter-shaped tool-result entries (one for Anthropic, N for
    // OpenAI, …).
    // Group B / C9 — advance the prompt-cache breakpoint by marking the
    // freshly-appended assistant + tool_result content with
    // cache_control:ephemeral so the next iteration's prefix (which
    // includes the previous round of tool exchanges) is itself cached.
    // Only the LAST cache_control block in the request actually counts
    // as the live breakpoint per Anthropic's spec — so attaching it to
    // every iteration's latest tool turn is safe and lets the cache
    // walk forward as the conversation grows.
    const _newAssistant = adapter.assistantTurnMessages(resp);
    if (cache && agent.provider === 'anthropic') _markLastContentCacheable(_newAssistant);
    messages.push(..._newAssistant);
    const results = [];
    let toolErrored = false;
    for (const call of resp.calls) {
      let result;
      let ok = true;
      try {
        result = await runTool({
          agent, tool: call.name, args: call.input,
          taskId, configDir, cwd, approve, security,
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
    const _newToolResult = adapter.toolResultMessages(results);
    if (cache && agent.provider === 'anthropic') _markLastContentCacheable(_newToolResult);
    messages.push(..._newToolResult);

    // We feed every tool error (denied/unknown/runtime) back to the
    // model so it can recover. Only an extraordinary error (e.g. the
    // provider returned a malformed envelope) bails out here.
    if (toolErrored && process.env.LAZYCLAW_TOOL_STRICT === '1') {
      await _maybePersistTrajectory('failed');
      return { text: lastText, iterations, stoppedBy: 'tool_error', toolCalls };
    }
  }

  await _maybePersistTrajectory('abandoned');
  return { text: lastText, iterations, stoppedBy: 'budget', toolCalls };
}
