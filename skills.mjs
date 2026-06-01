// Skills are markdown files in <configDir>/skills/<name>.md whose contents
// are prepended to the system prompt when chat or agent runs with --skill.
//
// This is the OpenClaw "skill" concept reduced to its load-bearing core:
// reusable instruction bundles, named, locally stored, no remote registry.
//
// Why .md and not JSON-with-content: skills are written by humans for
// humans, and markdown keeps headers / lists / code blocks readable both
// in the file system and inside the model prompt.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SKILLS_DIRNAME = 'skills';
const SKILL_EXT = '.md';

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

export function skillsDir(configDir = defaultConfigDir()) {
  return path.join(configDir, SKILLS_DIRNAME);
}

export function skillPath(name, configDir = defaultConfigDir()) {
  if (!name || /[/\\]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
    throw new Error(`invalid skill name: ${name}`);
  }
  return path.join(skillsDir(configDir), `${name}${SKILL_EXT}`);
}

export function listSkills(configDir = defaultConfigDir()) {
  const dir = skillsDir(configDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith(SKILL_EXT))
    .map(name => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      let content = '';
      try { content = fs.readFileSync(full, 'utf8'); } catch { /* unreadable → empty */ }
      const { meta, body } = parseFrontmatter(content);
      // Prefer the agent-/author-supplied frontmatter description; fall
      // back to the first markdown heading for legacy frontmatter-less
      // skills so the index still reads sensibly.
      const summary = (meta.description || firstHeading(body) || '').slice(0, 120);
      return {
        name: name.slice(0, -SKILL_EXT.length),
        path: full,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        summary,
        description: meta.description || '',
        createdBy: meta.created_by || '',
        version: meta.version || '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Parse a leading YAML frontmatter block (--- … ---). Only the flat
// `key: value` shape skills use is supported — no nested YAML — which
// keeps us dependency-free. Returns { meta, body }; when no frontmatter
// is present meta is {} and body is the untouched content.
export function parseFrontmatter(content) {
  const text = String(content ?? '');
  if (!text.startsWith('---')) return { meta: {}, body: text };
  // The opening fence must be its own line.
  const afterOpen = text.slice(3);
  if (!/^\r?\n/.test(afterOpen)) return { meta: {}, body: text };
  const closeRe = /\r?\n---[ \t]*(?:\r?\n|$)/;
  const m = closeRe.exec(afterOpen);
  if (!m) return { meta: {}, body: text };
  const block = afterOpen.slice(0, m.index);
  // Drop blank lines between the closing fence and the first body line
  // so callers can rely on body starting at real content.
  const body = afterOpen.slice(m.index + m[0].length).replace(/^(?:\r?\n)+/, '');
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!mm) continue;
    let val = mm[2].trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      // Symmetric with skill_synth's escapeYaml double-quote escaping.
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (val.length >= 2 && val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }
    meta[mm[1]] = val;
  }
  return { meta, body };
}

function firstHeading(body) {
  for (const line of String(body || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    return t.replace(/^#+\s*/, '');
  }
  return '';
}

// Compact "Level 0" recall index: one `- <name>: <summary>` line per
// installed skill, sorted by name. Returns '' when no skills exist so
// callers can inject it conditionally. This is what gets dropped into
// the system prompt so the model knows which skills exist without
// paying for their full bodies (progressive disclosure — the model
// pulls a full skill on demand via the skill_view tool).
export function skillsIndex(configDir = defaultConfigDir()) {
  const skills = listSkills(configDir);
  if (!skills.length) return '';
  return skills.map((s) => `- ${s.name}: ${s.summary}`.trimEnd()).join('\n');
}

export function loadSkill(name, configDir = defaultConfigDir()) {
  const p = skillPath(name, configDir);
  if (!fs.existsSync(p)) throw new Error(`skill not found: ${name}`);
  return fs.readFileSync(p, 'utf8');
}

export function installSkill(name, content, configDir = defaultConfigDir()) {
  const p = skillPath(name, configDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

export function removeSkill(name, configDir = defaultConfigDir()) {
  const p = skillPath(name, configDir);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export function skillExists(name, configDir = defaultConfigDir()) {
  try { return fs.existsSync(skillPath(name, configDir)); }
  catch { return false; }
}

// Read the integer `version` from a skill's frontmatter (0 when the
// skill is missing or carries no version).
export function skillVersion(name, configDir = defaultConfigDir()) {
  try {
    const { meta } = parseFrontmatter(fs.readFileSync(skillPath(name, configDir), 'utf8'));
    return parseInt(meta.version, 10) || 0;
  } catch { return 0; }
}

// Reserve a target name for an agent-synthesised skill that NEVER
// clobbers a human-authored skill. If the slug is free, use it. If a
// skill with that slug already exists AND it was itself agent-authored
// (created_by: agent), reuse it — that's the self-improvement update
// path. Otherwise the slug belongs to a human/curated skill, so we
// append a numeric suffix and try again. This is the security boundary
// that stops LLM-chosen slugs from overwriting trusted skills.
export function reserveSynthName(name, configDir = defaultConfigDir()) {
  const base = (name && String(name).trim()) || 'skill';
  let candidate = base;
  for (let i = 1; i < 1000; i++) {
    let p;
    try { p = skillPath(candidate, configDir); }
    catch { return base; }
    if (!fs.existsSync(p)) return candidate;
    let createdBy = '';
    try { createdBy = parseFrontmatter(fs.readFileSync(p, 'utf8')).meta.created_by || ''; }
    catch { /* unreadable → treat as occupied */ }
    if (createdBy === 'agent') return candidate;   // overwrite our own = improve
    candidate = `${base}-${i}`;
  }
  return candidate;
}

/**
 * Compose the system prompt for a chat/agent invocation. Concatenates each
 * named skill's contents with a separator, in the order given. Returns null
 * when no skills are requested so the caller can pass through unchanged.
 *
 * @param {string[]} names
 * @param {string} [configDir]
 */
export function composeSystemPrompt(names, configDir = defaultConfigDir()) {
  if (!names || names.length === 0) return null;
  const blocks = [];
  for (const n of names) {
    const trimmed = String(n || '').trim();
    if (!trimmed) continue;
    const body = loadSkill(trimmed, configDir);
    blocks.push(`<!-- skill: ${trimmed} -->\n${body.trim()}`);
  }
  return blocks.length ? blocks.join('\n\n---\n\n') : null;
}
