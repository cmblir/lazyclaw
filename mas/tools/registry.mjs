// Tool registry — aggregates every first-party tool group plus any MCP-imported
// tools so callers (tool_runner, splash renderer, agent toolset resolver) can
// ask for them by name without knowing which file they live in.
//
// Each tool record: {name, category, sensitive, description, parameters, exec}
//   - name: unique key (mcp tools use "mcp:<server>:<tool>")
//   - category: 'exec' | 'fs' | 'net' | 'data' | 'agents' | 'learning' | ...
//   - sensitive: when true, tool_runner requires `approve` hook before exec
//   - parameters: JSON-Schema object (same shape as Phase 12a)
//   - exec(args, ctx) -> {ok, ...}

import * as bashTool from './bash.mjs';
import * as readTool from './read.mjs';
import * as writeTool from './write.mjs';
import * as grepTool from './grep.mjs';

function adaptLegacy(mod, { category, sensitive }) {
  return {
    name: mod.NAME,
    category,
    sensitive,
    description: mod.DESCRIPTION,
    parameters: mod.PARAMETERS,
    exec: mod.exec,
  };
}

// Built-in (Phase 12a) tools, adapted to v5 shape.
const BUILTINS = [
  adaptLegacy(bashTool,      { category: 'exec', sensitive: true  }),
  adaptLegacy(readTool,      { category: 'fs',   sensitive: false }),
  adaptLegacy(writeTool,     { category: 'fs',   sensitive: true  }),
  adaptLegacy(grepTool,      { category: 'fs',   sensitive: false }),
];

import { TOOL as editTool }  from './edit.mjs';
import { TOOL as patchTool } from './patch.mjs';
import { TOOL as recallTool } from './recall.mjs';
import { TOOLS as learningTools } from './learning.mjs';
import { TOOLS as webTools } from './web.mjs';
import { TOOLS as osTools } from './os.mjs';
import { TOOLS as codingTools } from './coding.mjs';
import { TOOLS as gitGroupTools } from './git.mjs';
import { TOOLS as schedTools } from './scheduling.mjs';
import { TOOLS as delTools } from './delegation.mjs';
import { TOOLS as mediaTools } from './media.mjs';
import { TOOLS as haTools } from './ha.mjs';
import { TOOL  as clarifyTool } from './clarify.mjs';
import { TOOLS as browserTools } from './browser.mjs';

BUILTINS.push(editTool, patchTool);
BUILTINS.push(recallTool);
for (const t of learningTools) BUILTINS.push(t);
for (const t of webTools) BUILTINS.push(t);
for (const t of osTools) BUILTINS.push(t);
for (const t of codingTools) BUILTINS.push(t);
for (const t of gitGroupTools) BUILTINS.push(t);
for (const t of schedTools) BUILTINS.push(t);
for (const t of delTools) BUILTINS.push(t);
for (const t of mediaTools) BUILTINS.push(t);
for (const t of haTools) BUILTINS.push(t);
BUILTINS.push(clarifyTool);
for (const t of browserTools) BUILTINS.push(t);

// Mutable; new groups (Tasks 2-14) push here; MCP client (Task 15) also pushes.
const TOOLS = new Map();
for (const t of BUILTINS) TOOLS.set(t.name, t);

export function register(tool) {
  if (!tool || typeof tool.name !== 'string') throw new Error('registry.register: tool.name required');
  if (typeof tool.exec !== 'function')        throw new Error(`registry.register(${tool.name}): exec required`);
  if (typeof tool.sensitive !== 'boolean')    throw new Error(`registry.register(${tool.name}): sensitive required`);
  TOOLS.set(tool.name, tool);
}

export function registerGroup(group) {
  if (!Array.isArray(group)) throw new Error('registry.registerGroup: array required');
  for (const t of group) register(t);
}

export function unregister(name) { return TOOLS.delete(name); }

export function lookup(name) { return TOOLS.get(name) || null; }

export function listAll() { return [...TOOLS.values()]; }

export function listNames() { return [...TOOLS.keys()]; }

export function byCategory() {
  const out = {};
  for (const t of TOOLS.values()) (out[t.category] ||= []).push(t);
  return out;
}
