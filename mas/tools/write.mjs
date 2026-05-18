// Write tool — overwrites or creates a file with the given content.
//
// Creates parent directories as needed. Atomic-ish: writes to <path>.tmp
// then renames over the target so a crash mid-write doesn't leave a
// partially-written file.

import fs from 'node:fs';
import path from 'node:path';

export const NAME = 'write';
export const DESCRIPTION = 'Create or overwrite a file with the given UTF-8 content. Returns {bytesWritten, path}.';
export const PARAMETERS = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Relative or absolute path to write.' },
    content: { type: 'string', description: 'The new file contents (UTF-8).' },
  },
  required: ['path', 'content'],
};

export async function exec(args, { cwd = process.cwd() } = {}) {
  if (!args || typeof args.path !== 'string' || !args.path) {
    return { ok: false, error: 'write: path is required' };
  }
  if (typeof args.content !== 'string') {
    return { ok: false, error: 'write: content must be a string' };
  }
  const resolved = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const tmp = resolved + '.tmp';
    fs.writeFileSync(tmp, args.content);
    fs.renameSync(tmp, resolved);
    return {
      ok: true,
      path: resolved,
      bytesWritten: Buffer.byteLength(args.content, 'utf8'),
    };
  } catch (err) {
    return { ok: false, error: `write: ${err?.message || err}` };
  }
}
