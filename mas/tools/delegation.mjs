// delegation — task_spawn (named agent), delegate (worker provider).
// Both lazy-import providers/orchestrator.mjs / mas/agent_turn.mjs to
// avoid pulling those into every process that imports the registry.

let _dispatcher = null;
export function __setDispatcher(fn) { _dispatcher = fn; }

async function dispatchDelegate(job) {
  if (_dispatcher) return _dispatcher(job);
  const orch = await import('../../providers/orchestrator.mjs').catch(() => null);
  if (!orch || typeof orch.dispatchWorker !== 'function') {
    return { ok: false, error: 'delegate: orchestrator.dispatchWorker unavailable' };
  }
  return orch.dispatchWorker(job);
}

async function dispatchSpawn(job) {
  const at = await import('../agent_turn.mjs').catch(() => null);
  if (!at || typeof at.runAgentTurn !== 'function') {
    return { ok: false, error: 'task_spawn: agent_turn.runAgentTurn unavailable' };
  }
  return at.runAgentTurn(job);
}

const task_spawn = {
  name: 'task_spawn', category: 'agents', sensitive: true,
  description: 'Spawn an agent by name with a prompt; returns the final answer.',
  parameters: {
    type: 'object',
    properties: { agent: { type: 'string' }, prompt: { type: 'string' } },
    required: ['agent', 'prompt'],
  },
  async exec(args) {
    if (!args?.agent || !args?.prompt) return { ok: false, error: 'task_spawn: agent + prompt required' };
    return dispatchSpawn({ agent: args.agent, prompt: args.prompt });
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
