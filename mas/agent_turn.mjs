// Agent turn runner — given an agent record, a thread of history, and
// a new user message, drives the provider-specific tool-use loop until
// the model emits a final text reply (or the iteration budget runs
// out).
//
// Provider routing goes through mas/provider_adapters.mjs::resolveToolUseAdapter
// — a single resolver shared with the trainer/reflection text-completion path.
// It maps the four first-class providers to their tool_use module and falls
// through to the OpenAI-compat adapter for every builtin compat vendor
// (groq/nim/openrouter/…) and custom provider, so agentic turns work for the
// same providers text completion already did:
//   anthropic  → providers/tool_use/anthropic.mjs
//   openai     → providers/tool_use/openai.mjs
//   gemini     → providers/tool_use/gemini.mjs
//   claude-cli → providers/tool_use/claude_cli.mjs; the tool-use loop runs
//                INSIDE the binary, so the adapter normalises every reply to
//                kind:'final' (no tool_calls envelope is ever observed).
//   compat/custom → providers/tool_use/openai.mjs at the vendor's base URL.
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
import { resolveToolUseAdapter } from './provider_adapters.mjs';
import { put as _trajPut } from './trajectory_store.mjs';
import { composePromptStack } from './prompt_stack.mjs';
import { compactMessages } from '../chat_window.mjs';
import { emit as emitEvent } from './events.mjs';

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
  // Optional parsed sandbox spec (or null). Threaded into runTool so the
  // bash tool runs inside the sandbox when one is configured. Default null
  // keeps existing callers/tests byte-stable; see scope_notes for which
  // callers should pass this to fully activate sandboxing.
  sandbox = null,
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
  // Phase 1 (compaction-budget) — OPT-IN, default undefined = today's
  // behavior. When set to { maxTokens, toolResultMaxChars?, keepRecentTurns? }
  // the transcript is passed through chat_window::compactMessages before every
  // adapter.callOnce: oversized tool results are truncated (L1) and, if still
  // over maxTokens, the oldest turns are elided (L2). Non-LLM, $0, deterministic.
  compact = undefined,
  // Phase 1 (compaction-budget) — OPT-IN per-run cost/token ceiling, default
  // undefined = today's behavior. When set to { maxTokens?, maxCostUsd? } the
  // loop checks accumulated usage BEFORE each adapter.callOnce and, if a ceiling
  // has been crossed, stops early with stoppedBy:'budget_exceeded' and the
  // partial text (mirrors the existing stoppedBy taxonomy).
  budget = undefined,
  // Phase 1c (default-provider security) — OPT-IN claude-cli permission mode,
  // default undefined = today's behavior. When set, it is forwarded into
  // adapter.callOnce so the surface-aware caller (e.g. the unattended team path)
  // can fail-close the spawned claude's --permission-mode. Unset leaves the
  // claude-cli adapter's own bypassPermissions fallback in place (byte-stable
  // for interactive/CLI callers); other adapters ignore the unknown opt.
  permissionMode = undefined,
} = {}) {
  if (!agent) throw new AgentTurnError('agent is required', 'NO_AGENT');
  // The shared resolver throws PROVIDER_ADAPTER_UNKNOWN (with a
  // text-completion-flavoured message) for a provider that has no tool-use
  // adapter. Preserve runAgentTurn's stable contract — callers/tests expect
  // PROVIDER_UNSUPPORTED for that condition — while still sharing one resolver.
  let adapter;
  try {
    adapter = await resolveToolUseAdapter(agent.provider);
  } catch (e) {
    if (e && e.code === 'PROVIDER_ADAPTER_UNKNOWN') {
      throw new AgentTurnError(`provider "${agent.provider}" does not support tool-use yet`, 'PROVIDER_UNSUPPORTED');
    }
    throw e;
  }

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
        // Auto-inject top-k recalled context relevant to THIS user message.
        query: userMessage,
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
  // Accumulate token usage across every callOnce in this turn's tool loop so
  // the caller (e.g. the team router → cost cap) can account for what the turn
  // spent. Stays null until an adapter actually reports usage.
  const usageTotal = {
    inputTokens: 0, outputTokens: 0,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0,
  };
  let usageSeen = false;
  const _usage = () => (usageSeen ? { ...usageTotal } : null);
  if (trajectoryRef && typeof trajectoryRef === 'object' && !trajectoryRef.startedAt) trajectoryRef.startedAt = Date.now();

  const _maybePersistTrajectory = async (outcome) => {
    if (process.env.LAZYCLAW_NO_TRAJECTORY === '1') return;
    if (!trajectoryRef) return;
    // Defence-in-depth: callers that don't pass configDir (legacy unit
    // tests of the tool-use loop) shouldn't see a side-effect on
    // ~/.pompos. The canonical post-task funnel (mas/learning.mjs)
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
          toolCalls: [{ name: c.name, args: c.input, result: JSON.stringify(c.result), success: c.ok, durationMs: c.durationMs || 0 }],
        })).concat(lastText ? [{
          turnIdx: toolCalls.length, role: 'assistant', content: lastText, toolCalls: [],
        }] : []),
        finalAnswer: lastText,
        outcome,
      }, { configDir });
    } catch { /* trajectory failure must not break the agent turn */ }
  };

  // Phase 1 — has the accumulated usage crossed the opt-in per-run ceiling?
  // Strict ">" so a ceiling of exactly N (or 0) is not tripped until it is
  // truly exceeded; without a budget this is always false (today's behavior).
  const _budgetExceeded = () => {
    if (!budget || !usageSeen) return false;
    if (Number.isFinite(budget.maxTokens)) {
      const spent = usageTotal.inputTokens + usageTotal.outputTokens
        + usageTotal.cacheCreationInputTokens + usageTotal.cacheReadInputTokens;
      if (spent > budget.maxTokens) return true;
    }
    if (Number.isFinite(budget.maxCostUsd) && usageTotal.totalCostUsd > budget.maxCostUsd) return true;
    return false;
  };

  while (iterations < maxIterations) {
    if (signal?.aborted) return { text: lastText, iterations, stoppedBy: 'abort', toolCalls, usage: _usage() };
    // Phase 1 — stop before spending more if the per-run budget is exhausted.
    if (_budgetExceeded()) {
      await _maybePersistTrajectory('abandoned');
      return { text: lastText, iterations, stoppedBy: 'budget_exceeded', toolCalls, usage: _usage() };
    }
    // Phase 1 — compact the transcript before the call when opted in. Non-LLM,
    // in-place-safe (compactMessages deep-copies only what it rewrites), so we
    // reassign the loop's message array to the compacted view.
    if (compact && Number.isFinite(compact.maxTokens)) {
      const { messages: compacted } = compactMessages(messages, compact);
      messages.length = 0;
      messages.push(...compacted);
    }
    iterations++;
    const resp = await adapter.callOnce({
      messages, tools, model: agent.model, apiKey, system: systemPrompt,
      // Forward-compat: thread an explicit per-agent output cap when the agent
      // record carries one. No current config/setup path populates
      // agent.maxTokens / agent.maxOutputTokens, so this is `undefined` today —
      // each adapter then falls back to its own DEFAULT (anthropic/openai) or
      // leaves the cap unset (gemini), keeping existing turns byte-stable. When
      // a future config does set it, the cap reaches gemini (FIX D) too.
      maxTokens: agent.maxTokens ?? agent.maxOutputTokens,
      fetchImpl, baseUrl, signal, cache,
      // Phase 1c — forward only when the caller set it, so the claude-cli
      // adapter keeps its bypassPermissions default for every existing caller.
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    });
    if (resp.text) lastText = resp.text;
    if (resp.usage) {
      usageTotal.inputTokens += resp.usage.inputTokens || 0;
      usageTotal.outputTokens += resp.usage.outputTokens || 0;
      usageTotal.cacheCreationInputTokens += resp.usage.cacheCreationInputTokens || 0;
      usageTotal.cacheReadInputTokens += resp.usage.cacheReadInputTokens || 0;
      usageTotal.totalCostUsd += resp.usage.totalCostUsd || 0;
      usageSeen = true;
    }

    // The model hit its output token ceiling: the final answer or the tool
    // call(s) are partial/garbage. Stop with an explicit error rather than
    // returning a cut-off answer or running an incomplete tool call.
    if (resp.truncated) {
      await _maybePersistTrajectory('error');
      return {
        text: lastText, iterations, stoppedBy: 'truncated',
        error: 'response truncated at the model output token limit (raise maxTokens)',
        toolCalls, usage: _usage(),
      };
    }

    if (resp.kind === 'final') {
      await _maybePersistTrajectory('done');
      return { text: resp.text || '', iterations, stoppedBy: 'final', toolCalls, usage: _usage() };
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
    // Run every tool call in THIS turn concurrently — one turn's calls are
    // independent of each other, so a slow bash/read no longer blocks the
    // rest. Each resolves to its own record with a REAL per-call durationMs
    // (was hardcoded 0 in the trajectory). We await them all, then fold the
    // results back in resp.calls order so toolCalls / results / the
    // adapter-shaped tool_result messages keep the exact ordering the
    // adapters expect.
    const settled = await Promise.all(resp.calls.map(async (call) => {
      // The adapter could not parse this tool call's arguments (e.g. OpenAI
      // emitted malformed JSON). Surface a tool error so the model can retry
      // instead of silently running the tool with empty input.
      if (call.parseError) {
        const result = { ok: false, error: call.parseError };
        return { call, result, ok: false, durationMs: 0 };
      }
      let result;
      let ok = true;
      const startedAt = Date.now();
      try {
        result = await runTool({
          agent, tool: call.name, args: call.input,
          taskId, configDir, cwd, approve, security, sandbox,
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
      return { call, result, ok, durationMs: Date.now() - startedAt };
    }));

    const results = [];
    let toolErrored = false;
    for (const { call, result, ok, durationMs } of settled) {
      toolCalls.push({ id: call.id, name: call.name, input: call.input, result, ok, durationMs });
      emitEvent('tool.call', { taskId, agent: agent.name, tool: call.name, ok });
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
      return { text: lastText, iterations, stoppedBy: 'tool_error', toolCalls, usage: _usage() };
    }
  }

  await _maybePersistTrajectory('abandoned');
  return { text: lastText, iterations, stoppedBy: 'budget', toolCalls, usage: _usage() };
}
