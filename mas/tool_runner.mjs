// Tool runner — given an agent record and a tool invocation, validates
// the agent is allowed to use the tool, runs the tool, audits the call,
// and returns a uniform { ok, result?, error? } shape that the provider
// adapters serialise into their respective tool-result content blocks.
//
// `bash`, `read`, `write`, `grep` ship with Phase 12a. `web_search`,
// `web_fetch`, `slack_post` are advertised in the registry's
// metadata-only entry so the dashboard can show them, but their `exec`
// throws TOOL_NOT_IMPLEMENTED until later phases wire them up.

import * as bashTool from './tools/bash.mjs';
import * as readTool from './tools/read.mjs';
import * as writeTool from './tools/write.mjs';
import * as grepTool from './tools/grep.mjs';
import * as skillViewTool from './tools/skill_view.mjs';
import * as audit from './audit.mjs';

export class ToolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ToolError';
    this.code = code || 'TOOL_ERR';
  }
}

const TOOLS = {
  bash: bashTool,
  read: readTool,
  write: writeTool,
  grep: grepTool,
  skill_view: skillViewTool,
};

const NOT_IMPLEMENTED_TOOLS = ['web_search', 'web_fetch', 'slack_post'];

export function listToolSchemas(names) {
  const out = [];
  const wanted = Array.isArray(names) && names.length ? names : Object.keys(TOOLS);
  for (const name of wanted) {
    const t = TOOLS[name];
    if (!t) continue;
    out.push({ name: t.NAME, description: t.DESCRIPTION, parameters: t.PARAMETERS });
  }
  return out;
}

export function isImplemented(name) {
  return Boolean(TOOLS[name]);
}

export function knownTool(name) {
  return TOOLS[name] !== undefined || NOT_IMPLEMENTED_TOOLS.includes(name);
}

// Run one tool call. The agent record's `tools` field is the whitelist;
// when the call falls outside it, we throw ToolError('TOOL_DENIED') so
// the caller can surface a structured error back to the LLM rather than
// silently dropping the call.
//
// Tools that mutate state / run arbitrary code. When an `approve` hook is
// supplied (e.g. backed by the gateway's remote exec-approval), these are
// gated on a human decision before they run; read-only tools are not.
const SENSITIVE_TOOLS = new Set(['bash', 'write']);

// opts.cwd — where bash/read/write/grep root themselves; defaults to
// process.cwd() so it can be overridden in tests.
// opts.taskId — when set, every call is appended to the task's audit
// log. Unit tests can omit it.
// opts.approve — optional async (call) => { approved, reason }. When
// present, a sensitive tool call is held until it resolves; a non-approval
// blocks the tool (returns a structured error instead of executing).
export async function runTool({ agent, tool, args, taskId, configDir, cwd, approve } = {}) {
  if (!agent || !Array.isArray(agent.tools)) {
    throw new ToolError('agent record with .tools[] is required', 'TOOL_BAD_AGENT');
  }
  if (!knownTool(tool)) {
    throw new ToolError(`unknown tool "${tool}"`, 'TOOL_UNKNOWN');
  }
  if (!agent.tools.includes(tool)) {
    throw new ToolError(`agent "${agent.name}" is not allowed to call tool "${tool}" (whitelist=[${agent.tools.join(', ')}])`, 'TOOL_DENIED');
  }
  const impl = TOOLS[tool];
  if (!impl) {
    // Known but not yet implemented (web_search etc.) — Phase 12+x will fill in.
    const result = { ok: false, error: `tool "${tool}" is registered but not implemented yet` };
    audit.append({ taskId, agent: agent.name, tool, args, result, ok: false, configDir });
    return result;
  }
  // Human-in-the-loop gate for sensitive tools. A denial (or an erroring
  // hook — fail closed) blocks execution and is audited like any result.
  if (typeof approve === 'function' && SENSITIVE_TOOLS.has(tool)) {
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
    result = await impl.exec(args || {}, { cwd: cwd || process.cwd(), configDir });
  } catch (err) {
    result = { ok: false, error: `${tool} threw: ${err?.message || err}` };
  }
  audit.append({ taskId, agent: agent.name, tool, args, result, ok: !!result?.ok, configDir });
  return result;
}
