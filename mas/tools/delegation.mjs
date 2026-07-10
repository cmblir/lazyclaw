// delegation — task_spawn (named agent), delegate (worker provider).
// Both lazy-import providers/orchestrator.mjs / mas/agent_turn.mjs to
// avoid pulling those into every process that imports the registry.

// events.mjs is featherweight (zero-dep pub/sub), so a static import is fine —
// it does not pull agent_turn/orchestrator into the registry load path.
import { emit as emitEvent } from '../events.mjs';

let _dispatcher = null;
export function __setDispatcher(fn) { _dispatcher = fn; }

// Test seam for dispatchSpawn's turn runner, mirroring __setDispatcher.
// When set, dispatchSpawn calls it with the SAME args it would hand
// runAgentTurn ({ agent: <record>, userMessage, configDir }) so tests can
// assert a resolved agent RECORD (with .provider) reaches the runner —
// without spinning up a real provider.
let _turnRunner = null;
export function __setTurnRunner(fn) { _turnRunner = fn; }

async function dispatchDelegate(job) {
  if (_dispatcher) return _dispatcher(job);
  const orch = await import('../../providers/orchestrator.mjs').catch(() => null);
  if (!orch || typeof orch.dispatchWorker !== 'function') {
    return { ok: false, error: 'delegate: orchestrator.dispatchWorker unavailable' };
  }
  return orch.dispatchWorker(job);
}

// job = { agent: '<name>', prompt, configDir }
// runAgentTurn expects an agent RECORD (reads .provider/.tools), not a name
// string. Resolve the name → record via getAgent first, then invoke the
// runner with the shape it actually consumes and surface the final text.
async function dispatchSpawn(job) {
  const agentName = String(job?.agent || '');
  const at = await import('../agent_turn.mjs').catch(() => null);
  const runner = _turnRunner || (at && typeof at.runAgentTurn === 'function' ? at.runAgentTurn : null);
  if (!runner) {
    return { ok: false, error: 'task_spawn: agent_turn.runAgentTurn unavailable' };
  }
  const agents = await import('../../agents.mjs').catch(() => null);
  if (!agents || typeof agents.getAgent !== 'function') {
    return { ok: false, error: 'task_spawn: agents.getAgent unavailable' };
  }
  const record = agents.getAgent(agentName, job?.configDir);
  if (!record) {
    return { ok: false, error: `task_spawn: unknown agent ${agentName}` };
  }
  const result = await runner({ agent: record, userMessage: job?.prompt, configDir: job?.configDir, sandbox: job?.sandbox });
  return { ok: true, text: result?.text || '', stoppedBy: result?.stoppedBy, iterations: result?.iterations };
}

// Phase 1b — subagent context isolation. Runs a FRESH runAgentTurn with an
// EMPTY history (the parent transcript is NOT threaded in) under a per-subagent
// tool ALLOWLIST, then returns ONLY the distilled final text plus a tiny usage
// summary — never the subagent's intermediate tool calls/transcript. This keeps
// the parent loop's context clean for exploration-heavy side work (repo search,
// scanning logs) that would otherwise flood the main context.
//
// Safe default allowlist when `tools` is omitted: a read-only subset. Note this
// intentionally EXCLUDES write/edit/patch/bash from agents.DEFAULT_TOOLS — a
// subagent should not mutate state unless the caller explicitly allows it.
const SUBAGENT_DEFAULT_TOOLS = ['read', 'grep', 'recall'];
// Cap a runaway subagent's tool loop. The caller can still tighten further via
// an opt-in { budget } forwarded to runAgentTurn.
const SUBAGENT_MAX_ITERATIONS = 8;

async function dispatchSubagent(job) {
  const at = await import('../agent_turn.mjs').catch(() => null);
  const runner = _turnRunner || (at && typeof at.runAgentTurn === 'function' ? at.runAgentTurn : null);
  if (!runner) {
    return { ok: false, error: 'spawn_subagent: agent_turn.runAgentTurn unavailable' };
  }
  // Synthetic agent record: inherit the parent's provider/model unless the
  // caller overrides, and set .tools to the per-subagent allowlist so BOTH
  // listToolSchemas (advertised schemas) and runTool (deny check) restrict the
  // subagent to exactly these tools — nothing else is reachable.
  const record = {
    name: `${job.parentName || 'agent'}:subagent`,
    provider: job.provider,
    model: job.model,
    role: '',
    tools: job.tools,
  };
  // Isolated context: NO history is passed — the subagent starts empty.
  const result = await runner({
    agent: record,
    userMessage: job.objective,
    configDir: job.configDir,
    sandbox: job.sandbox,
    maxIterations: SUBAGENT_MAX_ITERATIONS,
    budget: job.budget,
  });
  // Distilled conclusion only. The intermediate toolCalls/transcript are
  // deliberately dropped so they never re-enter the parent context.
  const usage = result?.usage
    ? { inputTokens: result.usage.inputTokens || 0, outputTokens: result.usage.outputTokens || 0 }
    : undefined;
  return { ok: true, text: result?.text || '', stoppedBy: result?.stoppedBy, iterations: result?.iterations, usage };
}

const spawn_subagent = {
  name: 'spawn_subagent', category: 'agents', sensitive: true,
  description: 'Run an isolated sub-context (fresh, empty history) with a restricted read-only tool allowlist to do exploration-heavy work (search, read many files, scan logs) and return only a distilled conclusion — keeps the main context clean.',
  parameters: {
    type: 'object',
    properties: {
      objective: { type: 'string', description: 'What the subagent should investigate and conclude.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Per-subagent tool allowlist. The subagent sees ONLY these tools. Defaults to a safe read-only subset (read/grep/recall).' },
      provider: { type: 'string', description: 'Override the provider (defaults to the parent agent).' },
      model: { type: 'string', description: 'Override the model (defaults to the parent agent).' },
      budget: { type: 'object', description: 'Optional per-run cap { maxTokens?, maxCostUsd? } to stop a runaway subagent.' },
    },
    required: ['objective'],
  },
  async exec(args, ctx = {}) {
    if (!args?.objective || !String(args.objective).trim()) {
      return { ok: false, error: 'spawn_subagent: objective required' };
    }
    const tools = Array.isArray(args.tools) && args.tools.length > 0
      ? [...args.tools]
      : [...SUBAGENT_DEFAULT_TOOLS];
    // Inherit provider/model from the parent agent unless overridden.
    const provider = args.provider || ctx.agent?.provider;
    const model = args.model || ctx.agent?.model;
    // Live delegation event (parent → isolated subagent) for the dashboard.
    emitEvent('delegate', { taskId: ctx.taskId, from: ctx.agent?.name, to: `${ctx.agent?.name || 'agent'}:subagent` });
    return dispatchSubagent({
      objective: String(args.objective),
      tools, provider, model,
      budget: args.budget,
      parentName: ctx.agent?.name,
      configDir: ctx.configDir,
      sandbox: ctx.sandbox,
    });
  },
};

const task_spawn = {
  name: 'task_spawn', category: 'agents', sensitive: true,
  description: 'Spawn an agent by name with a prompt; returns the final answer.',
  parameters: {
    type: 'object',
    properties: { agent: { type: 'string' }, prompt: { type: 'string' } },
    required: ['agent', 'prompt'],
  },
  async exec(args, ctx = {}) {
    if (!args?.agent || !args?.prompt) return { ok: false, error: 'task_spawn: agent + prompt required' };
    // Live A→B delegation event for the dashboard (caller → spawned agent).
    emitEvent('delegate', { taskId: ctx.taskId, from: ctx.agent?.name, to: args.agent });
    // Propagate the outer turn's sandbox so a spawned sub-agent stays confined.
    return dispatchSpawn({ agent: args.agent, prompt: args.prompt, configDir: ctx.configDir, sandbox: ctx.sandbox });
  },
};

const delegate = {
  name: 'delegate', category: 'agents', sensitive: true,
  description: 'Dispatch a subtask to a worker provider (claude-cli, codex-cli, gemini-cli, anthropic, openai, gemini, ollama).',
  parameters: {
    type: 'object',
    properties: { worker: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' } },
    required: ['worker', 'prompt'],
  },
  async exec(args) {
    if (!args?.worker || !args?.prompt) return { ok: false, error: 'delegate: worker + prompt required' };
    return dispatchDelegate({ worker: args.worker, prompt: args.prompt, model: args.model });
  },
};

export const TOOLS = [task_spawn, delegate, spawn_subagent];
