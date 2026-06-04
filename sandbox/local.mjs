// sandbox/local.mjs — Local backend with pluggable confiner.
// Spec §0.1 C8: confiner ∈ {none, seatbelt, bubblewrap, firejail, landlock}.

import { spawn, spawnSync } from 'node:child_process';
import { Sandbox, SandboxSession, SandboxError } from './base.mjs';
import * as seatbelt from './confiners/seatbelt.mjs';
import * as bubblewrap from './confiners/bubblewrap.mjs';
import * as firejail from './confiners/firejail.mjs';
import * as landlock from './confiners/landlock.mjs';

const CONFINERS = { seatbelt, bubblewrap, firejail, landlock };

class LocalSession extends SandboxSession {
  constructor(spec, confinerMod) {
    super();
    this.spec = spec;
    this.confiner = confinerMod;
  }

  _wrap(argv) {
    if (!this.confiner) return [...argv];
    return this.confiner.buildArgv(argv, this.spec);
  }

  async exec(argv, opts = {}) {
    const wrapped = this._wrap(argv);
    const r = spawnSync(wrapped[0], wrapped.slice(1), {
      input: opts.input,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: opts.stdio || 'pipe',
      encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  async spawn(argv, opts = {}) {
    const wrapped = this._wrap(argv);
    return spawn(wrapped[0], wrapped.slice(1), opts);
  }

  async close() { /* no resources */ }
}

export class LocalSandbox extends Sandbox {
  constructor(spec) {
    super(spec);
    const key = spec.confiner || 'none';
    if (key !== 'none' && !(key in CONFINERS)) {
      throw new SandboxError(`unknown confiner "${key}"`, 'SANDBOX_BAD_CONFINER');
    }
    this.confiner = key === 'none' ? null : CONFINERS[key];
  }

  async open() { return new LocalSession(this.spec, this.confiner); }
  describe() {
    return `local · confiner=${this.spec.confiner || 'none'}`;
  }
}
