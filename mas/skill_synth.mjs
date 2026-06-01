// Skill synthesis — Phase 20.
//
// Turns a finished task transcript into a reusable SKILL.md (the
// Hermes self-improving-skill pattern). This module owns the
// deterministic, LLM-free pieces so they can be unit-tested without a
// network round-trip:
//
//   slugifySkill(title)        → a filesystem-safe skill name
//   parseSynthOutput(text)     → { name, description, body } from raw
//                                LLM output
//   assembleSkillDoc({...})    → a full SKILL.md (frontmatter + body)
//
// The single LLM call lives in synthesizeSkill() at the bottom; it
// mirrors agent_memory.reflectOnce() (same provider adapters, same
// no-tools text completion) but asks for a structured skill instead of
// free-text lessons.

import * as skills from '../skills.mjs';
import { runTextCompletion } from './provider_adapters.mjs';
import { redactSecrets, neutralizeRoleLabels } from './redact.mjs';

const SECTION_RE = /^#{1,6}\s+/;
const MAX_NAME_LEN = 48;
const MAX_BODY_BYTES = 8 * 1024;

// Re-export the shared secret redactor (mas/redact.mjs) so existing
// callers of skill_synth.redactSecrets keep working while the single
// implementation is shared with agent_memory.reflectOnce.
export { redactSecrets };

// Sanitise an agent-authored skill body before it is persisted and
// later loaded into other agents' context: redact secrets, neutralise
// the task-termination marker (so reference material can't drive the
// router loop), strip control characters, and cap the size.
export function sanitizeSkillBody(text) {
  let s = redactSecrets(text);
  s = s.replace(/\[\[TASK_DONE\]\]/g, '[[task-done]]');
  // Strip control characters except tab/newline/carriage-return.
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (Buffer.byteLength(s, 'utf8') > MAX_BODY_BYTES) {
    s = Buffer.from(s, 'utf8').subarray(0, MAX_BODY_BYTES).toString('utf8').replace(/\uFFFD+$/, '') + '\n\n…[truncated]';
  }
  return s;
}

// Sanitise the one-line description (it lands in every agent's system
// prompt via the skills index): redact, collapse to a single line,
// neutralise the marker, cap to 120 chars.
export function sanitizeDescription(text) {
  return redactSecrets(text)
    .replace(/\[\[TASK_DONE\]\]/g, '[[task-done]]')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// Lowercase, collapse every run of non-alphanumerics into a single
// dash, and strip leading/trailing dashes. Empty input (or input with
// no alphanumerics) falls back to "skill" so a write always has a
// valid target name.
export function slugifySkill(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LEN)
    .replace(/-+$/g, '');
  return slug || 'skill';
}

// Parse the model's reply into { name, description, body }. The prompt
// asks for two leading `name:` / `description:` lines followed by the
// `## When to Use / ## Procedure / ## Pitfalls / ## Verification`
// sections — but models drift, so we degrade gracefully: when the
// leading lines are missing we derive the name from the first heading
// and leave the description empty. `body` always begins at the first
// markdown heading (the section content), with the name/description
// header stripped.
export function parseSynthOutput(text) {
  const raw = String(text || '').replace(/^﻿/, '').trim();
  const lines = raw.split(/\r?\n/);

  let name = '';
  let description = '';
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SECTION_RE.test(line)) { bodyStart = i; break; }
    const nameM = /^name\s*:\s*(.+)$/i.exec(line.trim());
    if (nameM && !name) { name = nameM[1].trim(); bodyStart = i + 1; continue; }
    const descM = /^description\s*:\s*(.+)$/i.exec(line.trim());
    if (descM && !description) { description = descM[1].trim(); bodyStart = i + 1; continue; }
  }

  const body = lines.slice(bodyStart).join('\n').replace(/^(?:\r?\n)+/, '').trimEnd();

  // No explicit name → derive it from the first heading in the body.
  if (!name) {
    const firstHeading = body.split(/\r?\n/).find((l) => SECTION_RE.test(l));
    if (firstHeading) name = firstHeading.replace(SECTION_RE, '').trim();
  }

  return { name: slugifySkill(name), description, body };
}

// Build a complete SKILL.md: a flat-YAML frontmatter block followed by
// the skill body. The frontmatter shape round-trips through
// skills.parseFrontmatter(). `ts` is injected (not read from the clock)
// so the output is deterministic and testable.
export function assembleSkillDoc({ name, description = '', createdBy = 'agent', sourceTask = '', body = '', version = 1, ts = new Date() } = {}) {
  const date = (ts instanceof Date ? ts : new Date(ts)).toISOString().slice(0, 10);
  const fm = [
    '---',
    `name: ${escapeYaml(stripControl(name))}`,
    `description: ${escapeYaml(description)}`,
    `version: ${version}`,
    `created_by: ${createdBy}`,
  ];
  if (sourceTask) fm.push(`source_task: ${sourceTask}`);
  fm.push(`created_at: ${date}`, '---', '');
  return `${fm.join('\n')}\n${String(body).trim()}\n`;
}

// Drop control characters (incl. newlines) from a single-line frontmatter
// value so an embedded \n can't break out of its key into an injected one.
function stripControl(v) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
}

// Quote a value only when it contains characters our flat parser would
// otherwise choke on (a leading special char or an embedded colon).
// Control characters (including newlines) are stripped first: a quoted
// multi-line value still injects a frontmatter key because the parser
// splits on physical lines, so the only safe move is to flatten to a
// single line before deciding whether to quote.
function escapeYaml(v) {
  const s = stripControl(v);
  if (s === '') return '';
  if (/[:#]/.test(s) || /^[\s'">|&*!%@`-]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

export class SkillSynthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SkillSynthError';
    this.code = code || 'SKILL_SYNTH_ERR';
  }
}

// Run one synthesis LLM call for an agent that just finished a task and
// return { name, description, doc } — a complete SKILL.md ready to
// install — or null when the model produced nothing usable. Mirrors
// agent_memory.reflectOnce(): same provider adapters, a pure text
// completion with no tools advertised, the agent's own role as the
// system prompt. The difference is the ASK — a reusable skill in a
// fixed section layout instead of free-text lessons.
export async function synthesizeSkill({ agent, task, apiKey, baseUrl, fetchImpl } = {}) {
  if (!agent || !task) throw new SkillSynthError('agent and task are required', 'SKILL_SYNTH_BAD_INPUT');

  // Redact secrets from the transcript BEFORE it leaves for the model,
  // so a token pasted into the task never reaches the LLM or the file.
  const transcript = redactSecrets(
    (Array.isArray(task.turns) ? task.turns : [])
      .map((t) => {
        const who = t.agent === 'user' ? 'User' : t.agent === 'system' ? 'System' : t.agent;
        // Defang any forged role label inside the (model-controlled) body
        // so a turn can't inject its own [System]/[User] authority line.
        return `[${who}] ${neutralizeRoleLabels(t.text || '')}`;
      })
      .join('\n\n') || '(no turns)'
  );

  const userMessage =
    `You just finished task "${task.title || '(untitled)'}" (id ${task.id}). Here is the full transcript:\n\n` +
    transcript +
    `\n\nDistil this into a REUSABLE skill that a future agent could load to handle a similar task faster. ` +
    `Reply in EXACTLY this format and nothing else:\n\n` +
    `name: <short kebab-case skill name>\n` +
    `description: <one line, ≤ 120 chars, describing WHEN this skill applies>\n\n` +
    `## When to Use\n<bullet conditions that signal this skill is relevant>\n\n` +
    `## Procedure\n<numbered, concrete steps — real file paths / commands where known>\n\n` +
    `## Pitfalls\n<gotchas and dead-ends you hit, so next time they're avoided>\n\n` +
    `## Verification\n<how to confirm the task actually succeeded>\n\n` +
    `Be concrete and specific to what happened. If the task was too trivial to be worth a reusable skill, reply with the single word NONE.`;

  const text = (await runTextCompletion({
    provider: agent.provider,
    model: agent.model,
    system: agent.role || '',
    userMessage,
    apiKey,
    baseUrl,
    fetchImpl,
  })).trim();
  if (!text || /^none\b/i.test(text)) return null;

  const parsed = parseSynthOutput(text);
  const description = sanitizeDescription(parsed.description);
  const body = sanitizeSkillBody(parsed.body);
  if (!body.trim()) return null;
  const doc = assembleSkillDoc({ name: parsed.name, description, createdBy: 'agent', sourceTask: task.id, body });
  return { name: parsed.name, description, body, doc, sourceTask: task.id };
}

// Install a synthesised skill without ever clobbering a human-authored
// one: reserveSynthName picks a collision-free target (or our own prior
// agent skill, which we then version-bump). Body/description are
// re-sanitised here too so a direct caller (CLI/router) can't bypass
// the redaction + cap. Returns { skill, path, version }.
export function installSynthesized({ name, description = '', body = '', sourceTask = '', createdBy = 'agent' } = {}, configDir, ts = new Date()) {
  // Slugify BEFORE reserving the name so a direct caller (CLI/router)
  // can't smuggle a newline/colon into the filename or inject a second
  // frontmatter key. parseSynthOutput already slugifies, but this path
  // is also reachable directly with an arbitrary name.
  const finalName = skills.reserveSynthName(slugifySkill(name), configDir);
  const overwritingOwn = skills.skillExists(finalName, configDir);
  const version = overwritingOwn ? skills.skillVersion(finalName, configDir) + 1 : 1;
  const doc = assembleSkillDoc({
    name: finalName,
    description: sanitizeDescription(description),
    createdBy,
    sourceTask,
    body: sanitizeSkillBody(body),
    version,
    ts,
  });
  const p = skills.installSkill(finalName, doc, configDir);
  return { skill: finalName, path: p, version };
}
