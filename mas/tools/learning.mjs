// learning — agent tools that read/write the skill bank, layered memory,
// and the persistent USER.md (Honcho-equivalent, spec §1.6, §4.10).
// USER.md path canonical (C6) = <configDir>/memory/USER.md.

import fs from 'node:fs';
import path from 'node:path';

function resolveConfigDir(ctx) {
  return ctx?.configDir || process.env.LAZYCLAW_CONFIG_DIR || path.join(process.env.HOME || '.', '.lazyclaw');
}

function skillsDir(ctx) { return path.join(resolveConfigDir(ctx), 'skills'); }
function memoryDir(ctx) { return path.join(resolveConfigDir(ctx), 'memory'); }
function userMdPath(ctx) { return path.join(memoryDir(ctx), 'USER.md'); }

const skill_view = {
  name: 'skill_view', category: 'learning', sensitive: false,
  description: 'Return the body of an installed skill (by name).',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  async exec(args, ctx) {
    if (!args?.name) return { ok: false, error: 'skill_view: name required' };
    const file = path.join(skillsDir(ctx), args.name, 'SKILL.md');
    if (!fs.existsSync(file)) return { ok: false, error: `skill_view: ${args.name} not installed` };
    return { ok: true, name: args.name, content: fs.readFileSync(file, 'utf8') };
  },
};

const skill_create = {
  name: 'skill_create', category: 'learning', sensitive: true,
  description: 'Create a new skill at <configDir>/skills/<name>/SKILL.md. Fails if already exists.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' }, body: { type: 'string' },
      description: { type: 'string' }, group: { type: 'string' },
    },
    required: ['name', 'body'],
  },
  async exec(args, ctx) {
    if (!args?.name || !args?.body) return { ok: false, error: 'skill_create: name + body required' };
    if (!/^[a-z0-9][a-z0-9-]*$/.test(args.name)) return { ok: false, error: 'skill_create: kebab-case name only' };
    const dir = path.join(skillsDir(ctx), args.name);
    const file = path.join(dir, 'SKILL.md');
    if (fs.existsSync(file)) return { ok: false, error: `skill_create: ${args.name} already exists; use skill_edit` };
    fs.mkdirSync(dir, { recursive: true });
    const fm = [
      '---',
      `name: ${args.name}`,
      `description: ${args.description || args.body.split('\n')[0].slice(0, 200)}`,
      `group: ${args.group || (args.name.includes('-') ? args.name.split('-')[0] : 'legacy')}`,
      'version: 1',
      'trained_by: user',
      `created_at: ${new Date().toISOString().slice(0, 10)}`,
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(file, fm + args.body + (args.body.endsWith('\n') ? '' : '\n'));
    return { ok: true, name: args.name, file };
  },
};

const skill_edit = {
  name: 'skill_edit', category: 'learning', sensitive: true,
  description: 'Replace the body of an existing skill. Preserves frontmatter, bumps version.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' }, body: { type: 'string' } },
    required: ['name', 'body'],
  },
  async exec(args, ctx) {
    const file = path.join(skillsDir(ctx), args.name, 'SKILL.md');
    if (!fs.existsSync(file)) return { ok: false, error: `skill_edit: ${args.name} not installed` };
    const src = fs.readFileSync(file, 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src);
    if (!m) return { ok: false, error: 'skill_edit: missing frontmatter' };
    let fm = m[1];
    fm = fm.replace(/version:\s*(\d+)/, (_, v) => `version: ${Number(v) + 1}`);
    fs.writeFileSync(file, `---\n${fm}\n---\n${args.body}${args.body.endsWith('\n') ? '' : '\n'}`);
    return { ok: true, name: args.name };
  },
};

const memory_write = {
  name: 'memory_write', category: 'learning', sensitive: true,
  description: 'Append to layered memory. kind=recent appends a JSONL line; kind=core overwrites core.md; kind=episodic writes episodic/<topic>.md.',
  parameters: {
    type: 'object',
    properties: {
      kind:    { type: 'string', enum: ['recent', 'core', 'episodic'] },
      content: { type: 'string' },
      topic:   { type: 'string' },
    },
    required: ['kind', 'content'],
  },
  async exec(args, ctx) {
    const dir = memoryDir(ctx);
    fs.mkdirSync(dir, { recursive: true });
    if (args.kind === 'recent') {
      fs.appendFileSync(path.join(dir, 'recent.jsonl'), JSON.stringify({ ts: Date.now(), content: args.content }) + '\n');
    } else if (args.kind === 'core') {
      fs.writeFileSync(path.join(dir, 'core.md'), args.content);
    } else if (args.kind === 'episodic') {
      if (!args.topic) return { ok: false, error: 'memory_write: topic required for episodic' };
      fs.mkdirSync(path.join(dir, 'episodic'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'episodic', `${args.topic}.md`), args.content);
    } else {
      return { ok: false, error: `memory_write: unknown kind ${args.kind}` };
    }
    return { ok: true, kind: args.kind };
  },
};

const memory_read = {
  name: 'memory_read', category: 'learning', sensitive: false,
  description: 'Read layered memory. kind=recent returns last N JSONL entries; kind=core returns core.md; kind=episodic returns episodic/<topic>.md.',
  parameters: {
    type: 'object',
    properties: {
      kind:  { type: 'string', enum: ['recent', 'core', 'episodic'] },
      topic: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['kind'],
  },
  async exec(args, ctx) {
    const dir = memoryDir(ctx);
    if (args.kind === 'recent') {
      const f = path.join(dir, 'recent.jsonl');
      if (!fs.existsSync(f)) return { ok: true, entries: [] };
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
      const limit = Math.max(1, Math.min(200, args.limit || 20));
      return { ok: true, entries: lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return { content: l }; } }) };
    }
    if (args.kind === 'core') {
      const f = path.join(dir, 'core.md');
      return { ok: true, content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' };
    }
    if (args.kind === 'episodic') {
      if (!args.topic) return { ok: false, error: 'memory_read: topic required for episodic' };
      const f = path.join(dir, 'episodic', `${args.topic}.md`);
      return { ok: true, content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' };
    }
    return { ok: false, error: `memory_read: unknown kind ${args.kind}` };
  },
};

const user_view = {
  name: 'user_view', category: 'learning', sensitive: false,
  description: 'Read the persistent USER.md (Honcho-equivalent user model).',
  parameters: { type: 'object', properties: {} },
  async exec(_args, ctx) {
    const f = userMdPath(ctx);
    return { ok: true, content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' };
  },
};

const user_update = {
  name: 'user_update', category: 'learning', sensitive: true,
  description: 'Overwrite USER.md (the persistent user model). Use sparingly — usually the user_modeler does this.',
  parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
  async exec(args, ctx) {
    fs.mkdirSync(memoryDir(ctx), { recursive: true });
    fs.writeFileSync(userMdPath(ctx), args.content);
    return { ok: true, path: userMdPath(ctx) };
  },
};

export const TOOLS = [skill_view, skill_create, skill_edit, memory_write, memory_read, user_view, user_update];
