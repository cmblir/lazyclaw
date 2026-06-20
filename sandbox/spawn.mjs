// sandbox/spawn.mjs — unified spawn dispatcher + auto-confiner.
//
// Bridges the docker-spec shim (used by mas/tools/bash.mjs and
// providers/{claude,codex,gemini}_cli.mjs via sandbox.mjs) with the v5
// confiner backend. Today only docker specs and null are handled by the
// docker.mjs spawnSandboxed; this module adds {kind:'local', confiner:...}
// support by wrapping the child argv via a confiner module.
//
// CAPABILITY-ONLY: no caller passes a local spec yet, so null and docker
// paths are byte-identical to docker.mjs's spawnSandboxed and there is zero
// behaviour change. The default-OFF posture is unchanged.

import { spawn } from 'node:child_process';
import { buildDockerArgs } from './docker.mjs';
import { SandboxError } from './base.mjs';
import * as seatbelt from './confiners/seatbelt.mjs';
import * as bubblewrap from './confiners/bubblewrap.mjs';
import * as firejail from './confiners/firejail.mjs';
import * as landlock from './confiners/landlock.mjs';

const CONFINERS = { seatbelt, bubblewrap, firejail, landlock };

// Process-wide memo of the real-probe result, keyed by platform. Auto-confiner
// selection sits on a hot path (every confined child spawn), so we avoid
// repeated execFileSync probes. The memo is bypassed when an explicit `avail`
// override is supplied (tests need a fresh evaluation per call).
const _probeMemo = new Map();

/**
 * Pick the best available confiner for a platform.
 *
 * @param {{platform?: string, avail?: {seatbelt?: boolean, bubblewrap?: boolean, firejail?: boolean}}} [opts]
 * @returns {'seatbelt'|'bubblewrap'|'firejail'|'none'}
 *   Never returns 'landlock' — it is fail-closed (available() === false).
 */
export function pickAvailableConfiner({ platform = process.platform, avail } = {}) {
  const probe = avail
    ? () => avail
    : () => _probeAvailability(platform);
  const a = probe();
  if (platform === 'darwin') {
    return a.seatbelt ? 'seatbelt' : 'none';
  }
  if (platform === 'linux') {
    if (a.bubblewrap) return 'bubblewrap';
    if (a.firejail) return 'firejail';
    return 'none';
  }
  return 'none';
}

function _probeAvailability(platform) {
  if (_probeMemo.has(platform)) return _probeMemo.get(platform);
  const a = {
    seatbelt: seatbelt.available({ platform }),
    bubblewrap: bubblewrap.available(),
    firejail: firejail.available(),
  };
  _probeMemo.set(platform, a);
  return a;
}

/**
 * Build the WRAPPED argv for a {kind:'local'} spec WITHOUT spawning, so it is
 * unit-testable.
 *
 * @param {{kind:'local', confiner?: string} & Record<string, unknown>} spec
 * @param {string} bin
 * @param {string[]} args
 * @returns {string[]} the wrapped argv ([bin, ...args] when confiner is none)
 */
export function buildLocalArgv(spec, bin, args) {
  const requested = spec.confiner === 'auto'
    ? pickAvailableConfiner()
    : (spec.confiner || 'none');
  if (requested === 'none') return [bin, ...args];
  const mod = CONFINERS[requested];
  if (!mod) {
    throw new SandboxError(`unknown confiner "${requested}"`, 'SANDBOX_BAD_CONFINER');
  }
  // landlock is fail-closed: its buildArgv throws. Do NOT special-case it.
  return mod.buildArgv([bin, ...args], spec);
}

/**
 * Spawn a child under the requested sandbox spec.
 *
 *  - null          → bare spawn (byte-identical to docker.mjs today)
 *  - kind 'docker' → spawn('docker', buildDockerArgs(...)) (byte-identical)
 *  - kind 'local'  → wrap argv via confiner, then spawn the wrapper
 *  - anything else → SANDBOX_UNSUPPORTED
 *
 * @param {object|null} spec
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [spawnOpts]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnSandboxed(spec, bin, args, spawnOpts = {}) {
  if (!spec) return spawn(bin, args, spawnOpts);
  if (spec.kind === 'docker') {
    const dockerArgs = buildDockerArgs(spec, [bin, ...args], { cwd: spawnOpts.cwd });
    return spawn('docker', dockerArgs, spawnOpts);
  }
  if (spec.kind === 'local') {
    const wrapped = buildLocalArgv(spec, bin, args);
    return spawn(wrapped[0], wrapped.slice(1), spawnOpts);
  }
  throw new SandboxError(
    `spawnSandboxed shim handles docker+local only; got "${spec.kind}"`,
    'SANDBOX_UNSUPPORTED',
  );
}
