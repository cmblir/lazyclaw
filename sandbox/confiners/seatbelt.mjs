// sandbox/confiners/seatbelt.mjs — macOS sandbox-exec wrapper.
// Spec §0.1 C8: local.confiner sub-option.

import { execFileSync } from 'node:child_process';

// Probe whether a usable `sandbox-exec` is present. The argument object is a
// test seam: `platform` overrides the OS gate and `probe` overrides the real
// invocation so the try/catch semantics are verifiable without a host sandbox.
export function available({ platform = process.platform, probe = _realProbe } = {}) {
  if (platform !== 'darwin') return false;
  try { probe(); return true; }
  catch { return false; }
}

// Run a no-op (`/usr/bin/true`) under a permissive profile. This actually
// exercises the sandboxing path. NOTE: `-h` is NOT a help flag on macOS — it is
// an illegal option that exits non-zero, so the previous `sandbox-exec -h`
// probe reported seatbelt unavailable on every mac.
function _realProbe() {
  execFileSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' });
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

// Temp dirs are always writable — interpreters and tools need scratch space, and
// confining writes to the workspace alone breaks too much (e.g. node/npm caches).
const TMP_WRITABLE = ['/tmp', '/private/tmp', '/private/var/folders'];

// Build a FILESYSTEM-CONFINEMENT profile, not a strict deny-default one. A
// `(deny default)` profile silently kills dynamically-linked binaries (python3,
// node, git) at the dyld/mach bootstrap stage on modern macOS — confinement that
// breaks every real interpreter is worse than none. Instead we start from
// `(allow default)` and carve out the high-value protections: writes are denied
// everywhere except the workspace + temp, and named secret dirs stay unreadable
// even though reads are otherwise allowed. Network is allowed unless opts.allowNet
// is explicitly false.
//
//   opts.readWrite : string[]  workspace roots that may be written (default [cwd])
//   opts.denyRead  : string[]  dirs whose reads are blocked (e.g. ~/.ssh, ~/.aws)
//   opts.allowNet  : boolean   default false → adds (deny network*)
export function buildArgv(argv, opts = {}) {
  const readWrite = opts.readWrite || [process.cwd()];
  const denyRead = opts.denyRead || [];
  const allowNet = opts.allowNet === true;
  const writable = [...TMP_WRITABLE, ...readWrite];
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map(p => `(subpath "${sbplPath(p)}")`).join(' ')})`,
    ...denyRead.map(p => `(deny file-read* (subpath "${sbplPath(p)}"))`),
    ...(allowNet ? [] : ['(deny network*)']),
  ].join('\n');
  return ['sandbox-exec', '-p', profile, ...argv];
}
