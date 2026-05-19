// Per-agent memory store — Phase 18.
//
// Each agent gets a plain-markdown file at
//   <configDir>/memory/agents/<name>.md
// with newest reflections at the TOP. Reads truncate to a configurable
// byte budget (default 12 KB so the system prompt doesn't balloon).
// Writes are append-to-top so the freshest entry is always inside the
// truncation window.
//
// All I/O is best-effort: a missing/unreadable file returns '' and a
// failed write is logged (when a logger is supplied) but never thrown.
// The router calls these from the hot path; we don't want a transient
// fs hiccup to kill a multi-agent turn.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_MAX_CHARS = 12 * 1024;
const AGENTS_MEM_DIR = path.join('memory', 'agents');

export class AgentMemoryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AgentMemoryError';
    this.code = code || 'AGENT_MEMORY_ERR';
  }
}

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

export function memoryPath(name, configDir = defaultConfigDir()) {
  if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new AgentMemoryError(`bad agent name "${name}"`, 'AGENT_MEMORY_BAD_NAME');
  }
  return path.join(configDir, AGENTS_MEM_DIR, `${name}.md`);
}

// Read the agent's memory, truncated to `maxChars` from the top
// (newest-first). Returns '' when the file is missing.
export function readMemory(name, configDir = defaultConfigDir(), maxChars = DEFAULT_MAX_CHARS) {
  let p;
  try { p = memoryPath(name, configDir); }
  catch { return ''; }
  if (!fs.existsSync(p)) return '';
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (raw.length <= maxChars) return raw;
    // Cut at a paragraph boundary if possible so a truncated entry
    // doesn't bleed into the truncation marker.
    let cut = raw.slice(0, maxChars);
    const lastBlank = cut.lastIndexOf('\n\n');
    if (lastBlank > maxChars * 0.6) cut = cut.slice(0, lastBlank);
    return cut + '\n\n…[older entries truncated]\n';
  } catch {
    return '';
  }
}

export function writeRaw(name, text, configDir = defaultConfigDir()) {
  const p = memoryPath(name, configDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, String(text ?? ''));
  fs.renameSync(tmp, p);
  return p;
}

export function clear(name, configDir = defaultConfigDir()) {
  let p;
  try { p = memoryPath(name, configDir); }
  catch { return false; }
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// Prepend a new reflection block to the top of the file. Body should
// be the LLM-generated bullets (no header) — we add the date + task
// header ourselves so the format stays consistent.
export function prependEntry(name, { taskId, title, body, ts = new Date() } = {}, configDir = defaultConfigDir()) {
  const cleanBody = String(body || '').trim();
  if (!cleanBody) return null;
  const date = ts.toISOString().slice(0, 10);
  const header = `## ${date} — task ${taskId}${title ? ` (${title})` : ''}`;
  const entry = `${header}\n${cleanBody}\n\n`;
  const p = memoryPath(name, configDir);
  let existing = '';
  if (fs.existsSync(p)) {
    try { existing = fs.readFileSync(p, 'utf8'); } catch { /* keep going */ }
  }
  if (!existing) {
    existing = `# ${name} — memory\n\n`;
  }
  // Split off the "# name — memory" title (line 1) so new entries land
  // ABOVE the older entries but BELOW the title.
  let title_line, rest;
  const firstNewline = existing.indexOf('\n');
  if (firstNewline >= 0 && existing.startsWith('# ')) {
    title_line = existing.slice(0, firstNewline + 1);
    rest = existing.slice(firstNewline + 1).replace(/^\n+/, '');
  } else {
    title_line = `# ${name} — memory\n`;
    rest = existing;
  }
  const next = `${title_line}\n${entry}${rest}`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, p);
  return { path: p, entry };
}

// Build the system-prompt block the router injects between agent.role
// and the team-metadata footer. Returns '' when memory is empty.
export function buildMemoryBlock(name, configDir = defaultConfigDir(), maxChars = DEFAULT_MAX_CHARS) {
  const raw = readMemory(name, configDir, maxChars);
  if (!raw.trim()) return '';
  return [
    '---',
    '',
    'What you remember from prior tasks (newest first):',
    '',
    raw.trim(),
    '',
    '---',
    '',
  ].join('\n');
}

// Run one reflection LLM call for an agent. Returns the trimmed bullet
// body (without the date header) so the caller can either prepend it
// to the on-disk file (auto mode) or surface it to the user (manual
// command). Throws on hard failure; the router catches and logs.
//
// We use the agent's own provider via the existing tool-use callOnce
// adapters because they are already wired up with apiKey/baseUrl
// passthrough. No tools are advertised — reflection is pure text.
export async function reflectOnce({ agent, task, apiKey, baseUrl, fetchImpl, maxBullets = 6 } = {}) {
  if (!agent || !task) throw new AgentMemoryError('agent and task are required', 'AGENT_MEMORY_BAD_INPUT');
  const adapter = await pickAdapter(agent.provider);

  const transcript = (Array.isArray(task.turns) ? task.turns : [])
    .map((t) => {
      const who = t.agent === 'user' ? 'User' : t.agent === 'system' ? 'System' : t.agent;
      return `[${who}] ${t.text || ''}`;
    })
    .join('\n\n') || '(no turns)';

  const userMessage =
    `You just finished task "${task.title || '(untitled)'}" (id ${task.id}). Here is the full transcript:\n\n` +
    transcript +
    `\n\nWrite a SHORT markdown block (≤ ${maxBullets} bullet points) capturing what you learned ` +
    `during this task that would be useful next time. Be concrete: file paths, decisions, ` +
    `gotchas, teammate preferences. Do NOT repeat generic advice. Do NOT exceed ${maxBullets} ` +
    `bullets. Reply with the bullets only — no headers, no preamble.`;

  const initialUser = adapter.initialUserMessage
    ? adapter.initialUserMessage(userMessage)
    : { role: 'user', content: userMessage };

  const resp = await adapter.callOnce({
    messages: [initialUser],
    tools: [],
    model: agent.model,
    apiKey,
    system: agent.role || '',
    baseUrl,
    fetchImpl,
  });
  if (resp.kind !== 'final') {
    throw new AgentMemoryError(`reflection expected text reply, got ${resp.kind}`, 'AGENT_MEMORY_NO_TEXT');
  }
  const text = (resp.text || '').trim();
  return text;
}

async function pickAdapter(provider) {
  switch (provider) {
    case 'anthropic': return await import('../providers/tool_use/anthropic.mjs');
    case 'openai':    return await import('../providers/tool_use/openai.mjs');
    case 'gemini':    return await import('../providers/tool_use/gemini.mjs');
    default:
      throw new AgentMemoryError(`provider "${provider}" does not support reflection`, 'AGENT_MEMORY_NO_PROVIDER');
  }
}
