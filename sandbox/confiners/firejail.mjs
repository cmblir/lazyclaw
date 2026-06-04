// sandbox/confiners/firejail.mjs — firejail wrapper.

import { execFileSync } from 'node:child_process';

export function available() {
  if (process.platform !== 'linux') return false;
  try { execFileSync('firejail', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

export function buildArgv(argv, opts = {}) {
  const allowNet = opts.allowNet === true;
  const out = ['firejail', '--quiet', '--private', '--caps.drop=all'];
  out.push(allowNet ? '--net=eth0' : '--net=none');
  return [...out, ...argv];
}
