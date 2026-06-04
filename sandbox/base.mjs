// sandbox/base.mjs — Sandbox + SandboxSession contracts.
//
// Spec ref: §0.1 C8 (6-enum), §6 (backend contract).
// Every backend module (docker/local/ssh/singularity/modal/daytona)
// exports a class extending Sandbox and returns SandboxSession from
// open(). The session is the only object that holds resources
// (sockets, child PIDs, remote workspace ids) — caller MUST call
// close() in a finally block.

export const SANDBOX_KINDS = Object.freeze([
  'local', 'docker', 'ssh', 'singularity', 'modal', 'daytona',
]);

export class SandboxError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SandboxError';
    this.code = code || 'SANDBOX_ERR';
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

  /** Short human label for `lazyclaw sandbox list`. */
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
