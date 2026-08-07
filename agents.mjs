// Persistent agent registry for `/agent` REPL command and `pompos agent`
// subcommand. Backs the Phase 9 piece of docs/multi-agent.md.
//
// Storage layout under <configDir>/agents/<name>.json. One file per
// agent so concurrent edit / remove writes don't race over a global
// index. Schema field set lives in `defaultShape()` below; new fields
// default to null/empty so reading an older record stays
// forward-compatible.
//
// Defaults reflect §10 of the multi-agent spec: a freshly created
// agent gets the full tool whitelist (bash + read + write + grep)
// because the user opted for "pompos 모든 권한". Callers that want a
// stricter posture can pass an explicit `tools` array.

import fs from 'node:fs';
import path from 'node:path';
import { ensureValidName as cronEnsureValidName } from './cron.mjs';
import * as toolRegistry from './mas/tools/registry.mjs';
import { defaultConfigDir } from './lib/config_dir.mjs';

export { defaultConfigDir };

const AGENTS_DIRNAME = 'agents';

export const DEFAULT_TOOLS = ['bash', 'read', 'write', 'grep', 'skill_view'];

// The valid tool set is derived from the LIVE tool registry (51+ tools), not a
// hardcoded 8-name list with a stale, unregistered 'slack_post' — that list
// rejected recall/delegate/git_*/edit/etc. and silently capped team agents.
export function knownTools() {
  return new Set([...DEFAULT_TOOLS, ...toolRegistry.listNames()]);
}

// Back-compat export: a snapshot of the registered tool names (the registry
// self-populates at import). mcp:* tools register dynamically; validateTools
// accepts them even when absent from this snapshot.
export const ALL_TOOLS = [...knownTools()];

export class AgentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentError';
    this.code = code || 'AGENT_ERR';
  }
}

export function agentsDir(configDir = defaultConfigDir()) {
  return path.join(configDir, AGENTS_DIRNAME);
}

export function agentPath(name, configDir = defaultConfigDir()) {
  ensureValidName(name);
  return path.join(agentsDir(configDir), `${name}.json`);
}

export function ensureValidName(name) {
  try { cronEnsureValidName(name); }
  catch (e) { throw new AgentError(e.message, 'AGENT_BAD_NAME'); }
}

function validateTools(tools) {
  if (!Array.isArray(tools)) {
    throw new AgentError('tools must be an array', 'AGENT_BAD_TOOLS');
  }
  // Validate against the LIVE registry; accept mcp:* names (they register when
  // their server starts) so a config referencing one isn't rejected at edit time.
  const known = knownTools();
  const bad = tools.filter(t => !known.has(t) && !/^mcp:/.test(String(t)));
  if (bad.length) {
    throw new AgentError(`unknown tool(s): ${bad.join(', ')}`, 'AGENT_BAD_TOOLS');
  }
  // Dedupe while preserving order.
  return [...new Set(tools)];
}

function titleCase(s) {
  return String(s).split(/[-_]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function defaultShape(name) {
  return {
    version: 1,
    name,
    displayName: titleCase(name),
    role: '',
    provider: 'claude-cli',
    model: '',
    tools: [...DEFAULT_TOOLS],
    tags: [],
    iconEmoji: '',
    // Explicit Team Live sprite choice: an integer 1..20 picks one of the 20
    // built-in pixel-art avatars (web/avatars/NN.png); null lets the dashboard
    // keep inferring one from the agent's name/role/tags. (dashboard.js
    // avatarIndexFor already honours rec.avatar — this is the registry side.)
    avatar: null,
    // Optional custom character image: a ready-to-use <img src> — either a
    // remote http(s) URL or a daemon-served '/agent-avatars/<file>' path for a
    // photo the user supplied (copied under <configDir>/agent-avatars/). null =
    // none. Takes precedence over `avatar` and the keyword inference.
    avatarImage: null,
    // Optional parent agent (hierarchy). '' = top-level. A team's org tree is
    // derived from members' manager links (see teams.teamTree). Validated to
    // reference a registered agent and to never form a cycle.
    manager: '',
    // Phase 18 — agent memory write trigger. 'auto' means the router
    // fires a reflection LLM call on terminal `done`; 'manual' waits
    // for `pompos agent reflect`; 'off' disables writes entirely.
    memoryWrite: 'auto',
    memoryMaxChars: 12 * 1024,
    // v5 Group A (M3) — self-improving skill synthesis trigger.
    // Default flipped to 'auto' so the learning loop actually closes
    // end-to-end on a fresh install: every agent that finishes a task
    // contributes a SKILL.md unless the operator explicitly opted out
    // ('manual' waits for `pompos agent skill-synth`; 'off' disables).
    // The canonical post-task hook (mas/learning.mjs) also reads
    // `(skillWrite ?? 'auto')`, so v4 records that pre-date this field
    // get the new default without a forced migration.
    skillWrite: 'auto',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function writeAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

const VALID_MEMORY_WRITE = ['auto', 'manual', 'off'];
const VALID_SKILL_WRITE = ['auto', 'manual', 'off'];

// Normalise an explicit avatar choice. null/''/undefined → null (keep the
// dashboard's keyword inference). A value that parses to an integer 1..20 picks
// that built-in sprite. Anything else (0, 21, fractional, non-numeric) throws.
function validateAvatar(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    throw new AgentError('avatar must be an integer 1..20 (or null to clear)', 'AGENT_BAD_AVATAR');
  }
  return n;
}

// Validate a proposed `manager` (parent agent) for `name`: it must reference a
// registered agent, may not be the agent itself, and may not close a cycle
// (i.e. `name` must not already be an ancestor of the proposed manager).
// Returns the normalised manager string ('' when none).
function validateManager(name, manager, configDir) {
  if (!manager) return '';
  const mgr = String(manager);
  if (mgr === name) {
    throw new AgentError(`agent "${name}" cannot manage itself`, 'AGENT_BAD_MANAGER');
  }
  if (!getAgent(mgr, configDir)) {
    throw new AgentError(`unknown manager "${mgr}" (not a registered agent)`, 'AGENT_BAD_MANAGER');
  }
  let cur = mgr;
  const visited = new Set();
  while (cur) {
    if (cur === name) {
      throw new AgentError(`manager "${manager}" would create a cycle`, 'AGENT_MANAGER_CYCLE');
    }
    if (visited.has(cur)) break; // pre-existing cycle elsewhere — stop walking
    visited.add(cur);
    const rec = getAgent(cur, configDir);
    cur = rec && rec.manager ? String(rec.manager) : null;
  }
  return mgr;
}

export function registerAgent({ name, displayName, role = '', provider = 'claude-cli', model = '', tools, tags = [], iconEmoji = '', avatar, memoryWrite, memoryMaxChars, skillWrite, manager } = {}, configDir = defaultConfigDir()) {
  ensureValidName(name);
  const p = agentPath(name, configDir);
  if (fs.existsSync(p)) {
    throw new AgentError(`agent "${name}" already exists`, 'AGENT_EXISTS');
  }
  const toolsClean = validateTools(tools ?? DEFAULT_TOOLS);
  const mw = memoryWrite ?? 'auto';
  if (!VALID_MEMORY_WRITE.includes(mw)) {
    throw new AgentError(`memoryWrite must be one of ${VALID_MEMORY_WRITE.join(', ')}`, 'AGENT_BAD_MEMORY_WRITE');
  }
  const sw = skillWrite ?? 'auto';
  if (!VALID_SKILL_WRITE.includes(sw)) {
    throw new AgentError(`skillWrite must be one of ${VALID_SKILL_WRITE.join(', ')}`, 'AGENT_BAD_SKILL_WRITE');
  }
  const data = {
    ...defaultShape(name),
    displayName: displayName || titleCase(name),
    role: String(role || ''),
    provider: String(provider || 'claude-cli'),
    model: String(model || ''),
    tools: toolsClean,
    tags: Array.isArray(tags) ? tags : [],
    iconEmoji: String(iconEmoji || ''),
    avatar: validateAvatar(avatar),
    memoryWrite: mw,
    memoryMaxChars: Number.isFinite(+memoryMaxChars) && +memoryMaxChars > 0 ? +memoryMaxChars : 12 * 1024,
    skillWrite: sw,
    manager: validateManager(name, manager, configDir),
  };
  writeAtomic(p, data);
  return data;
}

export function getAgent(name, configDir = defaultConfigDir()) {
  let p;
  try { p = agentPath(name, configDir); }
  catch { return null; }
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

export function listAgents(configDir = defaultConfigDir()) {
  const dir = agentsDir(configDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const name = f.slice(0, -5);
    const a = getAgent(name, configDir);
    if (a) out.push(a);
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

export function patchAgent(name, patch, configDir = defaultConfigDir()) {
  const a = getAgent(name, configDir);
  if (!a) throw new AgentError(`no agent "${name}"`, 'AGENT_NO_AGENT');
  const next = { ...a, ...patch, updatedAt: new Date().toISOString() };
  if (patch.tools !== undefined) {
    next.tools = validateTools(patch.tools);
  }
  if (patch.memoryWrite !== undefined && !VALID_MEMORY_WRITE.includes(patch.memoryWrite)) {
    throw new AgentError(`memoryWrite must be one of ${VALID_MEMORY_WRITE.join(', ')}`, 'AGENT_BAD_MEMORY_WRITE');
  }
  if (patch.skillWrite !== undefined && !VALID_SKILL_WRITE.includes(patch.skillWrite)) {
    throw new AgentError(`skillWrite must be one of ${VALID_SKILL_WRITE.join(', ')}`, 'AGENT_BAD_SKILL_WRITE');
  }
  if (patch.avatar !== undefined) {
    next.avatar = validateAvatar(patch.avatar);
  }
  if (patch.avatarImage !== undefined) {
    next.avatarImage = (patch.avatarImage == null || patch.avatarImage === '') ? null : String(patch.avatarImage);
  }
  if (patch.manager !== undefined) {
    next.manager = validateManager(name, patch.manager, configDir);
  }
  writeAtomic(agentPath(name, configDir), next);
  return next;
}

// Supported custom-avatar image types → their served content-type. svg is
// deliberately excluded (inline-script XSS risk in an <img>/object context).
export const AVATAR_IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

// Point an agent at a custom character image. `src` is either a remote http(s)
// URL (stored verbatim) or a path to a local image file (copied into
// <configDir>/agent-avatars/<name><ext> and stored as a daemon-served
// '/agent-avatars/<name><ext>' path). Returns the patched record. The image
// takes precedence over the numeric sprite + keyword inference in the dashboard.
export function setAgentAvatarImage(name, src, configDir = defaultConfigDir()) {
  if (!getAgent(name, configDir)) throw new AgentError(`no agent "${name}"`, 'AGENT_NO_AGENT');
  const s = String(src ?? '').trim();
  if (!s) throw new AgentError('avatar image source required (a file path or http(s) URL)', 'AGENT_BAD_AVATAR_IMAGE');
  if (/^https?:\/\//i.test(s)) {
    return patchAgent(name, { avatarImage: s }, configDir);
  }
  const ext = path.extname(s).toLowerCase();
  if (!AVATAR_IMAGE_TYPES[ext]) {
    throw new AgentError(`unsupported image type "${ext || '(none)'}" — use png/jpg/jpeg/gif/webp or an http(s) URL`, 'AGENT_BAD_AVATAR_IMAGE');
  }
  if (!fs.existsSync(s) || !fs.statSync(s).isFile()) {
    throw new AgentError(`no such image file: ${s}`, 'AGENT_BAD_AVATAR_IMAGE');
  }
  const destDir = path.join(configDir, 'agent-avatars');
  fs.mkdirSync(destDir, { recursive: true });
  // Drop any previously stored image for this agent (it may have a different
  // extension) so a re-point doesn't leave a stale file shadowing the new one.
  for (const e of Object.keys(AVATAR_IMAGE_TYPES)) {
    const old = path.join(destDir, `${name}${e}`);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  fs.copyFileSync(s, path.join(destDir, `${name}${ext}`));
  return patchAgent(name, { avatarImage: `/agent-avatars/${name}${ext}` }, configDir);
}

export function removeAgent(name, configDir = defaultConfigDir()) {
  const p = agentPath(name, configDir);
  if (!fs.existsSync(p)) {
    throw new AgentError(`no agent "${name}"`, 'AGENT_NO_AGENT');
  }
  fs.unlinkSync(p);
  return { name, removed: true };
}

// Parse a comma-separated tool list from CLI flag form. Empty / null
// input returns null so the caller can decide between "user didn't say"
// (→ keep existing or default) and "user said []" (→ disallow all).
export function parseToolsFlag(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '') return [];
  return s.split(',').map(t => t.trim()).filter(Boolean);
}
