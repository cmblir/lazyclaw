// sandbox/confiners/bubblewrap.mjs — Linux bwrap wrapper.

import { execFileSync } from 'node:child_process';

export function available() {
  if (process.platform !== 'linux') return false;
  try { execFileSync('bwrap', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

export function buildArgv(argv, opts = {}) {
  const readOnly = opts.readOnly || ['/usr', '/lib', '/lib64', '/bin', '/etc'];
  const readWrite = opts.readWrite || [process.cwd()];
  const allowNet = opts.allowNet === true;
  const out = ['bwrap', '--die-with-parent', '--proc', '/proc', '--dev', '/dev'];
  for (const p of readOnly) out.push('--ro-bind', p, p);
  for (const p of readWrite) out.push('--bind', p, p);
  if (!allowNet) out.push('--unshare-net');
  out.push('--unshare-pid', '--unshare-ipc', '--unshare-uts');
  return [...out, ...argv];
}
