// edit — find/replace exactly one occurrence of `old` with `new` inside a file
// rooted at the agent cwd. Refuses when `old` is missing or not unique so the
// LLM cannot silently overwrite the wrong span (spec §7 sub-bullet 1).

import fs from 'node:fs';
import path from 'node:path';

export const TOOL = {
  name: 'edit',
  category: 'fs',
  sensitive: true,
  description: 'Replace exactly one occurrence of `old` with `new` inside a workspace file. Fails if `old` is missing or appears more than once.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to cwd.' },
      old:  { type: 'string', description: 'Exact substring to replace.' },
      new:  { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'old', 'new'],
  },
  async exec(args, { cwd = process.cwd() } = {}) {
    if (!args || typeof args.path !== 'string') return { ok: false, error: 'edit: path required' };
    if (typeof args.old !== 'string' || typeof args.new !== 'string') return { ok: false, error: 'edit: old/new strings required' };
    const abs = path.resolve(cwd, args.path);
    if (!abs.startsWith(path.resolve(cwd))) return { ok: false, error: 'edit: path escapes workspace' };
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return { ok: false, error: `edit: ${e.message}` }; }
    const idx = src.indexOf(args.old);
    if (idx === -1) return { ok: false, error: `edit: \`old\` not found in ${args.path}` };
    if (src.indexOf(args.old, idx + 1) !== -1) return { ok: false, error: `edit: \`old\` not unique in ${args.path}` };
    const next = src.slice(0, idx) + args.new + src.slice(idx + args.old.length);
    fs.writeFileSync(abs, next);
    return { ok: true, path: args.path, bytesWritten: Buffer.byteLength(next) };
  },
};
