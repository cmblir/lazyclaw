// sandbox/base.mjs — Sandbox + SandboxSession contracts.
//
// Spec ref: §0.1 C8 (6-enum), §6 (backend contract).
// Every backend module (docker/local/ssh/singularity/modal/daytona)
// exports a class extending Sandbox and returns SandboxSession from
// open(). The session is the only object that holds resources
// (sockets, child PIDs, remote workspace ids) — caller MUST call
// close() in a finally block.

import { scrubEnv } from '../mas/scrub_env.mjs';

export const SANDBOX_KINDS = Object.freeze([
  'local', 'docker', 'ssh', 'singularity', 'modal', 'daytona',
]);

/**
 * Compose the environment for a session child spawn, scrubbed of secrets.
 *
 * Every backend (local/docker/ssh/singularity/modal/daytona) previously
 * merged `{...process.env, ...opts.env}` UNSCRUBBED — so ssh/modal/singularity/
 * daytona shipped the operator's full env (API keys, tokens, connection
 * strings) to a remote host or container by default. Routing every site
 * through this helper closes that leak with the SAME scrubEnv the bash tool
 * uses, so secret-bearing keys are dropped from both the parent env and any
 * caller-supplied `opts.env`, while operational vars (PATH, HOME, …) survive.
 *
 * @param {Record<string,string>} [parentEnv] typically process.env
 * @param {{env?: Record<string,string>}} [opts] per-call session options
 * @returns {Record<string,string>} scrubbed env for the child
 */
export function composeSessionEnv(parentEnv = process.env, opts = {}) {
  return scrubEnv({ ...parentEnv, ...(opts.env || {}) });
}

export class SandboxError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SandboxError';
    this.code = code || 'SANDBOX_ERR';
  }
  toString() {
    return `${this.name}[${this.code}]: ${this.message}`;
  }
}

export class Sandbox {
  /**
   * @param {{kind: string} & Record<string, unknown>} spec
   * @param {{_skipAbstract?: boolean}} [opts]
   */
  constructor(spec, opts = {}) {
    if (new.target === Sandbox && !opts._skipAbstract) {
      throw new SandboxError(
        'Sandbox is abstract — instantiate a backend subclass',
        'SANDBOX_ABSTRACT',
      );
    }
    if (!spec || !SANDBOX_KINDS.includes(spec.kind)) {
      throw new SandboxError(
        `unknown sandbox kind "${spec && spec.kind}" — expected one of ${SANDBOX_KINDS.join(', ')}`,
        'SANDBOX_BAD_KIND',
      );
    }
    this.spec = spec;
  }

  /**
   * Open a session. Subclasses MUST override.
   * @returns {Promise<SandboxSession>}
   */
  async open() {
    throw new SandboxError(`${this.constructor.name}.open() not implemented`, 'SANDBOX_NOT_IMPL');
  }

  /** Short human label for `pompos sandbox list`. */
  describe() { return `${this.spec.kind}`; }
}

export class SandboxSession {
  /**
   * Run an argv inside the sandbox.
   * @param {string[]} argv
   * @param {{cwd?: string, env?: Record<string,string>, stdio?: 'pipe'|'inherit', input?: string}} [opts]
   * @returns {Promise<{code: number, stdout: string, stderr: string}>}
   */
  async exec(_argv, _opts) {
    throw new SandboxError(`${this.constructor.name}.exec() not implemented`, 'SANDBOX_NOT_IMPL');
  }

  /**
   * Spawn a long-running child within the sandbox. Returns a
   * node:child_process-shaped object with stdin/stdout/stderr.
   * Default: synthesise from exec() via streaming if backend allows.
   */
  async spawn(_argv, _opts) {
    throw new SandboxError(`${this.constructor.name}.spawn() not implemented`, 'SANDBOX_NOT_IMPL');
  }

  /** Release resources. Idempotent. */
  async close() {
    throw new SandboxError(`${this.constructor.name}.close() not implemented`, 'SANDBOX_NOT_IMPL');
  }
}
