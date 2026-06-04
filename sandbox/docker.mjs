// sandbox/docker.mjs — Docker backend.
//
// Ported from the original single-file sandbox.mjs (v4.3). Behaviour
// is byte-identical for parseSandboxSpec / buildDockerArgs /
// spawnSandboxed; the new piece is the DockerSandbox class that
// implements the §6 Sandbox interface.

import { spawn, spawnSync } from 'node:child_process';
import { Sandbox, SandboxSession, SandboxError } from './base.mjs';

function arrayify(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [String(v)];
}

export function parseSandboxSpec(spec, flags = {}) {
  if (!spec || /^(off|none|-)$/i.test(String(spec))) return null;
  const m = String(spec).match(/^([a-z]+):(.+)$/i);
  if (!m) throw new SandboxError(`bad sandbox spec "${spec}" — expected "docker:<image>"`, 'SANDBOX_BAD_SPEC');
  const [, kind, rest] = m;
  if (kind.toLowerCase() !== 'docker') {
    throw new SandboxError(`unsupported sandbox kind "${kind}" — only "docker" parses via this shim`, 'SANDBOX_UNSUPPORTED');
  }
  return {
    kind: 'docker',
    image: rest.trim(),
    network: flags['sandbox-network'] || 'none',
    mounts: arrayify(flags['sandbox-mount']),
    envPassthrough: arrayify(flags['sandbox-env']),
  };
}

export function buildDockerArgs(spec, [bin, ...binArgs], opts = {}) {
  if (!spec || spec.kind !== 'docker') {
    throw new SandboxError('buildDockerArgs requires a docker spec', 'SANDBOX_BAD_SPEC');
  }
  const cwd = opts.cwd || process.cwd();
  const args = [
    'run', '--rm', '-i',
    '--network', spec.network || 'none',
    '-v', `${cwd}:${cwd}`,
    '-w', cwd,
  ];
  for (const mount of spec.mounts || []) {
    if (!mount.includes(':')) {
      throw new SandboxError(`bad mount "${mount}" — expected host:container[:mode]`, 'SANDBOX_BAD_MOUNT');
    }
    args.push('-v', mount);
  }
  for (const envName of spec.envPassthrough || []) {
    args.push('-e', envName);
  }
  args.push(spec.image, bin, ...binArgs);
  return args;
}

export function spawnSandboxed(spec, bin, args, spawnOpts = {}) {
  if (!spec) return spawn(bin, args, spawnOpts);
  if (spec.kind !== 'docker') {
    throw new SandboxError(`spawnSandboxed shim handles docker only; got "${spec.kind}"`, 'SANDBOX_UNSUPPORTED');
  }
  const dockerArgs = buildDockerArgs(spec, [bin, ...args], { cwd: spawnOpts.cwd });
  return spawn('docker', dockerArgs, spawnOpts);
}

class DockerSession extends SandboxSession {
  constructor(spec) { super(); this.spec = spec; this._closed = false; }

  async exec(argv, opts = {}) {
    const dockerArgv = buildDockerArgs(this.spec, argv, { cwd: opts.cwd });
    const r = spawnSync('docker', dockerArgv, {
      input: opts.input,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: opts.stdio || 'pipe',
      encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  async spawn(argv, opts = {}) {
    return spawnSandboxed(this.spec, argv[0], argv.slice(1), opts);
  }

  async close() { this._closed = true; }
}

export class DockerSandbox extends Sandbox {
  constructor(spec) { super(spec); }
  async open() { return new DockerSession(this.spec); }
  describe() { return `docker · ${this.spec.image} · net=${this.spec.network}`; }
}
