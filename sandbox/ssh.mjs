// sandbox/ssh.mjs — Remote exec via OpenSSH with ControlMaster reuse.
//
// The wrapper deliberately avoids node-ssh's reconnect logic — we
// rely on OpenSSH's ControlMaster/ControlPersist so multiple exec()
// calls share one TCP connection. node-ssh is imported lazily and
// only used for streaming spawn() because spawnSync over Control-
// Master is enough for short tool calls.

import { spawn, spawnSync } from 'node:child_process';
import { Sandbox, SandboxSession, SandboxError, composeSessionEnv } from './base.mjs';

export function buildSshArgv(spec, argv) {
  if (!spec || !spec.host) throw new SandboxError('ssh sandbox requires host', 'SANDBOX_BAD_SPEC');
  const userHost = spec.user ? `${spec.user}@${spec.host}` : spec.host;
  const out = ['ssh',
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=~/.ssh/cm-%h-%p-%r',
    '-o', 'ControlPersist=10m',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (spec.identityFile) out.push('-i', spec.identityFile);
  if (spec.port) out.push('-p', String(spec.port));
  out.push(userHost, argv.join(' '));
  return out;
}

class SshSession extends SandboxSession {
  constructor(spec) { super(); this.spec = spec; }

  async exec(argv, opts = {}) {
    const sshArgv = buildSshArgv(this.spec, argv);
    const r = spawnSync(sshArgv[0], sshArgv.slice(1), {
      input: opts.input,
      env: composeSessionEnv(process.env, opts),
      stdio: opts.stdio || 'pipe',
      encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  async spawn(argv, opts = {}) {
    const sshArgv = buildSshArgv(this.spec, argv);
    return spawn(sshArgv[0], sshArgv.slice(1), {
      ...opts,
      env: composeSessionEnv(process.env, opts),
    });
  }

  async close() { /* ControlPersist handles socket lifecycle */ }
}

export class SshSandbox extends Sandbox {
  constructor(spec) { super(spec); }
  async open() { return new SshSession(this.spec); }
  describe() {
    const u = this.spec.user ? `${this.spec.user}@${this.spec.host}` : this.spec.host;
    return `ssh · ${u}`;
  }
}
