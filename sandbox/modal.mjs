// sandbox/modal.mjs — Modal CLI + idle-hibernation wake hook.

import { spawn, spawnSync } from 'node:child_process';
import { Sandbox, SandboxSession, SandboxError, composeSessionEnv } from './base.mjs';

export function buildModalArgv(spec, argv) {
  if (!spec || !spec.app) {
    throw new SandboxError('modal sandbox requires app name', 'SANDBOX_BAD_SPEC');
  }
  const out = ['modal', 'run', '--detach=false'];
  if (spec.region) out.push('--region', spec.region);
  out.push(spec.app, '--', ...argv);
  return out;
}

export function idleWakeUrl(spec) {
  const app = encodeURIComponent(spec.app || '');
  const tok = encodeURIComponent(spec.token || '');
  const host = spec.host || 'pompos-edge.modal.run';
  return `https://${host}/wake?app=${app}&token=${tok}`;
}

async function maybeWake(spec) {
  if (!spec.idleWake || !spec.token) return;
  try {
    await fetch(idleWakeUrl(spec), { method: 'POST' });
  } catch { /* best effort; modal cold-start handles rest */ }
}

class ModalSession extends SandboxSession {
  constructor(spec) { super(); this.spec = spec; }
  async exec(argv, opts = {}) {
    await maybeWake(this.spec);
    const a = buildModalArgv(this.spec, argv);
    const r = spawnSync(a[0], a.slice(1), {
      input: opts.input, env: composeSessionEnv(process.env, opts),
      stdio: opts.stdio || 'pipe', encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }
  async spawn(argv, opts = {}) {
    await maybeWake(this.spec);
    const a = buildModalArgv(this.spec, argv);
    return spawn(a[0], a.slice(1), {
      ...opts,
      env: composeSessionEnv(process.env, opts),
    });
  }
  async close() {}
}

export class ModalSandbox extends Sandbox {
  constructor(spec) { super(spec); }
  async open() { return new ModalSession(this.spec); }
  describe() { return `modal · app=${this.spec.app}`; }
}
