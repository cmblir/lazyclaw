// control — first-class multi-agent coordination tools.
//
// DEFECT (audit): multi-agent coordination was a fragile string protocol —
// a task ended only when the model emitted the literal "[[TASK_DONE]]" and
// handed off via an @mention regex. A model that paraphrases, wraps the
// marker in a code block, or a user who pastes the marker breaks it. Every
// 2026 multi-agent SDK uses a structured tool-call handoff/finish instead.
//
// These two tools give agents a STRUCTURED way to signal control flow. The
// router (mas/mention_router.mjs) inspects the turn's toolCalls for these
// results FIRST and only falls back to the legacy marker/@mention behaviour
// when neither structured call is present — so the string protocol stays a
// working compatibility fallback (existing tests pin it).
//
// Both tools are NON-sensitive (no approval gate): they carry no side
// effects of their own, they merely return a small structured result the
// router detects:
//   finish  → { ok:true, control:'finish',  summary }
//   handoff → { ok:true, control:'handoff', to, brief? }

const finish = {
  name: 'finish',
  category: 'agents',
  sensitive: false,
  description: 'Signal that the task/turn is complete. Call this instead of writing a done marker.',
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string', description: 'One-line summary of the outcome.' } },
    required: ['summary'],
  },
  async exec(args) {
    const summary = args?.summary;
    if (typeof summary !== 'string' || !summary.trim()) {
      return { ok: false, error: 'finish: summary required' };
    }
    return { ok: true, control: 'finish', summary };
  },
};

const handoff = {
  name: 'handoff',
  category: 'agents',
  sensitive: false,
  description: 'Transfer control to a named teammate. Call this instead of @mentioning them.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'The teammate agent name to hand control to.' },
      brief: { type: 'string', description: 'Optional one-line brief for the teammate.' },
    },
    required: ['to'],
  },
  async exec(args) {
    const to = args?.to;
    if (typeof to !== 'string' || !to.trim()) {
      return { ok: false, error: 'handoff: to required' };
    }
    const out = { ok: true, control: 'handoff', to };
    if (typeof args?.brief === 'string' && args.brief.trim()) out.brief = args.brief;
    return out;
  },
};

// Given a turn result (runAgentTurn's return shape), return the first
// structured control signal the agent emitted, or null. Shared by the
// router and the loop engine so the detection logic lives in one place.
//   { control:'finish', summary } | { control:'handoff', to, brief? } | null
export function detectControl(result) {
  const calls = result && Array.isArray(result.toolCalls) ? result.toolCalls : [];
  for (const c of calls) {
    const r = c && c.result;
    if (r && r.ok === true && (r.control === 'finish' || r.control === 'handoff')) {
      if (r.control === 'finish') return { control: 'finish', summary: r.summary || '' };
      const out = { control: 'handoff', to: r.to || '' };
      if (r.brief) out.brief = r.brief;
      return out;
    }
  }
  return null;
}

export const TOOLS = [finish, handoff];
