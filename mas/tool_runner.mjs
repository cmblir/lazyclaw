// Tool runner — given an agent record and a tool invocation, validates
// the agent is allowed to use the tool, runs the tool, audits the call,
// and returns a uniform { ok, result?, error? } shape that the provider
// adapters serialise into their respective tool-result content blocks.

import * as registry from './tools/registry.mjs';
import * as audit from './audit.mjs';
import { DEFAULT_TOOLS } from '../agents.mjs';

export class ToolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ToolError';
    this.code = code || 'TOOL_ERR';
  }
}

// Resolve the tool whitelist into JSON-Schema entries.
//   - undefined    → DEFAULT_TOOLS (the 5 safe defaults a fresh agent gets)
//   - []           → advertise zero tools (matches the deny-check
//                    semantics in runTool — an agent with no whitelist
//                    is allowed to use NOTHING, not everything)
//   - ['bash',…]   → the explicit list, intersected with the registry
export function listToolSchemas(names) {
  const out = [];
  const wanted = names === undefined ? DEFAULT_TOOLS : (Array.isArray(names) ? names : []);
  for (const name of wanted) {
    const t = registry.lookup(name);
    if (!t) continue;
    out.push({ name: t.name, description: t.description, parameters: t.parameters });
  }
  return out;
}

export function isImplemented(name) { return registry.lookup(name) !== null; }
export function knownTool(name)     { return registry.lookup(name) !== null; }

export async function runTool({ agent, tool, args, taskId, configDir, cwd, approve } = {}) {
  if (!agent || !Array.isArray(agent.tools)) {
    throw new ToolError('agent record with .tools[] is required', 'TOOL_BAD_AGENT');
  }
  const impl = registry.lookup(tool);
  if (!impl) throw new ToolError(`unknown tool "${tool}"`, 'TOOL_UNKNOWN');
  if (!agent.tools.includes(tool)) {
    throw new ToolError(`agent "${agent.name}" is not allowed to call tool "${tool}" (whitelist=[${agent.tools.join(', ')}])`, 'TOOL_DENIED');
  }
  if (typeof approve === 'function' && impl.sensitive) {
    let verdict;
    try { verdict = await approve({ tool, args, agent: agent.name }); }
    catch (err) { verdict = { approved: false, reason: `approval error: ${err?.message || err}` }; }
    if (!verdict || !verdict.approved) {
      const result = { ok: false, error: `tool "${tool}" denied by operator${verdict?.reason ? `: ${verdict.reason}` : ''}`, code: 'TOOL_DENIED_APPROVAL' };
      audit.append({ taskId, agent: agent.name, tool, args, result, ok: false, configDir });
      return result;
    }
  }
  let result;
  try {
    result = await impl.exec(args || {}, { cwd: cwd || process.cwd(), configDir, taskId, agent });
  } catch (err) {
    result = { ok: false, error: `${tool} threw: ${err?.message || err}` };
  }
  audit.append({ taskId, agent: agent.name, tool, args, result, ok: !!result?.ok, configDir });
  return result;
}
