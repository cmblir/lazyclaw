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

export const TOOLS = [task_spawn, delegate];
