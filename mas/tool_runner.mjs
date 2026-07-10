// Tool runner — given an agent record and a tool invocation, validates
// the agent is allowed to use the tool, runs the tool, audits the call,
// and returns a uniform { ok, result?, error? } shape that the provider
// adapters serialise into their respective tool-result content blocks.

import * as registry from './tools/registry.mjs';
import * as audit from './audit.mjs';
import { DEFAULT_TOOLS } from '../agents.mjs';
import { neutralizeRoleLabels } from './redact.mjs';

// Generic PostToolUse sanitize seam: ALL tool results (not only MCP) pass
// through this before being handed back into agent context. A tool can echo
// untrusted bytes (an MCP server's output, a fetched page, a file's contents),
// so we reuse neutralizeRoleLabels (forged [System]/[User]/… authority lines)
// and neutralise the router termination marker [[TASK_DONE]] so no tool can end
// the router loop by echoing it. Applied to the user-facing text/error fields;
// structured/raw are left intact for programmatic callers.
function defangResultText(text) {
  return neutralizeRoleLabels(String(text ?? '')).replace(/\[\[TASK_DONE\]\]/g, '[[task-done]]');
}
function sanitizeToolResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (typeof result.text === 'string')  result.text = defangResultText(result.text);
  if (typeof result.error === 'string') result.error = defangResultText(result.error);
  return result;
}

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
    if (t.unavailable) continue; // not-implemented stubs stay registered but hidden from the model's tool schemas
    out.push({ name: t.name, description: t.description, parameters: t.parameters });
  }
  return out;
}

export function isImplemented(name) { return registry.lookup(name) !== null; }
export function knownTool(name)     { return registry.lookup(name) !== null; }

export async function runTool({ agent, tool, args, taskId, configDir, cwd, approve, security, sandbox = null } = {}) {
  if (!agent || !Array.isArray(agent.tools)) {
    throw new ToolError('agent record with .tools[] is required', 'TOOL_BAD_AGENT');
  }
  const impl = registry.lookup(tool);
  if (!impl) throw new ToolError(`unknown tool "${tool}"`, 'TOOL_UNKNOWN');
  if (!agent.tools.includes(tool)) {
    throw new ToolError(`agent "${agent.name}" is not allowed to call tool "${tool}" (whitelist=[${agent.tools.join(', ')}])`, 'TOOL_DENIED');
  }
  // Sensitive tools (shell exec, file writes, network egress, delegation)
  // are fail-closed: they run only behind an approval hook, OR when the
  // operator has explicitly opted into unattended execution. A missing
  // approve hook used to mean "ungated" — that made a fresh interactive
  // install run bash/write with no confirmation, i.e. remote-prompt-
  // injection-to-RCE. The default is now deny.
  if (impl.sensitive) {
    if (typeof approve === 'function') {
      let verdict;
      try { verdict = await approve({ tool, args, agent: agent.name }); }
      catch (err) { verdict = { approved: false, reason: `approval error: ${err?.message || err}` }; }
      if (!verdict || !verdict.approved) {
        const result = { ok: false, error: `tool "${tool}" denied by operator${verdict?.reason ? `: ${verdict.reason}` : ''}`, code: 'TOOL_DENIED_APPROVAL' };
        audit.append({ taskId, agent: agent.name, tool, args, result, ok: false, configDir });
        return result;
      }
    } else if (security && security.allowUnattendedSensitive === true) {
      // Explicit, persisted opt-in to unattended sensitive execution.
      // Never silent — record that the gate was bypassed by config.
      audit.append({ taskId, agent: agent.name, tool, args, result: { ok: true, note: 'sensitive tool ran unattended (security.allowUnattendedSensitive)' }, ok: true, configDir });
    } else {
      const result = { ok: false, error: `tool "${tool}" is sensitive and requires operator approval, but no approval channel is configured. Run interactively, pass --approve-url, or set security.allowUnattendedSensitive=true to allow unattended use.`, code: 'TOOL_DENIED_NO_APPROVER' };
      audit.append({ taskId, agent: agent.name, tool, args, result, ok: false, configDir });
      return result;
    }
  }
  let result;
  try {
    result = await impl.exec(args || {}, { cwd: cwd || process.cwd(), configDir, taskId, agent, sandbox });
  } catch (err) {
    result = { ok: false, error: `${tool} threw: ${err?.message || err}` };
  }
  audit.append({ taskId, agent: agent.name, tool, args, result, ok: !!result?.ok, configDir });
  return sanitizeToolResult(result);
}
