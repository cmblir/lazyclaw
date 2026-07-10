// sandbox/singularity.mjs — apptainer / singularity exec wrapper.

import { spawn, spawnSync } from 'node:child_process';
import { Sandbox, SandboxSession, SandboxError, composeSessionEnv } from './base.mjs';

export function buildSingularityArgv(spec, argv) {
  if (!spec || !spec.image) {
    throw new SandboxError('singularity sandbox requires image', 'SANDBOX_BAD_SPEC');
  }
  const bin = spec.useApptainer === false ? 'singularity' : 'apptainer';
  const out = [bin, 'exec'];
  for (const b of spec.bind || []) out.push('--bind', b);
  if (!spec.net) out.push('--net', '--network=none');
  out.push(spec.image, ...argv);
  return out;
}

class SingularitySession extends SandboxSession {
  constructor(spec) { super(); this.spec = spec; }
  async exec(argv, opts = {}) {
    const a = buildSingularityArgv(this.spec, argv);
    const r = spawnSync(a[0], a.slice(1), {
      input: opts.input, env: composeSessionEnv(process.env, opts),
      stdio: opts.stdio || 'pipe', encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }
  async spawn(argv, opts = {}) {
    const a = buildSingularityArgv(this.spec, argv);
    return spawn(a[0], a.slice(1), {
      ...opts,
      env: composeSessionEnv(process.env, opts),
    });
  }
  async close() {}
}

export class SingularitySandbox extends Sandbox {
  constructor(spec) { super(spec); }
  async open() { return new SingularitySession(this.spec); }
  describe() { return `singularity · ${this.spec.image}`; }
}
