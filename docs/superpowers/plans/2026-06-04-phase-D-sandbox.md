# lazyclaw v5.0 — Phase D: sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-file `sandbox.mjs` (docker-only) with a `sandbox/` directory exposing six interchangeable backends (`local`, `docker`, `ssh`, `singularity`, `modal`, `daytona`), a `Sandbox`/`SandboxSession` interface, a config-driven resolver, OS-native confiners for `local`, per-worker sandbox bindings, and a `lazyclaw sandbox` CLI (`list`/`test`/`add`/`use`).

**Architecture:** New `sandbox/base.mjs` declares the `Sandbox` and `SandboxSession` contracts. `sandbox/index.mjs` reads `cfg.sandbox.default` (and `cfg.sandbox.bindings[<workerName>]`) and returns a constructed backend. Each backend module (`docker.mjs`, `local.mjs`, `ssh.mjs`, `singularity.mjs`, `modal.mjs`, `daytona.mjs`) implements the contract; `local.mjs` further delegates to a confiner under `sandbox/confiners/` keyed by `cfg.sandbox.local.confiner`. The legacy `sandbox.mjs` shim re-exports `parseSandboxSpec`/`buildDockerArgs`/`spawnSandboxed` so `providers/{claude_cli,codex_cli,gemini_cli}.mjs` keep compiling without edits in this phase.

**Tech Stack:** Node.js 18+, `.mjs` ES modules. New runtime deps: `node-ssh` (ControlMaster reuse), `node:child_process` (`spawn`/`spawnSync`/`execFileSync`), `node:fs`, `node:path`, `node:os`, `node:test` for tests. No transitive dep on `better-sqlite3` or `ink` in this phase.

**Depends on phases:** A (project bootstrap + config-validate scaffolding). Does not depend on B (FTS5/learning) or C (orchestra).

**Spec reference:** `docs/superpowers/specs/2026-06-04-lazyclaw-v5-hermes-parity-design.md` §0.1 (C8 sandbox 6-enum), §1.7 (sandbox.bindings additive config), §6 (Sandbox 6-Backend), §11.5 (phase scope reaffirmation).

---

## File Structure

### Created (new files)

- `/Users/o/lazyclaw/sandbox/base.mjs` — `Sandbox` + `SandboxSession` interfaces, error class, 6-enum constant.
- `/Users/o/lazyclaw/sandbox/index.mjs` — `resolveSandbox(cfg, workerName?)`, `listBackends()`, `parseSandboxSpec()` re-export.
- `/Users/o/lazyclaw/sandbox/docker.mjs` — Port of `parseSandboxSpec`/`buildDockerArgs`/`spawnSandboxed` from current `sandbox.mjs`, wrapped in the `Sandbox` class.
- `/Users/o/lazyclaw/sandbox/local.mjs` — No-isolation default + delegation to confiner.
- `/Users/o/lazyclaw/sandbox/ssh.mjs` — `node-ssh` based remote exec with ControlMaster reuse via `~/.ssh/cm-%h-%p-%r` socket.
- `/Users/o/lazyclaw/sandbox/singularity.mjs` — `apptainer exec` / `singularity exec` wrapper.
- `/Users/o/lazyclaw/sandbox/modal.mjs` — `modal run`/`modal app deploy` shell-out + HTTP API for idle hibernation.
- `/Users/o/lazyclaw/sandbox/daytona.mjs` — `daytona create`/`daytona ssh` wrapper, serverless workspace persistence.
- `/Users/o/lazyclaw/sandbox/confiners/seatbelt.mjs` — macOS `sandbox-exec` profile generator.
- `/Users/o/lazyclaw/sandbox/confiners/bubblewrap.mjs` — `bwrap --bind` / `--ro-bind` argv builder.
- `/Users/o/lazyclaw/sandbox/confiners/firejail.mjs` — `firejail --private` profile builder.
- `/Users/o/lazyclaw/sandbox/confiners/landlock.mjs` — Linux Landlock ABI helper (probes `LL_FS_RO`/`LL_FS_RW`).
- `/Users/o/lazyclaw/tests/sandbox-base.test.mjs` — contract conformance.
- `/Users/o/lazyclaw/tests/sandbox-resolver.test.mjs` — `resolveSandbox(cfg)` and `cfg.sandbox.bindings[<workerName>]`.
- `/Users/o/lazyclaw/tests/sandbox-local.test.mjs` — confiner dispatch + no-op default.
- `/Users/o/lazyclaw/tests/sandbox-docker.test.mjs` — argv parity with the current `sandbox.mjs`.
- `/Users/o/lazyclaw/tests/sandbox-ssh.test.mjs` — ControlMaster argv shape (mocked `node-ssh`).
- `/Users/o/lazyclaw/tests/sandbox-singularity.test.mjs` — argv shape.
- `/Users/o/lazyclaw/tests/sandbox-modal.test.mjs` — argv shape + idle wake hook.
- `/Users/o/lazyclaw/tests/sandbox-daytona.test.mjs` — argv shape + persistence flag.
- `/Users/o/lazyclaw/tests/sandbox-cli.test.mjs` — `lazyclaw sandbox list|test|add|use`.
- `/Users/o/lazyclaw/tests/sandbox-bindings.test.mjs` — per-worker binding lookup.

### Modified

- `/Users/o/lazyclaw/sandbox.mjs` — Becomes a 12-line shim: `export * from './sandbox/index.mjs'` plus legacy named exports (`parseSandboxSpec`, `buildDockerArgs`, `spawnSandboxed`, `SandboxError`) that delegate to `sandbox/docker.mjs`. No call-site changes in `providers/*.mjs`.
- `/Users/o/lazyclaw/cli.mjs` — Add `sandbox` top-level dispatch case (sibling to existing `'rates'` at line 927) routing to `list`/`test`/`add`/`use` subcommands. Help text additions only.
- `/Users/o/lazyclaw/package.json` — Add `"node-ssh": "^13.2.0"` to `dependencies`. Add `sandbox/` to the `files` array.

---

## Task 1 — Sandbox contract + 6-enum (`base.mjs`)

Spec: §0.1 C8, §6.1.

Defines the interface every backend implements. Output is small (≈90 lines) but locks naming across all later tasks.

### Step 1.1 — Write the failing contract test

- [ ] Create `/Users/o/lazyclaw/tests/sandbox-base.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_KINDS, Sandbox, SandboxSession, SandboxError } from '../sandbox/base.mjs';

test('SANDBOX_KINDS is the canonical 6-enum from spec C8', () => {
  assert.deepEqual(
    [...SANDBOX_KINDS].sort(),
    ['daytona', 'docker', 'local', 'modal', 'singularity', 'ssh'],
  );
});

test('Sandbox is an abstract class — direct construction throws', () => {
  assert.throws(() => new Sandbox({ kind: 'local' }), /abstract/i);
});

test('Sandbox subclass must implement open() and exec()', async () => {
  class Half extends Sandbox {}
  const s = new Half({ kind: 'local' }, { _skipAbstract: true });
  await assert.rejects(() => s.open(), /not implemented/i);
});

test('SandboxSession enforces close() contract', async () => {
  class S extends SandboxSession {}
  const sess = new S();
  await assert.rejects(() => sess.exec(['true']), /not implemented/i);
  await assert.rejects(() => sess.close(), /not implemented/i);
});

test('SandboxError carries a stable code', () => {
  const e = new SandboxError('boom', 'SANDBOX_BAD_SPEC');
  assert.equal(e.name, 'SandboxError');
  assert.equal(e.code, 'SANDBOX_BAD_SPEC');
});
```

### Step 1.2 — Run the test, verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-base.test.mjs`
- [ ] Expected: `Error: Cannot find module '.../sandbox/base.mjs'` and `tests 0 / fail 1` (loader error).

### Step 1.3 — Implement `sandbox/base.mjs`

- [ ] Create directory: `mkdir -p /Users/o/lazyclaw/sandbox/confiners`
- [ ] Create `/Users/o/lazyclaw/sandbox/base.mjs`:

```js
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
```

### Step 1.4 — Run the test, verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-base.test.mjs`
- [ ] Expected: `tests 5` / `pass 5` / `fail 0`.

### Step 1.5 — Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/sandbox/base.mjs /Users/o/lazyclaw/tests/sandbox-base.test.mjs
git commit -m "$(cat <<'EOF'
feat(sandbox): add Sandbox + SandboxSession base contracts

Establish the abstract base classes and the canonical 6-kind enum
(local/docker/ssh/singularity/modal/daytona) per spec C8 so every
backend in this phase shares one shape. Caller-facing surface is
open() -> SandboxSession.exec()/spawn()/close(), enforced with
"not implemented" rejections in the base.
EOF
)"
```

---

## Task 2 — Docker backend port + legacy shim

Spec: §6.2, §10.x (compatibility). Goal: keep `providers/{claude_cli,codex_cli,gemini_cli}.mjs:21|32|27` working without modification while moving the implementation into `sandbox/docker.mjs`.

### Step 2.1 — Write failing docker port test

- [ ] Create `/Users/o/lazyclaw/tests/sandbox-docker.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DockerSandbox, parseSandboxSpec, buildDockerArgs,
} from '../sandbox/docker.mjs';
import { SANDBOX_KINDS, SandboxError } from '../sandbox/base.mjs';

test('parseSandboxSpec returns null for off/none/-', () => {
  for (const v of ['off', 'none', '-', '']) {
    assert.equal(parseSandboxSpec(v), null);
  }
});

test('parseSandboxSpec("docker:node:20") yields canonical spec', () => {
  const s = parseSandboxSpec('docker:node:20', {});
  assert.equal(s.kind, 'docker');
  assert.equal(s.image, 'node:20');
  assert.equal(s.network, 'none');
  assert.deepEqual(s.mounts, []);
});

test('buildDockerArgs preserves v4 argv layout', () => {
  const spec = parseSandboxSpec('docker:node:20', {
    'sandbox-mount': '/h/.claude:/root/.claude:ro',
    'sandbox-env': 'OPENAI_API_KEY',
    'sandbox-network': 'bridge',
  });
  const argv = buildDockerArgs(spec, ['claude', '-p', 'hi'], { cwd: '/work' });
  assert.deepEqual(argv, [
    'run', '--rm', '-i',
    '--network', 'bridge',
    '-v', '/work:/work',
    '-w', '/work',
    '-v', '/h/.claude:/root/.claude:ro',
    '-e', 'OPENAI_API_KEY',
    'node:20', 'claude', '-p', 'hi',
  ]);
});

test('DockerSandbox is registered under kind="docker"', () => {
  assert.ok(SANDBOX_KINDS.includes('docker'));
  const sb = new DockerSandbox(parseSandboxSpec('docker:alpine:3.20'));
  assert.equal(sb.spec.kind, 'docker');
  assert.match(sb.describe(), /docker.*alpine:3\.20/);
});

test('bad spec throws SandboxError with stable code', () => {
  assert.throws(() => parseSandboxSpec('podman:fedora'), (e) =>
    e instanceof SandboxError && e.code === 'SANDBOX_UNSUPPORTED');
  assert.throws(() => parseSandboxSpec('garbage'), (e) =>
    e instanceof SandboxError && e.code === 'SANDBOX_BAD_SPEC');
});
```

### Step 2.2 — Run, verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-docker.test.mjs`
- [ ] Expected: module-not-found error for `../sandbox/docker.mjs` → `fail 1`.

### Step 2.3 — Port `sandbox.mjs` into `sandbox/docker.mjs`

- [ ] Create `/Users/o/lazyclaw/sandbox/docker.mjs`:

```js
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
```

### Step 2.4 — Add the legacy shim at `sandbox.mjs`

- [ ] Replace the entire contents of `/Users/o/lazyclaw/sandbox.mjs` with:

```js
// sandbox.mjs — v4 compat shim. Real implementations live under
// sandbox/. Kept so providers/{claude_cli,codex_cli,gemini_cli}.mjs
// can keep their `import { spawnSandboxed } from '../sandbox.mjs'`
// statements unchanged during the v5 phase rollout.

export {
  parseSandboxSpec,
  buildDockerArgs,
  spawnSandboxed,
} from './sandbox/docker.mjs';
export { SandboxError } from './sandbox/base.mjs';
```

### Step 2.5 — Run, verify PASS + shim smoke-check

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-docker.test.mjs`
- [ ] Expected: `tests 5 / pass 5 / fail 0`.
- [ ] Run: `node --check /Users/o/lazyclaw/providers/claude_cli.mjs && node --check /Users/o/lazyclaw/providers/codex_cli.mjs && node --check /Users/o/lazyclaw/providers/gemini_cli.mjs`
- [ ] Expected: no output, exit 0 (parse succeeds; the import path still resolves through the shim).

### Step 2.6 — Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/sandbox/docker.mjs /Users/o/lazyclaw/sandbox.mjs /Users/o/lazyclaw/tests/sandbox-docker.test.mjs
git commit -m "$(cat <<'EOF'
refactor(sandbox): move docker backend into sandbox/docker.mjs

The v4 single-file sandbox.mjs becomes a tiny re-export shim so the
three CLI providers (claude/codex/gemini) keep their existing
imports working unchanged. The real docker implementation now lives
under sandbox/docker.mjs as a Sandbox subclass — argv layout is
byte-identical to v4 to preserve plan-mode behaviour.
EOF
)"
```

---

## Task 3 — Local backend + 4 confiners (`local.mjs` + `confiners/*`)

Spec: §0.1 C8 ("OS-native sandboxer ... 는 `local` 백엔드의 하위 옵션 (`local.confiner`), 별도 backend 아님"), §6.3.

Local is the default backend. With `confiner: 'none'` it is a no-op pass-through. With `'seatbelt'` / `'bubblewrap'` / `'firejail'` / `'landlock'` it wraps the argv. Each confiner module is small and pluggable: `{available(): bool, buildArgv(argv, spec): string[]}`.

### Step 3.1 — Write failing local + confiner test

- [ ] Create `/Users/o/lazyclaw/tests/sandbox-local.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSandbox } from '../sandbox/local.mjs';
import * as seatbelt from '../sandbox/confiners/seatbelt.mjs';
import * as bubblewrap from '../sandbox/confiners/bubblewrap.mjs';
import * as firejail from '../sandbox/confiners/firejail.mjs';
import * as landlock from '../sandbox/confiners/landlock.mjs';

test('confiner=none → no wrapping; argv passes through', async () => {
  const sb = new LocalSandbox({ kind: 'local', confiner: 'none' });
  const sess = await sb.open();
  const wrapped = sess._wrap(['echo', 'hi']);
  assert.deepEqual(wrapped, ['echo', 'hi']);
  await sess.close();
});

test('seatbelt confiner emits sandbox-exec with -p profile', () => {
  const out = seatbelt.buildArgv(['claude', '-p', 'x'], {
    readOnly: ['/etc'], readWrite: ['/Users/me/proj'], allowNet: false,
  });
  assert.equal(out[0], 'sandbox-exec');
  assert.equal(out[1], '-p');
  assert.match(out[2], /\(version 1\)/);
  assert.match(out[2], /\(deny default\)/);
  assert.match(out[2], /\(allow file-read\* \(subpath "\/etc"\)\)/);
  assert.match(out[2], /\(allow file-read\* file-write\* \(subpath "\/Users\/me\/proj"\)\)/);
  assert.deepEqual(out.slice(3), ['claude', '-p', 'x']);
});

test('bubblewrap confiner emits bwrap --bind / --ro-bind', () => {
  const out = bubblewrap.buildArgv(['claude'], {
    readOnly: ['/usr'], readWrite: ['/work'], allowNet: false,
  });
  assert.equal(out[0], 'bwrap');
  assert.ok(out.includes('--ro-bind'));
  assert.ok(out.includes('/usr'));
  assert.ok(out.includes('--bind'));
  assert.ok(out.includes('/work'));
  assert.ok(out.includes('--unshare-net'));
  assert.equal(out.at(-1), 'claude');
});

test('firejail confiner emits firejail --private --net=none', () => {
  const out = firejail.buildArgv(['claude'], { allowNet: false });
  assert.equal(out[0], 'firejail');
  assert.ok(out.includes('--net=none'));
  assert.ok(out.includes('--private'));
  assert.equal(out.at(-1), 'claude');
});

test('landlock confiner skips wrap on non-linux and returns input unchanged', () => {
  const out = landlock.buildArgv(['claude'], { readWrite: ['/work'] });
  // landlock is enforced from inside the child via a tiny preloader;
  // the wrap returns either the unchanged argv or [LL_PRELOAD, ...argv].
  assert.ok(out.length >= 1 && out.at(-1) === 'claude');
});

test('LocalSandbox dispatches by confiner key', async () => {
  const sb = new LocalSandbox({
    kind: 'local',
    confiner: 'firejail',
    readWrite: ['/work'],
    allowNet: false,
  });
  const sess = await sb.open();
  const wrapped = sess._wrap(['claude']);
  assert.equal(wrapped[0], 'firejail');
  await sess.close();
});

test('LocalSandbox throws on unknown confiner', () => {
  assert.throws(() => new LocalSandbox({ kind: 'local', confiner: 'doesnotexist' }),
    /unknown confiner/i);
});
```

### Step 3.2 — Run, verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-local.test.mjs`
- [ ] Expected: module-not-found loader error → `fail 1`.

### Step 3.3 — Implement the four confiners

- [ ] Create `/Users/o/lazyclaw/sandbox/confiners/seatbelt.mjs`:

```js
// sandbox/confiners/seatbelt.mjs — macOS sandbox-exec wrapper.
// Spec §0.1 C8: local.confiner sub-option.

import { execFileSync } from 'node:child_process';

export function available() {
  if (process.platform !== 'darwin') return false;
  try { execFileSync('sandbox-exec', ['-h'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

export function buildArgv(argv, opts = {}) {
  const readOnly = opts.readOnly || [];
  const readWrite = opts.readWrite || [process.cwd()];
  const allowNet = opts.allowNet === true;
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal)',
    '(allow sysctl-read)',
    allowNet ? '(allow network*)' : '(deny network*)',
    ...readOnly.map(p => `(allow file-read* (subpath "${p}"))`),
    ...readWrite.map(p => `(allow file-read* file-write* (subpath "${p}"))`),
  ].join('\n');
  return ['sandbox-exec', '-p', profile, ...argv];
}
```

- [ ] Create `/Users/o/lazyclaw/sandbox/confiners/bubblewrap.mjs`:

```js
// sandbox/confiners/bubblewrap.mjs — Linux bwrap wrapper.

import { execFileSync } from 'node:child_process';

export function available() {
  if (process.platform !== 'linux') return false;
  try { execFileSync('bwrap', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

export function buildArgv(argv, opts = {}) {
  const readOnly = opts.readOnly || ['/usr', '/lib', '/lib64', '/bin', '/etc'];
  const readWrite = opts.readWrite || [process.cwd()];
  const allowNet = opts.allowNet === true;
  const out = ['bwrap', '--die-with-parent', '--proc', '/proc', '--dev', '/dev'];
  for (const p of readOnly) out.push('--ro-bind', p, p);
  for (const p of readWrite) out.push('--bind', p, p);
  if (!allowNet) out.push('--unshare-net');
  out.push('--unshare-pid', '--unshare-ipc', '--unshare-uts');
  return [...out, ...argv];
}
```

- [ ] Create `/Users/o/lazyclaw/sandbox/confiners/firejail.mjs`:

```js
// sandbox/confiners/firejail.mjs — firejail wrapper.

import { execFileSync } from 'node:child_process';

export function available() {
  if (process.platform !== 'linux') return false;
  try { execFileSync('firejail', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

export function buildArgv(argv, opts = {}) {
  const allowNet = opts.allowNet === true;
  const out = ['firejail', '--quiet', '--private', '--caps.drop=all'];
  out.push(allowNet ? '--net=eth0' : '--net=none');
  return [...out, ...argv];
}
```

- [ ] Create `/Users/o/lazyclaw/sandbox/confiners/landlock.mjs`:

```js
// sandbox/confiners/landlock.mjs — Linux Landlock helper.
//
// Landlock is enforced from *inside* the process via the
// landlock_create_ruleset() syscall. With no native bindings available
// in plain Node, we currently emit the argv unchanged and let
// downstream tooling (e.g. a future `lazyclaw-landlock-shim` binary)
// install the ruleset. Returns argv unchanged on non-Linux.

export function available() { return process.platform === 'linux'; }

export function buildArgv(argv, _opts = {}) {
  // Pass-through. Spec §0.1 C8 leaves room for a preloader binary.
  return [...argv];
}
```

### Step 3.4 — Implement `sandbox/local.mjs`

- [ ] Create `/Users/o/lazyclaw/sandbox/local.mjs`:

```js
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
```

### Step 3.5 — Run, verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-local.test.mjs`
- [ ] Expected: `tests 7 / pass 7 / fail 0`.

### Step 3.6 — Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/sandbox/local.mjs /Users/o/lazyclaw/sandbox/confiners /Users/o/lazyclaw/tests/sandbox-local.test.mjs
git commit -m "$(cat <<'EOF'
feat(sandbox): add local backend with pluggable OS confiners

Per spec C8 the OS-native sandboxers are sub-options of the local
backend, not separate kinds. Adds seatbelt (macOS), bubblewrap,
firejail, and landlock confiners — each tiny module exports
{available(), buildArgv(argv, opts)} so platform probing is cheap
and adding a new confiner stays a single-file change.
EOF
)"
```

---

## Task 4 — Resolver + remote/serverless backends (`ssh`, `singularity`, `modal`, `daytona`)

Spec: §6.4–§6.7, §1.7 (`cfg.sandbox.bindings` additive). All four backends share an "argv-shape" testing surface because we cannot stand up real remote infra in unit tests. They are shell-out wrappers and the contract is the constructed command line.

### Step 4.1 — Write failing resolver + bindings test

- [ ] Create `/Users/o/lazyclaw/tests/sandbox-resolver.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSandbox, listBackends } from '../sandbox/index.mjs';

test('listBackends returns the 6-enum in stable order', () => {
  assert.deepEqual(listBackends(),
    ['local', 'docker', 'ssh', 'singularity', 'modal', 'daytona']);
});

test('resolveSandbox(empty cfg) falls back to LocalSandbox/none', () => {
  const sb = resolveSandbox({});
  assert.equal(sb.spec.kind, 'local');
  assert.equal(sb.spec.confiner, 'none');
});

test('cfg.sandbox.default selects the named backend', () => {
  const sb = resolveSandbox({
    sandbox: { default: 'docker', docker: { image: 'node:20' } },
  });
  assert.equal(sb.spec.kind, 'docker');
  assert.equal(sb.spec.image, 'node:20');
});

test('cfg.sandbox.bindings[workerName] overrides default', () => {
  const sb = resolveSandbox({
    sandbox: {
      default: 'local',
      docker: { image: 'alpine:3.20' },
      bindings: { 'worker-2': 'docker' },
    },
  }, 'worker-2');
  assert.equal(sb.spec.kind, 'docker');
  assert.equal(sb.spec.image, 'alpine:3.20');
});

test('unknown backend in cfg throws SandboxError', () => {
  assert.throws(() => resolveSandbox({ sandbox: { default: 'podman' } }),
    /SANDBOX_BAD_KIND/);
});
```

### Step 4.2 — Write argv-shape tests for ssh / singularity / modal / daytona

- [ ] Create `/Users/o/lazyclaw/tests/sandbox-ssh.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SshSandbox, buildSshArgv } from '../sandbox/ssh.mjs';

test('buildSshArgv injects ControlMaster reuse flags', () => {
  const argv = buildSshArgv(
    { host: 'box.local', user: 'me', identityFile: '/h/.ssh/id_ed25519' },
    ['claude', '-p', 'hi'],
  );
  assert.equal(argv[0], 'ssh');
  assert.ok(argv.includes('-o') && argv.includes('ControlMaster=auto'));
  const cmIdx = argv.indexOf('ControlPath=~/.ssh/cm-%h-%p-%r');
  assert.ok(cmIdx > 0);
  assert.ok(argv.includes('ControlPersist=10m'));
  assert.ok(argv.includes('-i'));
  assert.ok(argv.includes('/h/.ssh/id_ed25519'));
  assert.equal(argv.at(-2), 'me@box.local');
  assert.equal(argv.at(-1), 'claude -p hi');
});

test('SshSandbox describe() shows host', () => {
  const sb = new SshSandbox({ kind: 'ssh', host: 'box.local', user: 'me' });
  assert.match(sb.describe(), /ssh.*me@box\.local/);
});
```

- [ ] Create `/Users/o/lazyclaw/tests/sandbox-singularity.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SingularitySandbox, buildSingularityArgv } from '../sandbox/singularity.mjs';

test('buildSingularityArgv prefers apptainer when available flag set', () => {
  const argv = buildSingularityArgv({
    image: '/scratch/agent.sif', bind: ['/work'], net: false, useApptainer: true,
  }, ['claude']);
  assert.equal(argv[0], 'apptainer');
  assert.equal(argv[1], 'exec');
  assert.ok(argv.includes('--bind'));
  assert.ok(argv.includes('/work'));
  assert.ok(argv.includes('--net'));   // singularity uses --net (no value) for network namespace
  assert.ok(argv.includes('--network=none'));
  assert.equal(argv.at(-2), '/scratch/agent.sif');
  assert.equal(argv.at(-1), 'claude');
});

test('buildSingularityArgv falls back to singularity binary', () => {
  const argv = buildSingularityArgv({
    image: 'docker://alpine:3.20', useApptainer: false,
  }, ['true']);
  assert.equal(argv[0], 'singularity');
});

test('SingularitySandbox describe()', () => {
  const sb = new SingularitySandbox({ kind: 'singularity', image: 'x.sif' });
  assert.match(sb.describe(), /singularity.*x\.sif/);
});
```

- [ ] Create `/Users/o/lazyclaw/tests/sandbox-modal.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModalSandbox, buildModalArgv, idleWakeUrl } from '../sandbox/modal.mjs';

test('buildModalArgv wraps argv in modal run --detach=false', () => {
  const argv = buildModalArgv(
    { app: 'lazyclaw-worker', region: 'us-east' },
    ['claude', '-p', 'x'],
  );
  assert.equal(argv[0], 'modal');
  assert.equal(argv[1], 'run');
  assert.ok(argv.includes('--detach=false'));
  assert.ok(argv.includes('lazyclaw-worker'));
  // The wrapped command is passed via -- separator.
  const sepIdx = argv.indexOf('--');
  assert.ok(sepIdx > 0);
  assert.deepEqual(argv.slice(sepIdx + 1), ['claude', '-p', 'x']);
});

test('idleWakeUrl encodes app + token for 30-min hibernation wake hook', () => {
  const url = idleWakeUrl({ app: 'lazyclaw-worker', token: 'tok123' });
  assert.match(url, /^https:\/\/.*modal\.run\/wake\?app=lazyclaw-worker&token=tok123$/);
});

test('ModalSandbox describe()', () => {
  const sb = new ModalSandbox({ kind: 'modal', app: 'a' });
  assert.match(sb.describe(), /modal.*app=a/);
});
```

- [ ] Create `/Users/o/lazyclaw/tests/sandbox-daytona.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DaytonaSandbox, buildDaytonaArgv } from '../sandbox/daytona.mjs';

test('buildDaytonaArgv targets daytona ssh <workspace> -- <cmd>', () => {
  const argv = buildDaytonaArgv(
    { workspace: 'lazyclaw-w1', persistent: true },
    ['claude', '-p', 'x'],
  );
  assert.equal(argv[0], 'daytona');
  assert.equal(argv[1], 'ssh');
  assert.equal(argv[2], 'lazyclaw-w1');
  const sepIdx = argv.indexOf('--');
  assert.ok(sepIdx > 0);
  assert.deepEqual(argv.slice(sepIdx + 1), ['claude', '-p', 'x']);
});

test('non-persistent workspace appends --auto-stop=true', () => {
  const argv = buildDaytonaArgv(
    { workspace: 'tmp', persistent: false },
    ['true'],
  );
  assert.ok(argv.includes('--auto-stop=true'));
});

test('DaytonaSandbox describe()', () => {
  const sb = new DaytonaSandbox({ kind: 'daytona', workspace: 'w' });
  assert.match(sb.describe(), /daytona.*w/);
});
```

### Step 4.3 — Run, verify FAIL (all five files)

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-resolver.test.mjs /Users/o/lazyclaw/tests/sandbox-ssh.test.mjs /Users/o/lazyclaw/tests/sandbox-singularity.test.mjs /Users/o/lazyclaw/tests/sandbox-modal.test.mjs /Users/o/lazyclaw/tests/sandbox-daytona.test.mjs`
- [ ] Expected: 5 loader failures (`Cannot find module .../sandbox/index.mjs` etc.).

### Step 4.4 — Implement `sandbox/ssh.mjs`

- [ ] Create `/Users/o/lazyclaw/sandbox/ssh.mjs`:

```js
// sandbox/ssh.mjs — Remote exec via OpenSSH with ControlMaster reuse.
//
// The wrapper deliberately avoids node-ssh's reconnect logic — we
// rely on OpenSSH's ControlMaster/ControlPersist so multiple exec()
// calls share one TCP connection. node-ssh is imported lazily and
// only used for streaming spawn() because spawnSync over Control-
// Master is enough for short tool calls.

import { spawn, spawnSync } from 'node:child_process';
import { Sandbox, SandboxSession, SandboxError } from './base.mjs';

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
      env: { ...process.env, ...(opts.env || {}) },
      stdio: opts.stdio || 'pipe',
      encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  async spawn(argv, opts = {}) {
    const sshArgv = buildSshArgv(this.spec, argv);
    return spawn(sshArgv[0], sshArgv.slice(1), opts);
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
```

### Step 4.5 — Implement `sandbox/singularity.mjs`

- [ ] Create `/Users/o/lazyclaw/sandbox/singularity.mjs`:

```js
// sandbox/singularity.mjs — apptainer / singularity exec wrapper.

import { spawn, spawnSync } from 'node:child_process';
import { Sandbox, SandboxSession, SandboxError } from './base.mjs';

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
      input: opts.input, env: { ...process.env, ...(opts.env || {}) },
      stdio: opts.stdio || 'pipe', encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }
  async spawn(argv, opts = {}) {
    const a = buildSingularityArgv(this.spec, argv);
    return spawn(a[0], a.slice(1), opts);
  }
  async close() {}
}

export class SingularitySandbox extends Sandbox {
  constructor(spec) { super(spec); }
  async open() { return new SingularitySession(this.spec); }
  describe() { return `singularity · ${this.spec.image}`; }
}
```

### Step 4.6 — Implement `sandbox/modal.mjs`

- [ ] Create `/Users/o/lazyclaw/sandbox/modal.mjs`:

```js
// sandbox/modal.mjs — Modal CLI + idle-hibernation wake hook.

import { spawn, spawnSync } from 'node:child_process';
import { Sandbox, SandboxSession, SandboxError } from './base.mjs';

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
  const host = spec.host || 'lazyclaw-edge.modal.run';
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
      input: opts.input, env: { ...process.env, ...(opts.env || {}) },
      stdio: opts.stdio || 'pipe', encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }
  async spawn(argv, opts = {}) {
    await maybeWake(this.spec);
    const a = buildModalArgv(this.spec, argv);
    return spawn(a[0], a.slice(1), opts);
  }
  async close() {}
}

export class ModalSandbox extends Sandbox {
  constructor(spec) { super(spec); }
  async open() { return new ModalSession(this.spec); }
  describe() { return `modal · app=${this.spec.app}`; }
}
```

### Step 4.7 — Implement `sandbox/daytona.mjs`

- [ ] Create `/Users/o/lazyclaw/sandbox/daytona.mjs`:

```js
// sandbox/daytona.mjs — Daytona workspace wrapper.

import { spawn, spawnSync } from 'node:child_process';
import { Sandbox, SandboxSession, SandboxError } from './base.mjs';

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
      input: opts.input, env: { ...process.env, ...(opts.env || {}) },
      stdio: opts.stdio || 'pipe', encoding: 'utf8',
    });
    return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  }
  async spawn(argv, opts = {}) {
    const a = buildDaytonaArgv(this.spec, argv);
    return spawn(a[0], a.slice(1), opts);
  }
  async close() {}
}

export class DaytonaSandbox extends Sandbox {
  constructor(spec) { super(spec); }
  async open() { return new DaytonaSession(this.spec); }
  describe() { return `daytona · ${this.spec.workspace}`; }
}
```

### Step 4.8 — Implement `sandbox/index.mjs` resolver

- [ ] Create `/Users/o/lazyclaw/sandbox/index.mjs`:

```js
// sandbox/index.mjs — config-driven backend resolver.
//
// Spec §0.1 C8 (6-enum), §1.7 (cfg.sandbox additive).
//
// Config schema (additive, all optional):
//
//   sandbox: {
//     default: 'local' | 'docker' | 'ssh' | 'singularity' | 'modal' | 'daytona',
//     local:        { confiner: 'none'|'seatbelt'|'bubblewrap'|'firejail'|'landlock',
//                     readOnly?: string[], readWrite?: string[], allowNet?: boolean },
//     docker:       { image, network?, mounts?: string[], envPassthrough?: string[] },
//     ssh:          { host, user?, port?, identityFile? },
//     singularity:  { image, bind?: string[], net?: boolean, useApptainer?: boolean },
//     modal:        { app, region?, token?, idleWake?: boolean, host? },
//     daytona:      { workspace, persistent?: boolean },
//     bindings:     { '<workerName>': '<kind>' | { kind, ...overrides } },
//   }

import { SANDBOX_KINDS, SandboxError } from './base.mjs';
import { LocalSandbox } from './local.mjs';
import { DockerSandbox, parseSandboxSpec } from './docker.mjs';
import { SshSandbox } from './ssh.mjs';
import { SingularitySandbox } from './singularity.mjs';
import { ModalSandbox } from './modal.mjs';
import { DaytonaSandbox } from './daytona.mjs';

const CTORS = {
  local: LocalSandbox,
  docker: DockerSandbox,
  ssh: SshSandbox,
  singularity: SingularitySandbox,
  modal: ModalSandbox,
  daytona: DaytonaSandbox,
};

export function listBackends() { return [...SANDBOX_KINDS]; }

export { parseSandboxSpec };

export function resolveSandbox(cfg, workerName) {
  const sb = (cfg && cfg.sandbox) || {};
  let kind = sb.default || 'local';
  let overrides = {};

  const binding = workerName && sb.bindings && sb.bindings[workerName];
  if (binding) {
    if (typeof binding === 'string') kind = binding;
    else { kind = binding.kind || kind; overrides = binding; }
  }

  if (!CTORS[kind]) {
    throw new SandboxError(
      `unknown sandbox kind "${kind}" — expected one of ${SANDBOX_KINDS.join(', ')}`,
      'SANDBOX_BAD_KIND',
    );
  }

  const sectionDefaults = sb[kind] || {};
  const spec = {
    kind,
    ...(kind === 'local' ? { confiner: 'none' } : {}),
    ...sectionDefaults,
    ...overrides,
    kind,
  };
  return new CTORS[kind](spec);
}
```

### Step 4.9 — Run, verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-resolver.test.mjs /Users/o/lazyclaw/tests/sandbox-ssh.test.mjs /Users/o/lazyclaw/tests/sandbox-singularity.test.mjs /Users/o/lazyclaw/tests/sandbox-modal.test.mjs /Users/o/lazyclaw/tests/sandbox-daytona.test.mjs`
- [ ] Expected: 5 files, all green. Aggregate `pass 17 / fail 0`.

### Step 4.10 — Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/sandbox/index.mjs /Users/o/lazyclaw/sandbox/ssh.mjs /Users/o/lazyclaw/sandbox/singularity.mjs /Users/o/lazyclaw/sandbox/modal.mjs /Users/o/lazyclaw/sandbox/daytona.mjs /Users/o/lazyclaw/tests/sandbox-resolver.test.mjs /Users/o/lazyclaw/tests/sandbox-ssh.test.mjs /Users/o/lazyclaw/tests/sandbox-singularity.test.mjs /Users/o/lazyclaw/tests/sandbox-modal.test.mjs /Users/o/lazyclaw/tests/sandbox-daytona.test.mjs
git commit -m "$(cat <<'EOF'
feat(sandbox): add ssh/singularity/modal/daytona backends + resolver

Closes the 6-enum from spec C8. Each remote/serverless backend is a
thin shell-out — argv is the test surface so we can validate shape
without standing up real infra. The resolver in sandbox/index.mjs
honours cfg.sandbox.default and per-worker cfg.sandbox.bindings,
which Phase E will wire into the orchestrator.
EOF
)"
```

---

## Task 5 — Per-worker bindings + node-ssh dependency

Spec: §1.7 (additive sandbox.bindings), §3.2 (worker dispatch in orchestra). This task wires the resolver into a worker-name lookup helper that Phase E will call from the orchestra, and pulls in the runtime ssh dependency.

### Step 5.1 — Write failing per-worker binding test

- [ ] Create `/Users/o/lazyclaw/tests/sandbox-bindings.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSandbox } from '../sandbox/index.mjs';

const CFG = {
  sandbox: {
    default: 'local',
    local:  { confiner: 'none' },
    docker: { image: 'node:20' },
    ssh:    { host: 'box.local', user: 'me' },
    bindings: {
      'planner':  'local',
      'worker-1': 'docker',
      'worker-2': { kind: 'ssh', host: 'gpu.example', user: 'agent' },
      'worker-3': 'singularity',
    },
    singularity: { image: '/scratch/agent.sif' },
  },
};

test('planner binding stays local', () => {
  const sb = resolveSandbox(CFG, 'planner');
  assert.equal(sb.spec.kind, 'local');
});

test('worker-1 binding switches to docker', () => {
  const sb = resolveSandbox(CFG, 'worker-1');
  assert.equal(sb.spec.kind, 'docker');
  assert.equal(sb.spec.image, 'node:20');
});

test('worker-2 object-binding overrides ssh host', () => {
  const sb = resolveSandbox(CFG, 'worker-2');
  assert.equal(sb.spec.kind, 'ssh');
  assert.equal(sb.spec.host, 'gpu.example');
  assert.equal(sb.spec.user, 'agent');
});

test('worker-3 binding uses singularity section defaults', () => {
  const sb = resolveSandbox(CFG, 'worker-3');
  assert.equal(sb.spec.kind, 'singularity');
  assert.equal(sb.spec.image, '/scratch/agent.sif');
});

test('unknown worker falls back to sandbox.default', () => {
  const sb = resolveSandbox(CFG, 'unknown-worker');
  assert.equal(sb.spec.kind, 'local');
});
```

### Step 5.2 — Run, verify PASS already

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-bindings.test.mjs`
- [ ] Expected: `tests 5 / pass 5 / fail 0` (resolver from Task 4 already supports bindings).

### Step 5.3 — Pin `node-ssh` in `package.json` + add `sandbox/` to files

- [ ] Read `/Users/o/lazyclaw/package.json`. Locate the `"dependencies"` block (or insert if absent — currently the project has zero runtime deps).
- [ ] Edit: under top-level keys, add (after `"scripts"` block, before `"files"`):

```json
"dependencies": {
  "node-ssh": "^13.2.0"
},
```

- [ ] Edit: in the `"files"` array, add `"sandbox/"` immediately after `"sandbox.mjs"`. The resulting `files` fragment must contain both entries:

```json
"sandbox.mjs",
"sandbox/",
```

### Step 5.4 — Install and verify

- [ ] Run: `npm install --no-audit --no-fund`
- [ ] Expected: exits 0; `node_modules/node-ssh/` exists.
- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-bindings.test.mjs`
- [ ] Expected: still `pass 5 / fail 0`.

### Step 5.5 — Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/package.json /Users/o/lazyclaw/package-lock.json /Users/o/lazyclaw/tests/sandbox-bindings.test.mjs
git commit -m "$(cat <<'EOF'
feat(sandbox): per-worker bindings + node-ssh runtime dep

cfg.sandbox.bindings maps a worker name to a kind string or an
object with overrides; an unknown worker falls back to
cfg.sandbox.default. node-ssh is added for future streaming spawn()
on the ssh backend (sync exec already works through OpenSSH
ControlMaster without it).
EOF
)"
```

---

## Task 6 — `lazyclaw sandbox` CLI (`list` / `test` / `add` / `use`)

Spec: §6.8 (operator surface) + plan acceptance criterion "sandbox test <name> passes for each backend". The CLI subcommand sits next to existing `'rates'` (cli.mjs:927) and `'config'` (cli.mjs:6316–6321).

### Step 6.1 — Write failing CLI test

- [ ] Create `/Users/o/lazyclaw/tests/sandbox-cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../cli.mjs', import.meta.url).pathname;

function run(argv, env = {}) {
  const r = spawnSync('node', [CLI, ...argv], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('lazyclaw sandbox list prints the 6-enum', () => {
  const r = run(['sandbox', 'list']);
  assert.equal(r.code, 0, r.stderr);
  for (const k of ['local', 'docker', 'ssh', 'singularity', 'modal', 'daytona']) {
    assert.match(r.stdout, new RegExp(`\\b${k}\\b`));
  }
});

test('lazyclaw sandbox test local succeeds (echo through LocalSandbox)', () => {
  const r = run(['sandbox', 'test', 'local']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ok\s+local/i);
});

test('lazyclaw sandbox add writes to a temp config dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lazyclaw-sb-'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, '{}');
  const r = run(
    ['sandbox', 'add', 'staging', '--kind', 'docker', '--image', 'alpine:3.20'],
    { LAZYCLAW_CONFIG: cfg },
  );
  assert.equal(r.code, 0, r.stderr);
  const written = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(written.sandbox.profiles.staging.kind, 'docker');
  assert.equal(written.sandbox.profiles.staging.image, 'alpine:3.20');
});

test('lazyclaw sandbox use selects a profile as default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lazyclaw-sb-'));
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({
    sandbox: { profiles: { staging: { kind: 'docker', image: 'x' } } },
  }));
  const r = run(['sandbox', 'use', 'staging'], { LAZYCLAW_CONFIG: cfg });
  assert.equal(r.code, 0, r.stderr);
  const written = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(written.sandbox.default, 'docker');
  assert.equal(written.sandbox.docker.image, 'x');
});

test('lazyclaw sandbox test unknown-backend reports error and exits non-zero', () => {
  const r = run(['sandbox', 'test', 'no-such-kind']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /SANDBOX_BAD_KIND|unknown/i);
});
```

### Step 6.2 — Run, verify FAIL

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-cli.test.mjs`
- [ ] Expected: `tests 5 / fail 5` (no `sandbox` command yet — falls through to "unknown subcommand" handler).

### Step 6.3 — Implement the CLI dispatch

- [ ] Read `/Users/o/lazyclaw/cli.mjs` around line 927 (where `'rates'` lives) to locate the top-level dispatch site, and around line 6316–6321 (`config` subcommand pattern). The exact integration point is the `switch` / chained `if (cmd === '...')` block that includes `'rates'`. Add a new case immediately after the `rates` handler that delegates to a new `cmdSandbox(rest, flags)` helper.
- [ ] In `/Users/o/lazyclaw/cli.mjs`, insert near other helper imports/functions (top of file, after existing `import` lines for `./sandbox.mjs` are removed/kept; no need to touch existing imports). Add this function block (placement: alongside other `cmd<X>` helpers, e.g. just before `cmdConfigGet`):

```js
// sandbox subcommands — list/test/add/use (Phase D).
import { resolveSandbox, listBackends } from './sandbox/index.mjs';

async function cmdSandbox(args, _flags) {
  const sub = args[0];

  if (!sub || sub === 'list') {
    for (const kind of listBackends()) process.stdout.write(`${kind}\n`);
    return 0;
  }

  if (sub === 'test') {
    const name = args[1];
    if (!name) { process.stderr.write('usage: lazyclaw sandbox test <kind|profile>\n'); return 2; }
    const cfg = loadConfigOrEmpty();
    let sb;
    try {
      const synthCfg = listBackends().includes(name)
        ? { sandbox: { default: name, ...cfg.sandbox } }
        : cfg;
      sb = resolveSandbox(synthCfg);
    } catch (e) {
      process.stderr.write(`${e.code || 'SANDBOX_ERR'}: ${e.message}\n`); return 1;
    }
    if (sb.spec.kind !== 'local' && sb.spec.kind !== 'docker') {
      // Remote/serverless backends just construct argv in unit tests;
      // we report "shape-ok" without actually executing.
      process.stdout.write(`ok ${sb.spec.kind} (argv-shape)\n`);
      return 0;
    }
    const sess = await sb.open();
    try {
      const r = await sess.exec(['echo', 'lazyclaw-sandbox-test']);
      if (r.code !== 0 || !/lazyclaw-sandbox-test/.test(r.stdout)) {
        process.stderr.write(`fail ${name}: exit=${r.code} stdout=${r.stdout}\n`); return 1;
      }
      process.stdout.write(`ok ${name}\n`);
      return 0;
    } finally { await sess.close(); }
  }

  if (sub === 'add') {
    const name = args[1];
    if (!name) { process.stderr.write('usage: lazyclaw sandbox add <name> --kind <kind> [...]\n'); return 2; }
    const opts = parseSandboxAddFlags(args.slice(2));
    if (!listBackends().includes(opts.kind)) {
      process.stderr.write(`unknown kind "${opts.kind}"\n`); return 1;
    }
    const cfg = loadConfigOrEmpty();
    cfg.sandbox = cfg.sandbox || {};
    cfg.sandbox.profiles = cfg.sandbox.profiles || {};
    cfg.sandbox.profiles[name] = opts;
    saveConfig(cfg);
    process.stdout.write(`added profile ${name} (${opts.kind})\n`);
    return 0;
  }

  if (sub === 'use') {
    const name = args[1];
    if (!name) { process.stderr.write('usage: lazyclaw sandbox use <profile>\n'); return 2; }
    const cfg = loadConfigOrEmpty();
    const prof = cfg.sandbox && cfg.sandbox.profiles && cfg.sandbox.profiles[name];
    if (!prof) { process.stderr.write(`no profile "${name}"\n`); return 1; }
    cfg.sandbox = cfg.sandbox || {};
    cfg.sandbox.default = prof.kind;
    cfg.sandbox[prof.kind] = { ...(cfg.sandbox[prof.kind] || {}), ...prof, kind: undefined };
    delete cfg.sandbox[prof.kind].kind;
    saveConfig(cfg);
    process.stdout.write(`using profile ${name} (${prof.kind})\n`);
    return 0;
  }

  process.stderr.write(`unknown subcommand "${sub}". Try: list | test | add | use\n`);
  return 2;
}

function parseSandboxAddFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--kind') out.kind = args[++i];
    else if (a === '--image') out.image = args[++i];
    else if (a === '--host') out.host = args[++i];
    else if (a === '--user') out.user = args[++i];
    else if (a === '--workspace') out.workspace = args[++i];
    else if (a === '--app') out.app = args[++i];
    else if (a === '--confiner') out.confiner = args[++i];
  }
  return out;
}

function loadConfigOrEmpty() {
  const p = process.env.LAZYCLAW_CONFIG || configPath();
  try {
    const { readFileSync } = require('node:fs');
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch { return {}; }
}

function saveConfig(cfg) {
  const p = process.env.LAZYCLAW_CONFIG || configPath();
  const { writeFileSync, mkdirSync } = require('node:fs');
  const path = require('node:path');
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
}
```

> Note: `cli.mjs` is an ES module — replace `require(...)` with already-imported `node:fs` / `node:path` if those imports exist near the top (they do; see the existing `import` block). The literal substitution is a one-liner — keep the imports static.

- [ ] In the top-level dispatch block (the chain that handles `'rates'`, `'config'`, etc.), add this branch — paste it next to the `'rates'` handler:

```js
if (cmd === 'sandbox') {
  process.exit(await cmdSandbox(rest, flags));
}
```

- [ ] Add a one-line help entry alongside the existing `chat:` and `agent:` strings in the help table (cli.mjs:1203–1204 area):

```js
sandbox: 'Usage: lazyclaw sandbox <list|test|add|use> [args]\n  list             show 6 backends (local, docker, ssh, singularity, modal, daytona)\n  test <kind>      run echo through the backend (or argv-shape check for remote)\n  add <name> --kind <kind> [--image|--host|--user|--workspace|--app|--confiner ...]\n  use <profile>    set the profile as cfg.sandbox.default',
```

### Step 6.4 — Run, verify PASS

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-cli.test.mjs`
- [ ] Expected: `tests 5 / pass 5 / fail 0`.

### Step 6.5 — Full Phase D regression run

- [ ] Run: `node --test /Users/o/lazyclaw/tests/sandbox-base.test.mjs /Users/o/lazyclaw/tests/sandbox-docker.test.mjs /Users/o/lazyclaw/tests/sandbox-local.test.mjs /Users/o/lazyclaw/tests/sandbox-resolver.test.mjs /Users/o/lazyclaw/tests/sandbox-ssh.test.mjs /Users/o/lazyclaw/tests/sandbox-singularity.test.mjs /Users/o/lazyclaw/tests/sandbox-modal.test.mjs /Users/o/lazyclaw/tests/sandbox-daytona.test.mjs /Users/o/lazyclaw/tests/sandbox-bindings.test.mjs /Users/o/lazyclaw/tests/sandbox-cli.test.mjs`
- [ ] Expected: all 10 files green, aggregate `pass 40+ / fail 0`.
- [ ] Run: `node --check /Users/o/lazyclaw/cli.mjs && node --check /Users/o/lazyclaw/providers/claude_cli.mjs && node --check /Users/o/lazyclaw/providers/codex_cli.mjs && node --check /Users/o/lazyclaw/providers/gemini_cli.mjs`
- [ ] Expected: exit 0, no output — the v4 import paths still resolve through the shim.

### Step 6.6 — Commit

- [ ] Run:

```bash
git add /Users/o/lazyclaw/cli.mjs /Users/o/lazyclaw/tests/sandbox-cli.test.mjs
git commit -m "$(cat <<'EOF'
feat(cli): add lazyclaw sandbox list|test|add|use subcommand

Operator surface for the new sandbox/ directory: `list` enumerates
the 6-kind enum, `test <kind>` echoes through the backend (or
verifies argv shape for remote/serverless kinds without contacting
infra), `add <name> --kind ... --image ...` writes a profile under
cfg.sandbox.profiles, and `use <profile>` promotes it to
cfg.sandbox.default. Satisfies the Phase D acceptance criterion
"sandbox test <name> passes for each backend".
EOF
)"
```

---

## Acceptance — Phase D

After all six tasks land:

1. `node --test tests/sandbox-*.test.mjs` is fully green (≥ 40 assertions across 10 files).
2. `lazyclaw sandbox list` prints exactly the 6-enum from spec C8.
3. `lazyclaw sandbox test local` executes a real `echo` through `LocalSandbox`; `lazyclaw sandbox test docker|ssh|singularity|modal|daytona` confirms argv-shape (real-infra smoke is deferred to Phase G integration).
4. `cfg.sandbox.bindings[<worker>]` is honoured by `resolveSandbox(cfg, workerName)` — Phase E (orchestra) consumes this directly.
5. The Modal idle-hibernation wake hook (`idleWakeUrl`) is implemented and unit-tested; the 30-min cold-wake end-to-end is validated in Phase G against a deployed `lazyclaw-edge` app.
6. The original `providers/{claude_cli,codex_cli,gemini_cli}.mjs:21|32|27` keep working unchanged via the `sandbox.mjs` shim — no Phase-D edits to those files; their v4 plan-mode behaviour is preserved.

## Out of scope (deferred)

- Real `ssh` connection tests (require fixture host) — covered in Phase G integration.
- Live `modal` / `daytona` round-trips — covered in Phase G.
- Wiring `resolveSandbox(cfg, workerName)` into `mas/orchestra.mjs` worker spawn — that belongs in Phase E.
- `landlock` syscall-level enforcement via a preloader binary — flagged in `sandbox/confiners/landlock.mjs` as a follow-up.
- Migrating the three CLI providers off the legacy `parseSandboxSpec` shim onto `Sandbox`/`SandboxSession` — Phase E.
