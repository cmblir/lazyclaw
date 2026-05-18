// Read tool — reads a file (UTF-8) from the agent's workspace.
//
// Paths are resolved relative to the workspace cwd. Absolute paths are
// allowed (the user opted into "lazyclaw 모든 권한"). Use the bash tool
// to read binary blobs.

import fs from 'node:fs';
import path from 'node:path';

export const NAME = 'read';
export const DESCRIPTION = 'Read a file from disk (UTF-8). Returns the file contents or an error.';
export const PARAMETERS = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Relative or absolute path to the file.' },
    maxBytes: { type: 'number', description: 'Optional cap; default 500 KB. Larger files are truncated.' },
  },
  required: ['path'],
};

const DEFAULT_MAX_BYTES = 500_000;

export async function exec(args, { cwd = process.cwd() } = {}) {
  if (!args || typeof args.path !== 'string' || !args.path) {
    return { ok: false, error: 'read: path is required' };
  }
  const max = Math.max(1024, Math.min(Number.isFinite(+args.maxBytes) ? +args.maxBytes : DEFAULT_MAX_BYTES, 5_000_000));
  const resolved = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { ok: false, error: `read: not a regular file: ${resolved}` };
    const buf = fs.readFileSync(resolved);
    const truncated = buf.length > max;
    const slice = truncated ? buf.subarray(0, max) : buf;
    return {
      ok: true,
      path: resolved,
      bytes: stat.size,
      content: slice.toString('utf8'),
      truncated,
    };
  } catch (err) {
    return { ok: false, error: `read: ${err?.message || err}` };
  }
}
