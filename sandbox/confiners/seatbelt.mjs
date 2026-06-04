// sandbox/confiners/seatbelt.mjs — macOS sandbox-exec wrapper.
// Spec §0.1 C8: local.confiner sub-option.

import { execFileSync } from 'node:child_process';

export function available() {
  if (process.platform !== 'darwin') return false;
  try { execFileSync('sandbox-exec', ['-h'], { stdio: 'ignore' }); return true; }
  catch { return false; }
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
    ...readOnly.map(p => `(allow file-read* (subpath "${p}"))`),
    ...readWrite.map(p => `(allow file-read* file-write* (subpath "${p}"))`),
  ].join('\n');
  return ['sandbox-exec', '-p', profile, ...argv];
}
