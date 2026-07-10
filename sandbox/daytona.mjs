// sandbox/daytona.mjs — Daytona workspace wrapper.

import { spawn, spawnSync } from 'node:child_process';
import { Sandbox, SandboxSession, SandboxError, composeSessionEnv } from './base.mjs';

export function buildDaytonaArgv(spec, argv) {
  if (!spec || !spec.workspace) {
    throw new SandboxError('daytona sandbox requires workspace', 'SANDBOX_BAD_SPEC');
  }
  const out = ['daytona', 'ssh', spec.workspace];
  if (spec.persistent === false) out.push('--auto-stop=true');
  out.push('--', ...argv);
  return out;
}

class DaytonaSession extends SandboxSession {
  constructor(spec) { super(); this.spec = spec; }
  async exec(argv, opts = {}) {
    const a = buildDaytonaArgv(this.spec, argv);
    const r = spawnSync(a[0], a.slice(1), {
      input: opts.input, env: composeSessionEnv(process.env, opts),
      stdio: opts.stdio || 'pipe', encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }
  async spawn(argv, opts = {}) {
    const a = buildDaytonaArgv(this.spec, argv);
    return spawn(a[0], a.slice(1), {
      ...opts,
      env: composeSessionEnv(process.env, opts),
    });
  }
  async close() {}
}

export class DaytonaSandbox extends Sandbox {
  constructor(spec) { super(spec); }
  async open() { return new DaytonaSession(this.spec); }
  describe() { return `daytona · ${this.spec.workspace}`; }
}
