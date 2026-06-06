// sandbox/confiners/seatbelt.mjs — macOS sandbox-exec wrapper.
// Spec §0.1 C8: local.confiner sub-option.

import { execFileSync } from 'node:child_process';

export function available() {
  if (process.platform !== 'darwin') return false;
  try { execFileSync('sandbox-exec', ['-h'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// Escape a path for an SBPL double-quoted string literal. Without this a path
// containing `"` (or a backslash) could close the string and inject arbitrary
// SBPL directives — e.g. re-enabling `(allow network*)` or widening file
// access — neutering the sandbox. Reject control characters outright; escape
// backslash and double-quote.
function sbplPath(p) {
  const s = String(p);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new Error('seatbelt: path contains control characters; refusing to build profile');
    }
  }
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildArgv(argv, opts = {}) {
  const readOnly = opts.readOnly || [];
  const readWrite = opts.readWrite || [process.cwd()];
  const allowNet = opts.allowNet === true;
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal)',
    '(allow sysctl-read)',
    allowNet ? '(allow network*)' : '(deny network*)',
    ...readOnly.map(p => `(allow file-read* (subpath "${sbplPath(p)}"))`),
    ...readWrite.map(p => `(allow file-read* file-write* (subpath "${sbplPath(p)}"))`),
  ].join('\n');
  return ['sandbox-exec', '-p', profile, ...argv];
}
