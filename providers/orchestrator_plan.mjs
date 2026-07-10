// Orchestrator plan/prompt helpers — split out of orchestrator.mjs to keep
// that file under the size gate. Pure + self-contained: plan-JSON parsing,
// the planner/synthesis system prompts, and the worker-pool tuning constants.
// No behavior change; these are imported back by orchestrator.mjs.

export function _bestPlanArray(text) {
  // Planners sometimes wrap the JSON in prose / code fences. Try the
  // raw response first, then the largest [...] / [...]-shaped span.
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  let arr = tryParse(text);
  if (Array.isArray(arr)) return arr;
  // Strip ```json fences
  const fence = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fence) {
    arr = tryParse(fence[1].trim());
    if (Array.isArray(arr)) return arr;
  }
  // Largest [...] substring
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    arr = tryParse(text.slice(start, end + 1));
    if (Array.isArray(arr)) return arr;
  }
  return null;
}

// Default worker-pool concurrency when cfg.orchestrator.concurrency is unset.
// Parallel is the point of a worker pool; an unconfigured fleet should not run
// subtasks one at a time. Clamped to the worker count at the call site, and an
// explicit 0/1 still selects the sequential live-streaming path.
export const DEFAULT_CONCURRENCY = 3;

// Opt-in agentic workers (cfg.orchestrator.agenticWorkers): an EXECUTE worker
// runs through runAgentTurn so it can actually DO work with its tools (shell,
// file read, recall) instead of only streaming text. Default OFF — the
// text-streaming path is byte-stable. Tool calls are confined by the sandbox
// the caller passes; the loop is bounded by workerMaxIterations.
export const DEFAULT_WORKER_TOOLS = ['bash', 'read', 'grep', 'recall'];
export const DEFAULT_WORKER_MAX_ITERATIONS = 8;
export const AGENTIC_WORKER_ROLE =
  'You are an orchestrator worker. Complete ONLY the assigned subtask. Use your ' +
  'tools (shell, file read, grep, recall) to do real work when useful, then report ' +
  'the result concisely. Do not ask questions — act, then summarise what you found.';

export const PLANNER_SYSTEM = `You are an orchestrator that decomposes a user request into independent subtasks for parallel worker agents.

Rules:
- Output ONLY a JSON array. No prose, no markdown, no code fences.
- Each entry has shape { "id": <int>, "task": "<one-sentence imperative>", "rationale": "<why this is a useful slice>" }.
- 2 to 5 subtasks. Each must be doable WITHOUT seeing the others' outputs (parallel-safe).
- If the request is genuinely atomic (e.g. "say hi"), return a single-element array.
- Do not add a synthesis / merge step — that runs separately after workers complete.
- Subtasks must be self-contained: include any context a worker needs to act on the task alone.`;

export const SYNTHESIS_SYSTEM = `You are an orchestrator producing the final answer for the user.

You receive: (1) the user's original request, (2) the subtask plan you produced, (3) each worker's response.

Rules:
- Synthesize a single coherent answer. Distill — do not echo each worker verbatim.
- Cite worker findings briefly when they meaningfully diverge ("Worker A found …, Worker B confirmed").
- If a worker failed, acknowledge it but do not let it block the rest of the answer.
- Match the tone and length the user implied (one-line question → one-line answer; deep dive → deep dive).
- No JSON; this is the human-facing reply.`;
