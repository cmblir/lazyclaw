# TUI /gateway + splash persistence + stale-frame fix + motion package — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/gateway` slash command to the chat REPL, make the startup splash survive `/clear`, eliminate the stale duplicated status/border rows on the primary buffer, and ship a 7-feature terminal motion package.

**Architecture:** Everything lands in `tui/` as small focused modules that the existing REPL host wires in. Pure helpers (frame math, pidfile probes, slash handlers) live apart from React components so they unit-test without a TTY or an Ink mount. The `/clear` bug has a known mechanism and is fixed directly (`<Static>` remounted via a generation key so it re-prints). The stale-row bug does **not** have a proven mechanism yet — Task 5 builds a real Ink mount over a VT100 screen model to reproduce it before Task 6 fixes it.

**What is known vs. suspected about the stale rows.** Verified by reading `node_modules/ink/build/{ink,log-update}.js`: Ink erases by walking the cursor up `previousLineCount` rows from wherever the cursor currently is, and `tui/editor.mjs` deliberately parks the cursor up inside the editor box after every commit (for CJK/Hangul IME pre-edit). `tui/editor_anchor.mjs` compensates for this only when a chunk begins with `\x1b[2K`. Every Ink write path in 5.2.1 does call `log.clear()` first, so the compensation *usually* fires — which is why the exact trigger is still unknown. Suspects, in order: (a) writes that bypass Ink entirely — `commands/chat.mjs` hands the slash dispatcher a callback that writes straight to `process.stdout`, and background loop/cron code can write to `process.stderr`, neither of which Ink can erase; (b) the interleaving of `log` and `throttledLog` around a `<Static>` append; (c) a live frame at least as tall as the terminal, which switches Ink to its `clearTerminal + fullStaticOutput` branch. **Do not skip Task 5.** A fix applied without a reproduction is a guess.

**Tech Stack:** Node ≥18 ESM (`.mjs`), React 18 + Ink 5.2.1, chalk 5, string-width 7, `node --test` for tests.

## Global Constraints

- Language: code, comments, docstrings, commit messages in **English**. Assistant prose to the user in Korean.
- Every committed `.mjs` file must be ≤ 500 lines unless it appears in the `ALLOW` ratchet of `scripts/lint-file-size.mjs`. Ratcheted files **must not grow past their pinned ceiling**: `tui/slash_dispatcher.mjs` 1397, `tui/repl.mjs` 570, `commands/chat.mjs` 676. Run `npm run lint:size` before every commit.
- Git identity must be `cmblir <sodlalwl14@gmail.com>`. **No** `Co-Authored-By: Claude` and **no** `🤖 Generated with Claude Code` lines in any commit.
- Do not commit on `main` directly — create branch `feat/tui-gateway-motion` before Task 1 and commit there.
- All motion is gated by `motionEnabled()`: off when `LAZYCLAW_NO_MOTION=1`, when `NO_COLOR` is set, when `TERM=dumb`, or when stdout is not a TTY. `renderSplashToString()` output must stay byte-identical to today so the splash snapshot tests keep passing.
- Never write to `process.stdout` / `process.stderr` directly while Ink is mounted. Route through the REPL's `writeFn`/scrollback.
- Test command for a single file: `node --test tests/<name>.test.mjs`. Full suite: `node --test tests/*.test.mjs` (the `npm test` script also runs playwright; the node suite is what these tasks gate on).

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `tui/slash_basics.mjs` | The four trivial info slash handlers (`/help`, `/status`, `/version`, `/usage`) moved out of the dispatcher to free ratchet headroom. |
| `tui/slash_gateway.mjs` | `/gateway status\|start\|stop` handler. No React. |
| `tui/motion.mjs` | Motion primitives: spinner frames, elapsed formatting, tween, shimmer/reveal math, `motionEnabled()`, `useMotion()` hook. |
| `tui/splash_intro.mjs` | Pre-mount boot-reveal + wordmark-shimmer animation written straight to stdout before Ink mounts. |
| `tests/helpers/vt_screen.mjs` | Minimal VT100 screen simulator used to assert what the terminal actually shows after a byte stream. |
| `tests/helpers/repl_harness.mjs` | Mounts the real `ReplApp` over a fake TTY and funnels Ink's writes and the editor's cursor-anchor writes into one ordered byte log. |
| `tui/thinking.mjs` | The "waiting for the first token" indicator (and, per the ratchet mitigation, the shared `LiveRegion`). |

**Modified files**

| File | Change |
|---|---|
| `commands/daemon.mjs` | Generalize the pidfile probe/stop helpers so the gateway can reuse them. |
| `commands/gateway.mjs` | Write/remove `gateway.pid`; export `_gatewayPidfilePath`, `gatewayStatus`, `gatewayStop`. |
| `tui/slash_commands.mjs` | Add the `/gateway` catalog row. |
| `tui/slash_dispatcher.mjs` | Remove the four extracted handlers; import them plus the gateway handler; register `/gateway`. **Must end ≤ 1397 lines.** |
| `tui/repl_reducers.mjs` | Add `generation` to `makeReplState`. |
| `tui/repl_reset.mjs` | Bump `generation` in `onConversationReset`. |
| `tui/repl.mjs` | `<Static key>`; thinking indicator; error-flash timestamp plumbing. **Must end ≤ 570 lines.** |
| `tui/editor_anchor.mjs` | Compensate the pending anchor offset on any foreign write. |
| `tui/editor.mjs` | Tag the anchor's own write; red border flash on error. |
| `tui/status_bar.mjs` | Spinner + elapsed + tweened ctx gauge. |
| `tui/hud.mjs` | Live rate/cost segment. |
| `commands/chat.mjs` | Route the slash `write` callback into scrollback; play the splash intro before mount. **Must end ≤ 676 lines.** |
| `README.md`, `CHANGELOG.md` | Document `/gateway` and `LAZYCLAW_NO_MOTION`. |

---

### Task 0: Branch

- [ ] **Step 1: Create the working branch**

```bash
cd /Users/o/prj/lazyclaw
git checkout -b feat/tui-gateway-motion
git status
```

Expected: `On branch feat/tui-gateway-motion`, working tree clean.

---

### Task 1: Free ratchet headroom in the slash dispatcher

`tui/slash_dispatcher.mjs` is pinned at exactly 1397 lines. Adding the `/gateway` import + registration would break `npm run lint:size`. Extract the four trivial info handlers first — the same pattern the file already uses for `_channels`, `_trainer`, `_dashboard`.

**Files:**
- Create: `tui/slash_basics.mjs`
- Modify: `tui/slash_dispatcher.mjs:77-135` (delete `_help`, `_status`, `_version`, `_usage`), `tui/slash_dispatcher.mjs:33-55` (add import)
- Test: `tests/d6-slash-catalog-drift.test.mjs` (existing — must still pass)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `tui/slash_basics.mjs` exporting `_help(args, ctx)`, `_status(args, ctx)`, `_version(args, ctx)`, `_usage(args, ctx)` — each `async (args: string, ctx: object) => Promise<string>`, behavior byte-identical to the current dispatcher versions.

- [ ] **Step 1: Create `tui/slash_basics.mjs` with the four handlers moved verbatim**

```javascript
// tui/slash_basics.mjs — the four read-only info slash handlers (/help,
// /status, /version, /usage), extracted verbatim from slash_dispatcher.mjs.
//
// They were the smallest self-contained group in that file and moving them
// keeps the dispatcher under its file-size ratchet so new commands can be
// registered there. Behavior is unchanged: each takes (args, ctx) and
// returns the string the REPL appends to scrollback.

import { SLASH_COMMANDS } from './slash_commands.mjs';
import { _mod } from './slash_helpers.mjs';

export async function _help() {
  const lines = ['slash commands:'];
  for (const c of SLASH_COMMANDS) lines.push(`  ${c.cmd.padEnd(14)} — ${c.help}`);
  return lines.join('\n');
}

export async function _status(_args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  const provider = ctx.getActiveProvName();
  const model = ctx.getActiveModel() || '(default)';
  const keyMasked = registry.maskApiKey(ctx.cfg && ctx.cfg['api-key']);
  const messageCount = ctx.getMessages().length;
  const sessionId = ctx.getSessionId() || '(none — in-memory)';
  return [
    'status:',
    `  provider:  ${provider}`,
    `  model:     ${model}`,
    `  api key:   ${keyMasked}`,
    `  messages:  ${messageCount}`,
    `  session:   ${sessionId}`,
  ].join('\n');
}

export async function _version(_args, ctx) {
  const v = ctx.version || '0.0.0';
  return `lazyclaw ${v} (node ${process.version}, ${process.platform})`;
}

export async function _usage(_args, ctx) {
  const msgs = ctx.getMessages();
  const runningUsage = ctx.getRunningUsage && ctx.getRunningUsage();
  const charsSent = (ctx.getCharsSent && ctx.getCharsSent()) || 0;
  const lines = [
    'usage:',
    `  messages:  ${msgs.length}`,
    `  chars sent: ${charsSent.toLocaleString('en-US')}`,
  ];
  if (runningUsage) {
    lines.push(
      `  tokens in:  ${(runningUsage.inputTokens || 0).toLocaleString('en-US')}`,
      `  tokens out: ${(runningUsage.outputTokens || 0).toLocaleString('en-US')}`,
      `  tokens tot: ${(runningUsage.totalTokens || 0).toLocaleString('en-US')}`,
      `  turns:      ${runningUsage.turnsWithUsage || 0}`,
    );
    if (ctx.cfg && ctx.cfg.rates && typeof ctx.cfg.rates === 'object') {
      try {
        const { costFromUsage } = await import('../providers/rates.mjs');
        const r = costFromUsage(
          { provider: ctx.getActiveProvName(), model: ctx.getActiveModel(), usage: runningUsage },
          ctx.cfg.rates,
        );
        if (r && r.totalUsd != null) {
          lines.push(`  cost (USD): $${Number(r.totalUsd).toFixed(4)}`);
        }
      } catch { /* never let cost-card lookup fail the slash */ }
    }
  }
  return lines.join('\n');
}
```

- [ ] **Step 2: Delete lines 77-135 of `tui/slash_dispatcher.mjs`**

Delete the block that starts with the `// ─── handlers ───` banner's first four functions — from `async function _help() {` through the closing `}` of `_usage`, inclusive — but **keep** the `// ─── handlers ───` banner comment itself and keep `_newReset` (it stays in the dispatcher because the REPL's reset sentinel is coupled to it).

- [ ] **Step 3: Add the import next to the other extracted-handler imports**

In `tui/slash_dispatcher.mjs`, immediately after the existing `import { _trainer } from './slash_trainer.mjs';` line, add:

```javascript
import { _help, _status, _version, _usage } from './slash_basics.mjs';
```

- [ ] **Step 4: Verify the dispatcher shrank and nothing drifted**

```bash
wc -l tui/slash_dispatcher.mjs
npm run lint:size
node --test tests/d6-slash-catalog-drift.test.mjs
```

Expected: line count ~1339 (well under 1397); `lint:size` exits 0; all four drift tests PASS.

- [ ] **Step 5: Run the broader slash suite for regressions**

```bash
node --test tests/v53-slash-popup.test.mjs tests/v53-slash-exit.test.mjs tests/f-config-picker.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tui/slash_basics.mjs tui/slash_dispatcher.mjs
git commit -m "refactor(tui): extract /help /status /version /usage into slash_basics

slash_dispatcher.mjs sat exactly on its file-size ratchet (1397), so no new
command could be registered there. These four handlers were the smallest
self-contained group; moving them mirrors the existing slash_channels /
slash_trainer / slash_dashboard extractions and frees ~58 lines."
```

---

### Task 2: Gateway pidfile + status/stop helpers

`runGateway()` never records a pid, so nothing can tell whether a gateway is running. Give it the same pidfile contract the daemon already has, and generalize the daemon's probe helpers so both share one implementation.

**Files:**
- Modify: `commands/daemon.mjs:19-67` (generalize), `commands/gateway.mjs` (write pidfile in `cmdGateway`, export helpers)
- Test: `tests/f-gateway-pidfile.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `commands/daemon.mjs` → `pidfileStatus(pidfilePath: string, deps?: {isAlive?}) => {running: boolean, pid: number|null, port: number|null}` and `pidfileStop(pidfilePath: string, deps?: {isAlive?, kill?}) => {running, pid, port, killed, exitCode}`. Existing `readDaemonPidfile`, `daemonStatus`, `daemonStop`, `_daemonPidfilePath` keep their exact current signatures.
  - `commands/gateway.mjs` → `_gatewayPidfilePath(configDir: string) => string`, `gatewayStatus({configDir}, deps?) => {running, pid, port}`, `gatewayStop({configDir}, deps?) => {running, pid, port, killed, exitCode}`.

- [ ] **Step 1: Write the failing test**

Create `tests/f-gateway-pidfile.test.mjs`:

```javascript
// tests/f-gateway-pidfile.test.mjs — the gateway records a pidfile so
// `/gateway status` and `/gateway stop` can find a running instance, and the
// shared pidfile helpers treat a dead pid as "not running" + self-heal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pidfileStatus, pidfileStop } from '../commands/daemon.mjs';
import { _gatewayPidfilePath, gatewayStatus, gatewayStop } from '../commands/gateway.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-gw-'));
}

test('_gatewayPidfilePath sits next to the daemon pidfile', () => {
  assert.equal(_gatewayPidfilePath('/cfg'), path.join('/cfg', 'gateway.pid'));
});

test('pidfileStatus reports a live pid as running', () => {
  const dir = tmpDir();
  const pf = path.join(dir, 'gateway.pid');
  fs.writeFileSync(pf, JSON.stringify({ pid: 4242, port: 19600 }));
  const st = pidfileStatus(pf, { isAlive: (pid) => pid === 4242 });
  assert.deepEqual(st, { running: true, pid: 4242, port: 19600 });
});

test('pidfileStatus removes a stale pidfile and reports not-running', () => {
  const dir = tmpDir();
  const pf = path.join(dir, 'gateway.pid');
  fs.writeFileSync(pf, JSON.stringify({ pid: 4242, port: 19600 }));
  const st = pidfileStatus(pf, { isAlive: () => false });
  assert.equal(st.running, false);
  assert.equal(fs.existsSync(pf), false, 'stale pidfile must be cleaned up');
});

test('pidfileStatus treats a missing or corrupt pidfile as not-running', () => {
  const dir = tmpDir();
  assert.deepEqual(
    pidfileStatus(path.join(dir, 'nope.pid'), { isAlive: () => true }),
    { running: false, pid: null, port: null },
  );
  const bad = path.join(dir, 'gateway.pid');
  fs.writeFileSync(bad, 'not json');
  assert.equal(pidfileStatus(bad, { isAlive: () => true }).running, false);
});

test('pidfileStop SIGTERMs the recorded pid and removes the pidfile', () => {
  const dir = tmpDir();
  const pf = path.join(dir, 'gateway.pid');
  fs.writeFileSync(pf, JSON.stringify({ pid: 777, port: 19600 }));
  const signals = [];
  let alive = true;
  const res = pidfileStop(pf, {
    isAlive: () => alive,
    kill: (pid, sig) => { signals.push([pid, sig]); alive = false; },
  });
  assert.deepEqual(signals, [[777, 'SIGTERM']]);
  assert.equal(res.running, true);
  assert.equal(res.killed, true);
  assert.equal(fs.existsSync(pf), false);
});

test('gatewayStatus / gatewayStop delegate to the gateway pidfile', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'gateway.pid'), JSON.stringify({ pid: 99, port: 19600 }));
  const st = gatewayStatus({ configDir: dir }, { isAlive: (p) => p === 99 });
  assert.deepEqual(st, { running: true, pid: 99, port: 19600 });

  const stopped = gatewayStop({ configDir: dir }, {
    isAlive: () => false,
    kill: () => { throw new Error('must not signal a dead pid'); },
  });
  assert.equal(stopped.running, false);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test tests/f-gateway-pidfile.test.mjs
```

Expected: FAIL — `SyntaxError: The requested module '../commands/daemon.mjs' does not provide an export named 'pidfileStatus'`.

- [ ] **Step 3: Generalize the daemon helpers**

In `commands/daemon.mjs`, replace the bodies of `daemonStatus` and `daemonStop` (lines 30-67) with delegating versions and add the two generic helpers above them:

```javascript
// Inspect a pidfile and report liveness. A pidfile pointing at a dead pid is
// stale (the process crashed without removing it), so we clean it up here to
// keep `status` self-healing. Shared by the daemon and the gateway.
export function pidfileStatus(pidfilePath, deps = {}) {
  const isAlive = deps.isAlive || isProcessAlive;
  const rec = readDaemonPidfile(pidfilePath);
  if (!rec) return { running: false, pid: null, port: null };
  if (isAlive(rec.pid)) return { running: true, pid: rec.pid, port: rec.port };
  try { fs.rmSync(pidfilePath); } catch { /* already gone */ }
  return { running: false, pid: null, port: null };
}

// SIGTERM the recorded process, falling back to SIGKILL only if it ignores the
// graceful signal. Returns { running, pid, port, killed, exitCode }; a missing
// or dead pidfile is "not running" (exit 0), never an error.
export function pidfileStop(pidfilePath, deps = {}) {
  const isAlive = deps.isAlive || isProcessAlive;
  const kill = deps.kill || ((pid, sig) => process.kill(pid, sig));
  const rec = readDaemonPidfile(pidfilePath);
  if (!rec || !isAlive(rec.pid)) {
    try { fs.rmSync(pidfilePath); } catch { /* nothing to clean */ }
    return { running: false, pid: rec ? rec.pid : null, port: rec ? rec.port : null, killed: false, exitCode: 0 };
  }
  try { kill(rec.pid, 'SIGTERM'); } catch { /* raced with exit */ }
  // Short grace window, then SIGKILL the holdout. Synchronous so the CLI exits
  // deterministically; the process's own shutdown hook usually wins inside it.
  if (isAlive(rec.pid)) {
    const until = Date.now() + 1500;
    while (isAlive(rec.pid) && Date.now() < until) { /* spin briefly */ }
    if (isAlive(rec.pid)) { try { kill(rec.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  try { fs.rmSync(pidfilePath); } catch { /* removed by the process already */ }
  return { running: true, pid: rec.pid, port: rec.port, killed: true, exitCode: 0 };
}

export function daemonStatus({ configDir }, deps = {}) {
  return pidfileStatus(_daemonPidfilePath(configDir), deps);
}

export function daemonStop({ configDir }, deps = {}) {
  return pidfileStop(_daemonPidfilePath(configDir), deps);
}
```

- [ ] **Step 4: Add the gateway pidfile helpers**

In `commands/gateway.mjs`, add after the `PLUGIN_CHANNELS` export:

```javascript
// The gateway runs in the foreground like the bare daemon, so a started
// gateway records its pid + bound port here. `/gateway status|stop` and
// `lazyclaw service` read it back; cmdGateway removes it on shutdown.
export function _gatewayPidfilePath(configDir) {
  return path.join(configDir, 'gateway.pid');
}

export function gatewayStatus({ configDir }, deps = {}) {
  return pidfileStatus(_gatewayPidfilePath(configDir), deps);
}

export function gatewayStop({ configDir }, deps = {}) {
  return pidfileStop(_gatewayPidfilePath(configDir), deps);
}
```

and add to the import block at the top:

```javascript
import { pidfileStatus, pidfileStop } from './daemon.mjs';
```

- [ ] **Step 5: Write + remove the pidfile in `cmdGateway`**

In `commands/gateway.mjs`, inside `cmdGateway`, immediately after the `process.stderr.write('[gateway] running. Ctrl-C to stop.\n');` line, insert:

```javascript
  // Record pid + the ACTUAL bound port so `/gateway status|stop` and
  // `lazyclaw service` can find us without an lsof on the port.
  const pidfile = _gatewayPidfilePath(path.dirname(configPath()));
  try { fs.writeFileSync(pidfile, JSON.stringify({ pid: process.pid, port: gw.port })); }
  catch { /* non-fatal: the gateway still runs, just isn't stoppable by pidfile */ }
  const removePidfile = () => { try { fs.rmSync(pidfile); } catch { /* already gone */ } };
```

Then change the crash-handler line and the signal handler so both clean up:

```javascript
  installCrashHandlers({ label: 'gateway', stop: () => { removePidfile(); return gw.stop(); } });
```

and inside `onSig`, immediately before `try { await gw.stop(); }`, add `removePidfile();`.

- [ ] **Step 6: Run the test to verify it passes**

```bash
node --test tests/f-gateway-pidfile.test.mjs
```

Expected: all 6 tests PASS.

- [ ] **Step 7: Verify no daemon regression**

```bash
node --test tests/*daemon*.test.mjs tests/phase27-gateway.spec.ts 2>/dev/null || node --test $(ls tests/*.test.mjs | xargs grep -l "daemonStatus\|daemonStop\|commands/daemon")
npm run lint:size
```

Expected: PASS; `lint:size` exits 0.

- [ ] **Step 8: Commit**

```bash
git add commands/daemon.mjs commands/gateway.mjs tests/f-gateway-pidfile.test.mjs
git commit -m "feat(gateway): record a pidfile so status/stop can find a running gateway

runGateway never recorded a pid, so nothing could tell whether a gateway was
up. Generalize the daemon's pidfile probe/stop helpers (pidfileStatus /
pidfileStop) and reuse them for gateway.pid."
```

---

### Task 3: `/gateway` slash command

**Files:**
- Create: `tui/slash_gateway.mjs`
- Modify: `tui/slash_commands.mjs` (catalog row), `tui/slash_dispatcher.mjs` (import + registration)
- Test: `tests/f-slash-gateway.test.mjs` (create)

**Interfaces:**
- Consumes: `gatewayStatus`, `gatewayStop`, `_gatewayPidfilePath` from Task 2.
- Produces: `tui/slash_gateway.mjs` → `gatewaySlash(args: string, ctx: object, deps?: object) => Promise<string>`. `deps` is dependency injection for tests: `{ status?, stop?, spawn?, fetch?, readToken?, sleep? }`. Never throws; every failure path returns a human-readable string.

- [ ] **Step 1: Write the failing test**

Create `tests/f-slash-gateway.test.mjs`:

```javascript
// tests/f-slash-gateway.test.mjs — /gateway status|start|stop inside the chat
// REPL. Everything external (pidfile probe, health fetch, child spawn) is
// injected so the test never touches a real port or process.
import test from 'node:test';
import assert from 'node:assert/strict';

import { gatewaySlash } from '../tui/slash_gateway.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';
import { SLASH_HANDLERS } from '../tui/slash_dispatcher.mjs';

const ctx = { cfgDir: '/cfg', cfg: { channels: { slack: { enabled: true }, telegram: { enabled: false } } } };

test('/gateway is in the catalog and has a handler', () => {
  assert.ok(SLASH_COMMANDS.some((c) => c.cmd === '/gateway'), 'catalog row missing');
  assert.ok(SLASH_HANDLERS.has('/gateway'), 'handler not registered');
});

test('status reports a stopped gateway', async () => {
  const out = await gatewaySlash('', ctx, {
    status: () => ({ running: false, pid: null, port: null }),
    readToken: () => null,
  });
  assert.match(out, /not running/);
  assert.match(out, /\/gateway start/);
});

test('status reports a running gateway with health, port and channels', async () => {
  const out = await gatewaySlash('status', ctx, {
    status: () => ({ running: true, pid: 4242, port: 19600 }),
    readToken: () => 'tok',
    fetch: async (url, opts) => {
      assert.equal(url, 'http://127.0.0.1:19600/health');
      assert.equal(opts.headers.authorization, 'Bearer tok');
      return { ok: true, status: 200 };
    },
  });
  assert.match(out, /running/);
  assert.match(out, /pid 4242/);
  assert.match(out, /19600/);
  assert.match(out, /healthy/);
  assert.match(out, /slack/);
  assert.doesNotMatch(out, /telegram/, 'disabled channels must not be listed as enabled');
});

test('status reports a listening-but-unauthorized gateway distinctly', async () => {
  const out = await gatewaySlash('status', ctx, {
    status: () => ({ running: true, pid: 1, port: 19600 }),
    readToken: () => 'stale',
    fetch: async () => ({ ok: false, status: 401 }),
  });
  assert.match(out, /auth token mismatch/);
});

test('status survives a health probe that never answers', async () => {
  const out = await gatewaySlash('status', ctx, {
    status: () => ({ running: true, pid: 1, port: 19600 }),
    readToken: () => null,
    fetch: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  assert.match(out, /unreachable/);
});

test('start refuses when a gateway is already running', async () => {
  const out = await gatewaySlash('start', ctx, {
    status: () => ({ running: true, pid: 7, port: 19600 }),
    spawn: () => { throw new Error('must not spawn'); },
  });
  assert.match(out, /already running/);
});

test('start spawns a detached gateway and waits for it to come up', async () => {
  let spawned = null;
  let probes = 0;
  const out = await gatewaySlash('start', ctx, {
    status: () => (probes++ === 0 ? { running: false, pid: null, port: null }
                                  : { running: true, pid: 900, port: 19600 }),
    spawn: (cmd, argv, opts) => {
      spawned = { cmd, argv, opts };
      return { unref() {} };
    },
    sleep: async () => {},
  });
  assert.ok(spawned, 'spawn was not called');
  assert.deepEqual(spawned.argv.slice(-1), ['gateway']);
  assert.equal(spawned.opts.detached, true);
  assert.equal(spawned.opts.stdio, 'ignore');
  assert.match(out, /started/);
  assert.match(out, /pid 900/);
});

test('start reports a gateway that never came up instead of hanging', async () => {
  const out = await gatewaySlash('start', ctx, {
    status: () => ({ running: false, pid: null, port: null }),
    spawn: () => ({ unref() {} }),
    sleep: async () => {},
  });
  assert.match(out, /did not come up/);
});

test('stop signals a running gateway', async () => {
  const out = await gatewaySlash('stop', ctx, {
    stop: () => ({ running: true, pid: 4242, port: 19600, killed: true, exitCode: 0 }),
  });
  assert.match(out, /stopped/);
  assert.match(out, /4242/);
});

test('stop on a stopped gateway is not an error', async () => {
  const out = await gatewaySlash('stop', ctx, {
    stop: () => ({ running: false, pid: null, port: null, killed: false, exitCode: 0 }),
  });
  assert.match(out, /not running/);
});

test('an unknown subcommand lists the valid ones', async () => {
  const out = await gatewaySlash('bogus', ctx, {});
  assert.match(out, /status/);
  assert.match(out, /start/);
  assert.match(out, /stop/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test tests/f-slash-gateway.test.mjs
```

Expected: FAIL — `Cannot find module '.../tui/slash_gateway.mjs'`.

- [ ] **Step 3: Create `tui/slash_gateway.mjs`**

```javascript
// tui/slash_gateway.mjs — `/gateway status|start|stop` for the chat REPL.
//
// `lazyclaw gateway` has always been a top-level CLI command, so the only way
// to check on it from a chat session was to leave the session. This exposes
// the three operations that matter in-chat. Everything external (pidfile
// probe, health fetch, child spawn) is injectable so the handler unit-tests
// without a port or a process.
//
// Contract: never throws. Every failure path returns a readable string, which
// the REPL appends to scrollback like any other slash result.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gatewayStatus, gatewayStop, _gatewayPidfilePath,
  GATEWAY_CHANNELS, PLUGIN_CHANNELS,
} from '../commands/gateway.mjs';

const SUBCOMMANDS = ['status', 'start', 'stop'];
// How long `/gateway start` waits for the child to record its pidfile before
// giving up. The spawn itself is fire-and-forget; this only bounds the report.
const START_TIMEOUT_MS = 6000;
const START_POLL_MS = 250;
const HEALTH_TIMEOUT_MS = 1500;

function _cliEntrypoint() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
}

function _readToken(cfgDir) {
  try {
    return fs.readFileSync(path.join(cfgDir, 'gateway.token'), 'utf8').trim() || null;
  } catch { return null; }
}

// Which channels the config says the gateway would run. Mirrors
// _selectChannels' "enabled unless explicitly disabled" rule without importing
// the flags path — this is a report, not a launch decision.
function _enabledChannels(cfg) {
  const configured = (cfg && cfg.channels && typeof cfg.channels === 'object') ? cfg.channels : {};
  const runnable = [...GATEWAY_CHANNELS, ...PLUGIN_CHANNELS];
  return runnable.filter((n) => configured[n] && configured[n].enabled !== false);
}

async function _probeHealth(port, token, doFetch) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/health`, {
      headers,
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (res.ok) return 'healthy';
    if (res.status === 401) return 'listening (auth token mismatch — re-read gateway.token)';
    return `listening (HTTP ${res.status})`;
  } catch {
    return 'unreachable (process alive but not answering /health)';
  }
}

async function _status(cfgDir, cfg, d) {
  const st = d.status({ configDir: cfgDir });
  if (!st.running) {
    return [
      'gateway: not running',
      `  pidfile: ${_gatewayPidfilePath(cfgDir)}`,
      '  start it with /gateway start',
    ].join('\n');
  }
  const token = d.readToken(cfgDir);
  const health = await _probeHealth(st.port, token, d.fetch);
  const channels = _enabledChannels(cfg);
  return [
    'gateway: running',
    `  pid:      ${st.pid}`,
    `  url:      http://127.0.0.1:${st.port}`,
    `  health:   ${health}`,
    `  auth:     ${token ? 'token present (gateway.token)' : 'no token file — open loopback'}`,
    `  channels: ${channels.length ? channels.join(' · ') : '(none enabled — daemon core only)'}`,
  ].join('\n');
}

async function _start(cfgDir, d) {
  const before = d.status({ configDir: cfgDir });
  if (before.running) {
    return `gateway: already running (pid ${before.pid}, http://127.0.0.1:${before.port})`;
  }
  try {
    const child = d.spawn(process.execPath, [_cliEntrypoint(), 'gateway'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    return `gateway: could not spawn — ${err?.message || err}`;
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await d.sleep(START_POLL_MS);
    const st = d.status({ configDir: cfgDir });
    if (st.running) {
      return `gateway: started (pid ${st.pid}, http://127.0.0.1:${st.port}) — /gateway status for detail`;
    }
  }
  return [
    'gateway: spawned but did not come up within 6s.',
    '  Run `lazyclaw gateway` in a terminal to see why (config guard, port in use, channel creds).',
  ].join('\n');
}

function _stop(cfgDir, d) {
  const res = d.stop({ configDir: cfgDir });
  if (!res.running) return 'gateway: not running (nothing to stop)';
  return `gateway: stopped (pid ${res.pid})`;
}

export async function gatewaySlash(args, ctx = {}, deps = {}) {
  const d = {
    status: deps.status || gatewayStatus,
    stop: deps.stop || gatewayStop,
    readToken: deps.readToken || _readToken,
    fetch: deps.fetch || ((...a) => fetch(...a)),
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
    spawn: deps.spawn || null,
  };
  const cfgDir = ctx.cfgDir || '.';
  const sub = String(args || '').trim().split(/\s+/)[0].toLowerCase() || 'status';
  try {
    if (sub === 'status') return await _status(cfgDir, ctx.cfg || {}, d);
    if (sub === 'stop') return _stop(cfgDir, d);
    if (sub === 'start') {
      if (!d.spawn) {
        const { spawn } = await import('node:child_process');
        d.spawn = spawn;
      }
      return await _start(cfgDir, d);
    }
  } catch (err) {
    return `gateway: ${err?.message || err}`;
  }
  return `gateway: unknown subcommand "${sub}" — try ${SUBCOMMANDS.map((s) => `/gateway ${s}`).join(' · ')}`;
}
```

- [ ] **Step 4: Add the catalog row**

In `tui/slash_commands.mjs`, insert immediately after the `/dashboard` row:

```javascript
  { cmd: '/gateway',     help: 'gateway: status · start (background) · stop' },
```

- [ ] **Step 5: Register the handler**

In `tui/slash_dispatcher.mjs`, add to the import block (next to the `slash_basics` import from Task 1):

```javascript
import { gatewaySlash } from './slash_gateway.mjs';
```

and add to `SLASH_HANDLERS`, immediately after the `['/dashboard', _dashboard],` entry:

```javascript
  ['/gateway', gatewaySlash],
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node --test tests/f-slash-gateway.test.mjs tests/d6-slash-catalog-drift.test.mjs
npm run lint:size
```

Expected: all `f-slash-gateway` tests PASS, drift guard PASSES, `lint:size` exits 0.

- [ ] **Step 7: Commit**

```bash
git add tui/slash_gateway.mjs tui/slash_commands.mjs tui/slash_dispatcher.mjs tests/f-slash-gateway.test.mjs
git commit -m "feat(tui): add /gateway status|start|stop slash command

The gateway was only reachable as a top-level CLI command, so checking on it
meant leaving the chat session. status reports pid/port/health/auth/channels,
start spawns a detached gateway and waits for its pidfile, stop SIGTERMs it.
All external effects are injectable so the handler unit-tests without a port."
```

---

### Task 4: Re-print the splash after `/clear`

`/clear` wipes the terminal and resets scrollback to `[splash]`, but the non-alt path renders scrollback through Ink's `<Static>`, which is write-once: its internal `lastIndex` has already passed item 0, so the retained splash is never re-emitted. Remounting `<Static>` via a changing `key` resets that index and makes Ink write the splash again.

**Files:**
- Modify: `tui/repl_reducers.mjs:16-28`, `tui/repl_reset.mjs:10-25`, `tui/repl.mjs:438-442`
- Test: `tests/f-clear-splash-persist.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `makeReplState()` gains a `generation: number` field (starts at `0`); `onConversationReset(state)` returns `generation: state.generation + 1`. `ReplApp` renders its non-alt `<Static>` with `key: \`sb-${state.generation}\``.

- [ ] **Step 1: Write the failing test**

Create `tests/f-clear-splash-persist.test.mjs`:

```javascript
// tests/f-clear-splash-persist.test.mjs — /clear must leave the splash on
// screen, not a blank void.
//
// Mechanism under test: Ink's <Static> is write-once (it tracks how many items
// it has already emitted), so resetting React state back to [splash] does not
// re-print it. ReplApp keys the <Static> by state.generation; onConversationReset
// bumps that generation, which remounts <Static> and re-emits every item.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReplState, onUserInput, onStreamChunk, onTurnComplete } from '../tui/repl_reducers.mjs';
import { onConversationReset, CLEAR_TERMINAL } from '../tui/repl_reset.mjs';

const splashItem = { kind: 'splash', id: 'splash-0', splashProps: { provider: 'anthropic', model: 'm' } };

test('makeReplState starts at generation 0', () => {
  assert.equal(makeReplState().generation, 0);
  assert.equal(makeReplState({ splashItem }).generation, 0);
});

test('onConversationReset keeps the splash and bumps the generation', () => {
  let s = makeReplState({ splashItem });
  const ctrl = { abort: () => {} };
  s = onUserInput(s, { text: 'hi', controller: ctrl });
  s = onStreamChunk(s, { chunk: 'there' });
  s = onTurnComplete(s, { reason: 'done' });
  assert.ok(s.scrollback.length > 1);

  const cleared = onConversationReset(s);
  assert.equal(cleared.scrollback.length, 1);
  assert.equal(cleared.scrollback[0].kind, 'splash');
  assert.equal(cleared.generation, 1, 'generation must change so <Static> remounts');
  assert.equal(cleared.liveAssistant, '');
  assert.equal(cleared.streaming, false);
});

test('repeated resets keep bumping the generation', () => {
  let s = makeReplState({ splashItem });
  s = onConversationReset(s);
  s = onConversationReset(s);
  s = onConversationReset(s);
  assert.equal(s.generation, 3);
});

test('a reset with no splash item still bumps the generation', () => {
  const s = onConversationReset(makeReplState());
  assert.deepEqual(s.scrollback, []);
  assert.equal(s.generation, 1);
});

test('CLEAR_TERMINAL wipes the screen AND the scrollback buffer', () => {
  // \x1b[3J is the part that drops the scrollback buffer; without it the old
  // conversation is still reachable by scrolling up.
  assert.ok(CLEAR_TERMINAL.includes('\x1b[3J'));
  assert.ok(CLEAR_TERMINAL.includes('\x1b[2J'));
  assert.ok(CLEAR_TERMINAL.endsWith('\x1b[H'));
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test tests/f-clear-splash-persist.test.mjs
```

Expected: FAIL — `Expected values to be strictly equal: undefined !== 0` on the generation assertions.

- [ ] **Step 3: Add `generation` to the initial state**

In `tui/repl_reducers.mjs`, inside the object returned by `makeReplState`, add after `turnCounter: 0,`:

```javascript
    // Bumped by onConversationReset. ReplApp keys its <Static> scrollback by
    // this so a /clear remounts it — Ink's <Static> is write-once, so without
    // a remount the retained splash item is never re-printed.
    generation: 0,
```

- [ ] **Step 4: Bump it on reset**

In `tui/repl_reset.mjs`, inside the object returned by `onConversationReset`, add after `scrollback: splash ? [splash] : [],`:

```javascript
    generation: (state.generation || 0) + 1,
```

- [ ] **Step 5: Key the `<Static>` by generation**

In `tui/repl.mjs`, change the non-alt branch (currently `React.createElement(Static, { items: state.scrollback }, ...)`) so the props object becomes:

```javascript
            { key: `sb-${state.generation}`, items: state.scrollback },
```

Keep everything else on that call identical — it must stay one line so `tui/repl.mjs` does not grow past its 570-line ceiling.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node --test tests/f-clear-splash-persist.test.mjs tests/v53-repl-layout.test.mjs tests/phaseC-repl-interrupt.test.mjs
wc -l tui/repl.mjs
npm run lint:size
```

Expected: all PASS; `tui/repl.mjs` still 570 lines; `lint:size` exits 0.

- [ ] **Step 7: Manual TTY check**

```bash
node cli.mjs
```

Type `/clear`, then Enter. Expected: the screen wipes and the sloth banner + command manual re-appear above the prompt (not a blank screen). Type `/exit` to leave. Record the result in the commit body only if it differs from the expectation.

- [ ] **Step 8: Commit**

```bash
git add tui/repl_reducers.mjs tui/repl_reset.mjs tui/repl.mjs tests/f-clear-splash-persist.test.mjs
git commit -m "fix(tui): re-print the splash after /clear

Ink's <Static> is write-once: it tracks how many items it has already emitted,
so resetting React state back to [splash] left the screen blank. Key the
<Static> by a generation counter that onConversationReset bumps, which
remounts it and re-emits the splash."
```

---

### Task 5: Terminal screen simulator + reproduce the stale rows

The duplicated `○ idle …` rows and orphaned editor borders are an Ink erase/cursor desync, but **the exact trigger is not yet known** (see the architecture note at the top of this plan). This task builds the instrument: mount the real `ReplApp` over a fake TTY, capture every byte both Ink and the editor's cursor anchor emit, and replay them through a VT100 model to get the screen the user would actually see. Then drive it until it reproduces.

This is a systematic-debugging task, not a scripted one. Its deliverable is a **failing test that shows a duplicated status row**. Do not move on to Task 6 with a green suite — a fix without a reproduction is a guess, and the fix in Task 6 would be unverifiable.

**Files:**
- Create: `tests/helpers/vt_screen.mjs`, `tests/helpers/repl_harness.mjs`, `tests/f-repl-no-stale-rows.test.mjs`
- Test: all three of the above

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `tests/helpers/vt_screen.mjs` → `makeScreen({rows, columns}) => screen` where `screen.write(chunk: string) => void`, `screen.lines() => string[]` (trailing blank lines trimmed), `screen.text() => string`. Handles: printable text, `\n`, `\r`, `\x1b[<n>A`/`B`/`G`, `\x1b[2K`, `\x1b[2J`, `\x1b[3J`, `\x1b[H`, `\x1b[J`, `\x1b[?25h`/`l`, and skips any other CSI/SGR sequence without printing it.

- [ ] **Step 1: Write the screen simulator**

Create `tests/helpers/vt_screen.mjs`:

```javascript
// tests/helpers/vt_screen.mjs — a minimal VT100 screen model.
//
// Ink draws by moving the cursor and erasing lines, so asserting on the raw
// byte stream tells you nothing about what the user sees. This replays a byte
// stream into a grid of lines so a test can assert "the status row appears
// exactly once on screen".
//
// Deliberately partial: it implements only the sequences lazyclaw + Ink emit.
// Anything else is consumed and ignored rather than printed as literal text.

export function makeScreen({ rows = 40, columns = 100 } = {}) {
  let grid = [''];
  let row = 0;
  let col = 0;

  const ensureRow = (r) => { while (grid.length <= r) grid.push(''); };
  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

  function put(text) {
    ensureRow(row);
    const line = pad(grid[row], col);
    grid[row] = line.slice(0, col) + text + line.slice(col + text.length);
    col += text.length;
  }

  function newline() { row += 1; col = 0; ensureRow(row); }

  function write(chunk) {
    const s = String(chunk);
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(s.slice(i));
        if (!m) { i += 1; continue; }           // lone ESC / unsupported: drop
        const [seq, rawArgs, fin] = m;
        const n = parseInt(rawArgs, 10);
        const count = Number.isFinite(n) ? n : 1;
        if (fin === 'A') row = Math.max(0, row - count);
        else if (fin === 'B') { row += count; ensureRow(row); }
        else if (fin === 'G') col = Math.max(0, count - 1);
        else if (fin === 'C') col += count;
        else if (fin === 'D') col = Math.max(0, col - count);
        else if (fin === 'H') { row = 0; col = 0; }
        else if (fin === 'K') { ensureRow(row); grid[row] = rawArgs === '2' ? '' : grid[row].slice(0, col); }
        else if (fin === 'J') {
          if (rawArgs === '2' || rawArgs === '3') { grid = ['']; row = 0; col = 0; }
          else { grid = grid.slice(0, row + 1); }   // erase from cursor down
        }
        // every other final byte (m, h, l, …) is a no-op for the screen model
        i += seq.length;
        continue;
      }
      if (ch === '\n') { newline(); i += 1; continue; }
      if (ch === '\r') { col = 0; i += 1; continue; }
      // Run of printable characters up to the next control byte.
      let j = i;
      while (j < s.length && s[j] !== '\x1b' && s[j] !== '\n' && s[j] !== '\r') j += 1;
      put(s.slice(i, j));
      i = j;
    }
  }

  function lines() {
    const out = grid.map((l) => l.replace(/\s+$/, ''));
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }

  return { write, lines, text: () => lines().join('\n'), get rows() { return rows; }, get columns() { return columns; } };
}

// Count how many rendered lines contain `needle` (after stripping SGR codes).
export function countLines(screen, needle) {
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  return screen.lines().filter((l) => plain(l).includes(needle)).length;
}
```

- [ ] **Step 2: Write the mount harness**

The editor's cursor anchor writes to the **real** `process.stdout` and bails when `process.stdout.isTTY` is false — which it always is under `node --test`. So the harness has to fake a TTY on the real stream *and* give Ink its own fake stdout, with both feeding one ordered byte log. That single ordered log is the whole point: the bug is an ordering problem between Ink's writes and the anchor's writes.

Create `tests/helpers/repl_harness.mjs`:

```javascript
// tests/helpers/repl_harness.mjs — mount the real ReplApp over a fake TTY and
// capture every byte, in order, that reaches the terminal.
//
// Two writers reach the terminal: Ink (through the stdout we inject) and
// tui/editor.mjs's cursor anchor (hardcoded to process.stdout, and gated on
// process.stdout.isTTY, which is false under `node --test`). Both are funnelled
// into one array here — the stale-row bug is an ordering problem between them,
// so a capture that misses either one cannot show it.
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import React from 'react';
import { ReplApp } from '../../tui/repl.mjs';
import { anchorState } from '../../tui/editor_anchor.mjs';

function fakeStdout(sink, { columns, rows }) {
  const s = new EventEmitter();
  s.isTTY = true;
  s.columns = columns;
  s.rows = rows;
  s.write = (chunk) => { sink.push(String(chunk)); return true; };
  return s;
}

function fakeStdin() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.setRawMode = () => {};
  s.setEncoding = () => {};
  s.read = () => null;
  s.resume = () => {};
  s.pause = () => {};
  s.ref = () => {};
  s.unref = () => {};
  // Tests drive keystrokes with harness.type(); Ink listens on 'data'.
  s.write = (data) => { s.emit('data', data); };
  return s;
}

export function mountRepl(props = {}, { columns = 100, rows = 40 } = {}) {
  const bytes = [];
  const stdout = fakeStdout(bytes, { columns, rows });
  const stdin = fakeStdin();

  // Make the anchor believe it is on a real terminal and send its writes into
  // the same log. Saved so unmount() can put the process stream back.
  const saved = {
    write: process.stdout.write,
    isTTY: process.stdout.isTTY,
    columns: process.stdout.columns,
    offset: anchorState.offset,
    shimmed: anchorState.shimmed,
  };
  process.stdout.write = (chunk) => { bytes.push(String(chunk)); return true; };
  process.stdout.isTTY = true;
  process.stdout.columns = columns;
  anchorState.offset = 0;
  anchorState.shimmed = false;   // force a fresh shim over our recorder

  const instance = render(
    React.createElement(ReplApp, { runTurn: async () => {}, ...props }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );

  return {
    bytes,
    stdin,
    stdout,
    instance,
    type: (text) => { stdin.write(text); },
    // Let React flush effects + Ink flush its throttled log.
    settle: async (ms = 20) => { await new Promise((r) => setTimeout(r, ms)); },
    unmount: () => {
      try { instance.unmount(); } catch { /* already gone */ }
      process.stdout.write = saved.write;
      process.stdout.isTTY = saved.isTTY;
      process.stdout.columns = saved.columns;
      anchorState.offset = saved.offset;
      anchorState.shimmed = saved.shimmed;
    },
  };
}
```

- [ ] **Step 3: Write the simulator's unit tests and confirm they pass**

Create `tests/f-repl-no-stale-rows.test.mjs` with the simulator tests first, so a broken simulator can never be mistaken for a broken REPL:

```javascript
// tests/f-repl-no-stale-rows.test.mjs — the primary-buffer REPL must never
// leave orphaned status rows or editor borders on screen.
//
// Ink erases by walking the cursor UP previousLineCount rows from wherever the
// cursor currently is (node_modules/ink/build/log-update.js), and
// tui/editor.mjs deliberately parks the cursor up inside the editor box after
// every commit so a Hangul/CJK IME draws its pre-edit overlay at the caret.
// Any write that lands while that offset is pending shifts everything that
// follows, and the tail of the previous frame survives as a duplicate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScreen, countLines } from './helpers/vt_screen.mjs';
import { mountRepl } from './helpers/repl_harness.mjs';

const splashProps = {
  provider: 'claude-cli', model: 'claude-opus-5', version: '6.9.3',
  cwd: '/tmp/proj', tools: [], skills: [],
};

test('vt_screen models cursor-up + erase-line the way Ink draws', () => {
  const s = makeScreen();
  s.write('alpha\nbravo\n');
  assert.deepEqual(s.lines(), ['alpha', 'bravo']);
  // Ink redraw: erase 2 lines upward from the cursor, then write a new frame.
  s.write('\x1b[2K\x1b[1A\x1b[2K\x1b[Gcharlie\ndelta\n');
  assert.deepEqual(s.lines(), ['charlie', 'delta']);
});

test('vt_screen models the /clear sequence', () => {
  const s = makeScreen();
  s.write('old content\n');
  s.write('\x1b[2J\x1b[3J\x1b[H');
  assert.deepEqual(s.lines(), []);
  s.write('fresh\n');
  assert.deepEqual(s.lines(), ['fresh']);
});

test('vt_screen leaves an unerased tail visible — the artifact under test', () => {
  const s = makeScreen();
  s.write('frame-a-row1\nframe-a-row2\n');
  // Cursor parked one row up, then a new frame written from there: row2 of the
  // first frame is never erased and survives below the new one.
  s.write('\x1b[1A');
  s.write('frame-b-row1\n');
  assert.ok(s.text().includes('frame-a-row2'), 'the simulator must preserve unerased rows');
});
```

Run them:

```bash
node --test tests/f-repl-no-stale-rows.test.mjs
```

Expected: all three PASS. The simulator is now trustworthy.

- [ ] **Step 4: Reproduce the duplication**

Append a repro test to the same file and iterate on it until it fails for the right reason. Start with the cheapest scenario and escalate through the suspect list in order — after each change, run the test and read the screen dump it prints.

```javascript
// The repro. `scenario` is escalated until the duplication appears; the
// assertion is always the same: whatever the user did, the status row and the
// editor's top border must each appear exactly once on screen.
async function screenAfter(scenario, opts = {}) {
  const h = mountRepl({ splashProps, statusInfo: { provider: 'claude-cli', model: 'claude-opus-5' } }, opts);
  try {
    await h.settle();
    await scenario(h);
    await h.settle(50);
    const screen = makeScreen({ rows: opts.rows || 40, columns: opts.columns || 100 });
    for (const chunk of h.bytes) screen.write(chunk);
    return screen;
  } finally {
    h.unmount();
  }
}

test('typing leaves exactly one status row and one input box', async () => {
  const screen = await screenAfter(async (h) => {
    h.type('hello');
    await h.settle();
    h.type(' world');
  });
  assert.equal(countLines(screen, 'idle'), 1, `status row duplicated:\n${screen.text()}`);
  assert.equal(countLines(screen, '╭'), 1, `editor border duplicated:\n${screen.text()}`);
});

test('a write that bypasses Ink leaves exactly one status row', async () => {
  const screen = await screenAfter(async (h) => {
    h.type('hi');
    await h.settle();
    // Suspect (a): commands/chat.mjs hands the slash dispatcher a callback that
    // writes straight to process.stdout while Ink owns the screen.
    process.stdout.write('some slash handler output\n');
    await h.settle();
    h.type('!');
  });
  assert.equal(countLines(screen, 'idle'), 1, `status row duplicated:\n${screen.text()}`);
  assert.equal(countLines(screen, '╭'), 1, `editor border duplicated:\n${screen.text()}`);
});
```

Escalation order if neither test fails yet — add one scenario at a time and re-run:

1. Open the slash popup (`h.type('/')`), then dismiss it, so the frame height changes between renders.
2. Emit a `resize` on the harness stdout with new `rows`/`columns` mid-session.
3. Mount with `rows: 8` so the live frame approaches the terminal height and Ink switches to its `clearTerminal + fullStaticOutput` branch.
4. Interleave a `process.stderr.write(...)` (background loop/cron logging) between two commits.

**Stop when a test fails with a screen dump showing two `idle` rows.** Record which scenario did it in the commit message — that is the finding Task 6 fixes. If none of the four reproduce it after a genuine attempt, stop and report that to the user rather than applying a speculative fix: the two hardening changes in Task 6 are still worth landing, but they must then be described as hardening, not as a fix for this bug.

- [ ] **Step 5: Commit the harness and the red repro**

```bash
git add tests/helpers/vt_screen.mjs tests/helpers/repl_harness.mjs tests/f-repl-no-stale-rows.test.mjs
git commit -m "test(tui): reproduce the stale status rows over a VT screen model

Asserting on Ink's raw byte stream says nothing about what the user sees.
vt_screen replays the stream into a line grid; repl_harness mounts the real
ReplApp over a fake TTY and funnels both Ink's writes and the editor's cursor
anchor writes into one ordered log, because the bug is an ordering problem
between them.

Reproducing scenario: <fill in the scenario that failed>"
```

(Committing a known-failing test is intentional here — Task 6 lands immediately after and the two commits are reviewed together.)

---

### Task 6: Fix the stale rows

Two hardening changes, applied together. Which one is *the* fix depends on the scenario Task 5 reproduced — record that in the commit body. Both are independently correct regardless.

1. `editor_anchor.mjs` only undoes the pending cursor offset for chunks that start with `\x1b[2K` (log-update's `eraseLines` prefix). Any other write — Ink's raw `<Static>` output, `useStdout()` output, or a write from outside Ink entirely — lands at the raised cursor with the offset still pending. Compensating for *every* foreign write closes the whole class instead of one member of it.
2. `commands/chat.mjs` hands the slash dispatcher a `write` callback that goes straight to `process.stdout` while Ink owns the screen. Ink cannot erase what it did not draw, so this is a defect on its own terms even if it is not what produced the screenshot.

**Files:**
- Modify: `tui/editor_anchor.mjs:25-46`, `tui/editor.mjs:364-378`, `commands/chat.mjs:274-286`
- Test: `tests/f-repl-no-stale-rows.test.mjs` (from Task 5)

**Interfaces:**
- Consumes: `anchorState`, `installAnchorShim` from Task 5's test surface.
- Produces: `anchorState` gains a `writing: boolean` field (default `false`) that `editor.mjs` sets around its own anchor write so the shim does not compensate for it. `installAnchorShim()` keeps its signature.

- [ ] **Step 1: Make the shim compensate on any foreign write**

Replace the body of `installAnchorShim` in `tui/editor_anchor.mjs`:

```javascript
export const anchorState = { offset: 0, shimmed: false, writing: false };

export function installAnchorShim() {
  if (anchorState.shimmed) return;
  if (!(process.stdout && typeof process.stdout.write === 'function')) return;
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = function patchedWrite(chunk, ...rest) {
    try {
      // Undo the pending anchor before ANY write that is not the anchor's own.
      //
      // v5.4.4 compensated only for chunks starting with \x1b[2K (log-update's
      // eraseLines prefix). Everything else — Ink's raw <Static> output,
      // useStdout() output, and writes from outside Ink entirely — landed at
      // the raised cursor with the offset still pending, so Ink's next erase
      // walked the wrong rows and the tail of the old frame survived on screen
      // as a duplicated status row / editor border.
      if (anchorState.offset > 0 && !anchorState.writing) {
        const off = anchorState.offset;
        anchorState.offset = 0;
        orig.call(this, `\x1b[${off}B\r`);
      }
    } catch { /* fall through to the unmodified write */ }
    return orig.call(this, chunk, ...rest);
  };
  anchorState.shimmed = true;
}
```

- [ ] **Step 2: Tag the anchor's own write so it is not compensated**

In `tui/editor.mjs`, replace the write at the end of the anchor effect (currently the `try { process.stdout.write(\`${undo}\x1b[${rowsUp}A…\`) }` block) with:

```javascript
    const pending = _anchorState.offset;
    const undo = pending > 0 ? `\x1b[${pending}B\r` : '';
    _anchorState.offset = 0;
    try {
      // `writing` tells the shim this chunk IS the anchor move, so it must not
      // prepend its own compensation and cancel us out.
      _anchorState.writing = true;
      process.stdout.write(`${undo}\x1b[${rowsUp}A\x1b[${colTarget}G\x1b[?25h`);
    } catch { /* stdout closed — swallow */ } finally {
      _anchorState.writing = false;
      _anchorState.offset = rowsUp;
    }
```

- [ ] **Step 3: Route the slash dispatcher's streaming writes into scrollback**

In `commands/chat.mjs`, the `_inkSlashHandler` currently passes a raw-stdout write callback. Ink owns the screen while the REPL is mounted, so those bytes corrupt the frame. Accumulate them and return them as the handler's result instead — `repl.mjs` already appends a returned string to scrollback.

Replace the `const result = await _dispatchSlash(...)` call and its callback with:

```javascript
        // Ink owns the screen: a raw process.stdout.write here lands inside the
        // live frame, and Ink cannot erase bytes it did not draw (stale rows).
        // Collect what the handler streams and let ReplApp commit it to
        // scrollback along with the handler's own return value.
        const streamed = [];
        const result = await _dispatchSlash(cmd, args, _inkCtx, (chunk) => {
          streamed.push(String(chunk));
        });
```

and immediately before the existing `return result;`, add:

```javascript
        if (streamed.length > 0) {
          const pre = streamed.join('');
          return typeof result === 'string' && result.length > 0 ? `${pre}${result}` : pre;
        }
```

(The `_isInkResetCmd(cmd)` early return stays exactly where it is, above this block.)

- [ ] **Step 4: Run the repro to verify it now passes**

```bash
node --test tests/f-repl-no-stale-rows.test.mjs
```

Expected: all tests PASS, including the scenario that failed at the end of Task 5. If it still fails, **do not weaken the assertion** — go back to Task 5's escalation list, find what is actually moving the cursor, and fix that instead.

- [ ] **Step 5: Run the editor + REPL regression suites**

```bash
node --test tests/v53-editor-block.test.mjs tests/v532-editor-cjk.test.mjs tests/v533-editor-cjk-render.test.mjs tests/f-tui-input-ux.test.mjs tests/v53-repl-layout.test.mjs tests/v53-slash-exit.test.mjs
npm run lint:size
```

Expected: PASS; `lint:size` exits 0 (`commands/chat.mjs` must still be ≤ 676 lines — check with `wc -l commands/chat.mjs`).

- [ ] **Step 6: Manual TTY check**

```bash
node cli.mjs
```

Do all of: (a) type `/` and arrow through the popup, (b) run `/help`, (c) run `/status`, (d) resize the window, (e) run `/clear`. Expected: exactly one `○ idle …` row and one input box visible at every point; no orphaned borders. `/exit` to leave.

- [ ] **Step 7: Commit**

```bash
git add tui/editor_anchor.mjs tui/editor.mjs commands/chat.mjs
git commit -m "fix(tui): stop stale status rows and orphaned editor borders

Reproducing scenario: <the scenario recorded in Task 5>

Two paths desynced Ink's erase bookkeeping from the terminal cursor:

- editor_anchor's shim only undid the pending anchor offset for chunks
  starting with \\x1b[2K (log-update's eraseLines prefix). Every other write
  landed at the raised cursor with the offset still pending, so Ink's next
  erase walked the wrong rows. It now compensates before any write that is
  not the anchor's own.
- the Ink slash handler streamed straight to process.stdout while Ink owned
  the screen; Ink cannot erase bytes it did not draw. Its output is now
  collected and committed to scrollback."
```

---

### Task 7: Motion primitives

**Files:**
- Create: `tui/motion.mjs`
- Test: `tests/f-motion-helpers.test.mjs` (create)

**Interfaces:**
- Consumes: `colorEnabled` from `tui/theme.mjs`.
- Produces:
  - `SPINNER_FRAMES: string[]` (10 braille frames), `SPINNER_MS = 90`
  - `spinnerFrame(tick: number) => string`
  - `motionEnabled(env?: object, stream?: object) => boolean`
  - `formatElapsed(ms: number) => string` — `'0s'`, `'7s'`, `'1m04s'`
  - `tween(from: number, to: number, progress: number) => number` — linear, `progress` clamped to `[0,1]`
  - `revealRows(elapsedMs: number, totalRows: number, durationMs: number) => number`
  - `shimmerIndex(rowIndex: number, tick: number, paletteLength: number) => number`
  - `useMotion(active: boolean, intervalMs: number) => number` — React hook returning a monotonically increasing tick; owns one `setInterval`, torn down when `active` goes false or on unmount. Returns `0` while inactive.

- [ ] **Step 1: Write the failing test**

Create `tests/f-motion-helpers.test.mjs`:

```javascript
// tests/f-motion-helpers.test.mjs — the pure half of the motion package.
// Every animated component derives its frame from these, so they are the
// only thing that needs testing without a terminal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPINNER_FRAMES, SPINNER_MS, spinnerFrame, motionEnabled,
  formatElapsed, tween, revealRows, shimmerIndex,
} from '../tui/motion.mjs';

test('spinnerFrame cycles through the frames and wraps', () => {
  assert.equal(SPINNER_FRAMES.length, 10);
  assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(3), SPINNER_FRAMES[3]);
  assert.equal(spinnerFrame(10), SPINNER_FRAMES[0]);
  assert.equal(spinnerFrame(23), SPINNER_FRAMES[3]);
  assert.equal(spinnerFrame(-1), SPINNER_FRAMES[0], 'negative ticks must not throw or return undefined');
  assert.ok(SPINNER_MS > 0);
});

test('motionEnabled is off without a TTY, with NO_COLOR, on dumb terminals, and on opt-out', () => {
  const tty = { isTTY: true };
  assert.equal(motionEnabled({}, tty), true);
  assert.equal(motionEnabled({ LAZYCLAW_NO_MOTION: '1' }, tty), false);
  assert.equal(motionEnabled({ NO_COLOR: '1' }, tty), false);
  assert.equal(motionEnabled({ TERM: 'dumb' }, tty), false);
  assert.equal(motionEnabled({}, { isTTY: false }), false);
  assert.equal(motionEnabled({}, null), false);
});

test('formatElapsed renders seconds under a minute and m/s above', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(999), '0s');
  assert.equal(formatElapsed(7400), '7s');
  assert.equal(formatElapsed(59_999), '59s');
  assert.equal(formatElapsed(60_000), '1m00s');
  assert.equal(formatElapsed(64_000), '1m04s');
  assert.equal(formatElapsed(3_725_000), '62m05s');
  assert.equal(formatElapsed(-5), '0s');
});

test('tween interpolates linearly and clamps progress', () => {
  assert.equal(tween(0, 10, 0), 0);
  assert.equal(tween(0, 10, 0.5), 5);
  assert.equal(tween(0, 10, 1), 10);
  assert.equal(tween(0, 10, -3), 0, 'progress below 0 clamps to `from`');
  assert.equal(tween(0, 10, 4), 10, 'progress above 1 clamps to `to`');
  assert.equal(tween(8, 2, 0.5), 5, 'tweens downward too');
});

test('revealRows walks 0 → totalRows over the duration', () => {
  assert.equal(revealRows(0, 20, 400), 0);
  assert.equal(revealRows(200, 20, 400), 10);
  assert.equal(revealRows(400, 20, 400), 20);
  assert.equal(revealRows(9999, 20, 400), 20, 'never exceeds totalRows');
  assert.equal(revealRows(100, 0, 400), 0);
  assert.equal(revealRows(100, 20, 0), 20, 'a zero duration reveals everything at once');
});

test('shimmerIndex sweeps the palette per row without going out of bounds', () => {
  for (let tick = 0; tick < 40; tick++) {
    for (let row = 0; row < 13; row++) {
      const i = shimmerIndex(row, tick, 4);
      assert.ok(Number.isInteger(i) && i >= 0 && i < 4, `out of range: ${i}`);
    }
  }
  // Advancing the tick must actually move the sweep.
  const before = Array.from({ length: 13 }, (_, r) => shimmerIndex(r, 0, 4));
  const after = Array.from({ length: 13 }, (_, r) => shimmerIndex(r, 1, 4));
  assert.notDeepEqual(before, after);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test tests/f-motion-helpers.test.mjs
```

Expected: FAIL — `Cannot find module '.../tui/motion.mjs'`.

- [ ] **Step 3: Create `tui/motion.mjs`**

```javascript
// tui/motion.mjs — shared motion primitives for the chat TUI.
//
// Split into a pure half (frame math: spinner, tween, reveal, shimmer) and a
// single React hook (useMotion) that owns one interval per animated component.
// The pure half is what every component derives its frame from, so it is the
// only part that needs a unit test — the components themselves are thin.
//
// Global gate: motionEnabled(). Animation is OFF when stdout is not a TTY
// (tests, pipes, CI), when the NO_COLOR standard applies, on dumb terminals,
// and when the user opts out with LAZYCLAW_NO_MOTION=1 (the reduced-motion
// escape hatch). Every animated component must check it.

import { useState, useEffect } from 'react';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_MS = 90;

export function spinnerFrame(tick) {
  const n = SPINNER_FRAMES.length;
  const i = ((Math.trunc(tick) % n) + n) % n;
  return SPINNER_FRAMES[i];
}

export function motionEnabled(env = process.env, stream = process.stdout) {
  if (!env || env.LAZYCLAW_NO_MOTION === '1') return false;
  if (env.NO_COLOR) return false;
  if (env.TERM === 'dumb') return false;
  if (!stream || !stream.isTTY) return false;
  return true;
}

// Elapsed turn time. Seconds under a minute, zero-padded m/s above, so the
// status row's width stays stable as a turn runs long.
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

export function tween(from, to, progress) {
  const p = Math.min(1, Math.max(0, Number(progress) || 0));
  return from + (to - from) * p;
}

// How many rows of a stacked banner are visible `elapsedMs` into a reveal.
export function revealRows(elapsedMs, totalRows, durationMs) {
  if (totalRows <= 0) return 0;
  if (!durationMs || durationMs <= 0) return totalRows;
  const p = Math.min(1, Math.max(0, elapsedMs / durationMs));
  return Math.min(totalRows, Math.round(p * totalRows));
}

// Palette index for row `rowIndex` at animation `tick` — a diagonal sweep, so
// the highlight travels down the wordmark instead of flashing it uniformly.
export function shimmerIndex(rowIndex, tick, paletteLength) {
  const n = Math.max(1, paletteLength);
  return (((rowIndex + tick) % n) + n) % n;
}

// One interval per animated component, torn down the moment it goes inactive.
// Returns a monotonically increasing tick (0 while inactive) so components stay
// pure functions of (props, tick).
export function useMotion(active, intervalMs) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) { setTick(0); return undefined; }
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return active ? tick : 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test tests/f-motion-helpers.test.mjs
npm run lint:size
```

Expected: all 6 tests PASS; `lint:size` exits 0.

- [ ] **Step 5: Commit**

```bash
git add tui/motion.mjs tests/f-motion-helpers.test.mjs
git commit -m "feat(tui): add motion primitives (spinner, tween, reveal, shimmer)

Pure frame math plus a single useMotion hook that owns one interval per
animated component. Gated by motionEnabled(): off without a TTY, under
NO_COLOR, on dumb terminals, and on LAZYCLAW_NO_MOTION=1."
```

---

### Task 8: Streaming spinner + elapsed time in the status bar

Replace the 450 ms dot blink with braille spinner frames and add the turn's elapsed time. The idle row is unchanged.

**Files:**
- Modify: `tui/status_bar.mjs`
- Test: `tests/f-status-bar-blink.test.mjs` (existing — read it first; extend rather than replace), `tests/f-status-bar-motion.test.mjs` (create)

**Interfaces:**
- Consumes: `spinnerFrame`, `SPINNER_MS`, `motionEnabled`, `formatElapsed`, `useMotion` from Task 7.
- Produces: `streamingIndicator(streaming: boolean, blinkOn: boolean, t?: theme, opts?: {tick?: number, elapsedMs?: number, motion?: boolean}) => string`. The 3-argument form keeps its current behavior exactly (existing tests call it that way). `StatusBar` gains an optional `streamStartedAt: number|null` prop.

- [ ] **Step 1: Read the existing blink test so its contract is preserved**

```bash
cat tests/f-status-bar-blink.test.mjs
```

- [ ] **Step 2: Write the new failing test**

Create `tests/f-status-bar-motion.test.mjs`:

```javascript
// tests/f-status-bar-motion.test.mjs — the streaming indicator animates with
// braille spinner frames and reports elapsed turn time, and degrades to the
// pre-motion pulse when motion is off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamingIndicator, StatusBar } from '../tui/status_bar.mjs';
import { SPINNER_FRAMES } from '../tui/motion.mjs';
import React from 'react';

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('idle is unchanged', () => {
  assert.equal(plain(streamingIndicator(false, true)), '○ idle');
  assert.equal(plain(streamingIndicator(false, false, undefined, { motion: true, tick: 5 })), '○ idle');
});

test('the 3-argument form keeps its pre-motion behavior', () => {
  // Existing callers/tests rely on the pulsing-dot contract.
  assert.equal(plain(streamingIndicator(true, true)), '● streaming');
  assert.equal(plain(streamingIndicator(true, false)), '● streaming');
});

test('with motion on, streaming shows a spinner frame and elapsed time', () => {
  const out = plain(streamingIndicator(true, true, undefined, { motion: true, tick: 2, elapsedMs: 7400 }));
  assert.ok(out.startsWith(SPINNER_FRAMES[2]), `expected frame 2, got: ${out}`);
  assert.match(out, /streaming/);
  assert.match(out, /7s/);
});

test('the spinner frame advances with the tick', () => {
  const a = plain(streamingIndicator(true, true, undefined, { motion: true, tick: 0, elapsedMs: 0 }));
  const b = plain(streamingIndicator(true, true, undefined, { motion: true, tick: 1, elapsedMs: 0 }));
  assert.notEqual(a, b);
});

test('with motion off, streaming falls back to the pulsing dot', () => {
  const out = plain(streamingIndicator(true, true, undefined, { motion: false, tick: 3, elapsedMs: 9000 }));
  assert.equal(out, '● streaming');
});

test('StatusBar accepts streamStartedAt without breaking its existing props', () => {
  const el = React.createElement(StatusBar, {
    provider: 'openai', model: 'gpt-4.1', streaming: true,
    ctxUsed: 1024, ctxTotal: 8192, streamStartedAt: 1000,
  });
  assert.equal(el.props.streamStartedAt, 1000);
  assert.equal(el.props.provider, 'openai');
});
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
node --test tests/f-status-bar-motion.test.mjs
```

Expected: FAIL on `with motion on, streaming shows a spinner frame and elapsed time` — the 4th argument is ignored today.

- [ ] **Step 4: Implement**

In `tui/status_bar.mjs`, add the import and replace `streamingIndicator` + the `StatusBar` blink effect:

```javascript
import { spinnerFrame, SPINNER_MS, motionEnabled, formatElapsed, useMotion } from './motion.mjs';
```

```javascript
// The leading status glyph. While streaming with motion on, a braille spinner
// turns and the turn's elapsed time counts up; with motion off it falls back to
// the pre-motion pulsing dot. Idle is a steady hollow dot either way.
// Pure (takes the current phase/tick) so it is unit-testable without a timer.
export function streamingIndicator(streaming, blinkOn, t = theme, opts = {}) {
  if (!streaming) return t.dim('○ idle');
  if (opts.motion) {
    const elapsed = formatElapsed(opts.elapsedMs || 0);
    return t.success(`${spinnerFrame(opts.tick || 0)} streaming ${elapsed}`);
  }
  // Pulse a GREEN dot while streaming (live/working), not the amber accent.
  return blinkOn ? t.success('● streaming') : t.dim('● streaming');
}
```

and inside `StatusBar` (new `streamStartedAt` prop), replace the blink `useEffect` with:

```javascript
export function StatusBar({ provider, model, streaming, ctxUsed, ctxTotal, hud, streamStartedAt }) {
  const motion = motionEnabled();
  // One interval either way: the spinner ticks fast, the legacy pulse slow.
  const tick = useMotion(!!streaming, motion ? SPINNER_MS : BLINK_MS);
  const blinkOn = tick % 2 === 0;
  const elapsedMs = streaming && streamStartedAt ? Date.now() - streamStartedAt : 0;
```

then update the indicator call:

```javascript
  const indicator = streamingIndicator(streaming, blinkOn, theme, { motion, tick, elapsedMs });
```

Delete the now-unused blink `useState`/`useEffect` block. **Keep the `useState` and `useEffect` imports** — Task 10 adds the gauge tween to this same component and needs both.

- [ ] **Step 5: Feed `streamStartedAt` from the REPL**

In `tui/repl_reducers.mjs`, in `onUserInput`'s idle branch (the object that sets `streaming: true`), add:

```javascript
    streamStartedAt: Date.now(),
```

and in `onTurnComplete` and `onEscape`, add `streamStartedAt: null,` next to their `streaming: false,`. Add `streamStartedAt: null,` to `makeReplState`'s returned object as well.

In `tui/repl.mjs`, add one prop to the existing `React.createElement(StatusBar, {...})` call:

```javascript
        streamStartedAt: state.streamStartedAt,
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node --test tests/f-status-bar-motion.test.mjs tests/f-status-bar-blink.test.mjs tests/p3-statusbar-live.test.mjs tests/v53-repl-layout.test.mjs
wc -l tui/repl.mjs
npm run lint:size
```

Expected: PASS; `tui/repl.mjs` ≤ 570; `lint:size` exits 0.

- [ ] **Step 7: Commit**

```bash
git add tui/status_bar.mjs tui/repl_reducers.mjs tui/repl.mjs tests/f-status-bar-motion.test.mjs
git commit -m "feat(tui): braille spinner and elapsed turn time in the status bar

Replaces the 450ms dot pulse while streaming. The pre-motion pulse is still
the fallback when motion is disabled, and the 3-argument streamingIndicator
signature is unchanged for existing callers."
```

---

### Task 9: Thinking indicator

Between submit and the first streamed chunk there is no feedback at all. Show a spinner in the live region until the first chunk lands.

**Files:**
- Modify: `tui/repl.mjs` (live region)
- Create: `tui/thinking.mjs`
- Test: `tests/f-thinking-indicator.test.mjs` (create)

**Interfaces:**
- Consumes: `spinnerFrame`, `SPINNER_MS`, `motionEnabled`, `useMotion` from Task 7.
- Produces: `tui/thinking.mjs` → `Thinking({active: boolean})` React component. Renders `null` when `active` is false or motion is off; otherwise a single dim `Text` row `"<frame> thinking…"`.

- [ ] **Step 1: Write the failing test**

Create `tests/f-thinking-indicator.test.mjs`:

```javascript
// tests/f-thinking-indicator.test.mjs — the gap between "message sent" and
// "first token" had no feedback. <Thinking/> fills it.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { Thinking, thinkingLabel } from '../tui/thinking.mjs';
import { SPINNER_FRAMES } from '../tui/motion.mjs';

test('thinkingLabel pairs the spinner frame with the word', () => {
  assert.equal(thinkingLabel(0), `${SPINNER_FRAMES[0]} thinking…`);
  assert.equal(thinkingLabel(4), `${SPINNER_FRAMES[4]} thinking…`);
});

test('Thinking is a component that accepts an active flag', () => {
  const el = React.createElement(Thinking, { active: true });
  assert.equal(el.type, Thinking);
  assert.equal(el.props.active, true);
});

test('Thinking renders nothing when inactive', () => {
  // The component short-circuits before any hook that needs a renderer.
  assert.equal(Thinking({ active: false }), null);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test tests/f-thinking-indicator.test.mjs
```

Expected: FAIL — `Cannot find module '.../tui/thinking.mjs'`.

- [ ] **Step 3: Create `tui/thinking.mjs`**

```javascript
// tui/thinking.mjs — the "waiting for the first token" indicator.
//
// A turn can sit silent for seconds before the provider emits anything (cold
// CLI start, long prompt, orchestrator planning). The status bar's spinner
// says "streaming", which is a lie during that window; this says what is
// actually happening, in the live region where the reply will appear.
import React from 'react';
import { Text } from 'ink';
import { spinnerFrame, SPINNER_MS, motionEnabled, useMotion } from './motion.mjs';

export function thinkingLabel(tick) {
  return `${spinnerFrame(tick)} thinking…`;
}

export function Thinking({ active }) {
  // Short-circuit BEFORE the hook so an inactive render costs nothing and the
  // component can be called directly in a test without a renderer.
  if (!active || !motionEnabled()) return null;
  return React.createElement(ThinkingFrame, null);
}

function ThinkingFrame() {
  const tick = useMotion(true, SPINNER_MS);
  return React.createElement(Text, { dimColor: true }, thinkingLabel(tick));
}
```

- [ ] **Step 4: Wire it into the live region**

In `tui/repl.mjs`, add the import next to the other tui imports:

```javascript
import { Thinking } from './thinking.mjs';
```

and in the non-alt live-region branch, change the condition so the indicator shows while streaming with nothing received yet. Replace the `!altEnabled && state.liveAssistant ? … : null` block with:

```javascript
      !altEnabled && state.liveAssistant
        ? React.createElement(
            Box,
            { flexDirection: 'column' },
            React.createElement(Text, { color: theme.fg }, state.liveAssistant)
          )
        : React.createElement(Thinking, { active: !altEnabled && state.streaming && !state.liveAssistant }),
```

and in the alt-buffer branch, replace its `state.liveAssistant ? … : null` tail with the same pattern:

```javascript
            state.liveAssistant
              ? React.createElement(
                  Box,
                  { flexDirection: 'column' },
                  React.createElement(Text, { color: theme.fg }, state.liveAssistant)
                )
              : React.createElement(Thinking, { active: state.streaming }),
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test tests/f-thinking-indicator.test.mjs tests/v53-repl-layout.test.mjs
wc -l tui/repl.mjs
npm run lint:size
```

Expected: PASS; `tui/repl.mjs` ≤ 570; `lint:size` exits 0.

- [ ] **Step 6: Commit**

```bash
git add tui/thinking.mjs tui/repl.mjs tests/f-thinking-indicator.test.mjs
git commit -m "feat(tui): show a thinking indicator until the first token arrives

The window between submit and the first streamed chunk had no feedback, and
the status bar claiming 'streaming' during it was misleading."
```

---

### Task 10: Tween the ctx gauge

The gauge jumps from one fill level to the next at turn end. Step it instead.

**Files:**
- Modify: `tui/hud.mjs` (add `gaugeCells`), `tui/status_bar.mjs` (drive the tween)
- Test: `tests/f-ctx-gauge-tween.test.mjs` (create)

**Interfaces:**
- Consumes: `tween`, `motionEnabled`, `useMotion` from Task 7.
- Produces: `tui/hud.mjs` → `gaugeCells(pct: number) => number` (0..8, exported so the tween and `formatGauge` agree) and `formatGauge(used, budget, cellsOverride?: number|null)` — when `cellsOverride` is a number, the bar uses it instead of deriving cells from the percentage; the numbers and warn/danger markers are unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/f-ctx-gauge-tween.test.mjs`:

```javascript
// tests/f-ctx-gauge-tween.test.mjs — the ctx gauge fills stepwise instead of
// jumping. formatGauge grows an optional cell override so the animation can
// drive the bar while the numbers stay truthful.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGauge, gaugeCells } from '../tui/hud.mjs';
import { tween } from '../tui/motion.mjs';

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('gaugeCells maps a percentage onto the 8-cell bar', () => {
  assert.equal(gaugeCells(0), 0);
  assert.equal(gaugeCells(50), 4);
  assert.equal(gaugeCells(100), 8);
  assert.equal(gaugeCells(140), 8, 'never overflows the bar');
  assert.equal(gaugeCells(-5), 0);
});

test('formatGauge is unchanged without an override', () => {
  const out = plain(formatGauge(4096, 8192));
  assert.match(out, /50%/);
  assert.equal((out.match(/▰/g) || []).length, 4);
});

test('formatGauge honours a cell override while keeping the real numbers', () => {
  const out = plain(formatGauge(4096, 8192, 1));
  assert.match(out, /50%/, 'the percentage must stay truthful during the tween');
  assert.equal((out.match(/▰/g) || []).length, 1);
  assert.equal((out.match(/▱/g) || []).length, 7);
});

test('formatGauge still reports missing data as --', () => {
  assert.equal(formatGauge(null, 8192), '--');
  assert.equal(formatGauge(100, 0), '--');
});

test('tweening cells walks from the old fill to the new one', () => {
  const from = gaugeCells(20);   // 2
  const to = gaugeCells(80);     // 6
  assert.equal(Math.round(tween(from, to, 0)), 2);
  assert.equal(Math.round(tween(from, to, 0.5)), 4);
  assert.equal(Math.round(tween(from, to, 1)), 6);
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test tests/f-ctx-gauge-tween.test.mjs
```

Expected: FAIL — `does not provide an export named 'gaugeCells'`.

- [ ] **Step 3: Implement in `tui/hud.mjs`**

Replace `formatGauge` and add `gaugeCells`:

```javascript
// Cells of the 8-wide bar a given percentage fills. Exported so the status
// bar's fill animation and formatGauge agree on the scale.
export function gaugeCells(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return 0;
  return Math.min(GAUGE_CELLS, Math.max(0, Math.round((p / 100) * GAUGE_CELLS)));
}

export function formatGauge(used, budget, cellsOverride = null) {
  const u = Number(used);
  const b = Number(budget);
  if (!Number.isFinite(u) || !Number.isFinite(b) || b <= 0) return '--';
  const pct = (u / b) * 100;
  // The bar may be mid-animation, but the counts and percentage always report
  // the real value — an animation must never misstate how full the window is.
  const filled = Number.isFinite(cellsOverride)
    ? Math.min(GAUGE_CELLS, Math.max(0, Math.round(cellsOverride)))
    : gaugeCells(pct);
  const bar = GAUGE_FILLED.repeat(filled) + GAUGE_EMPTY.repeat(GAUGE_CELLS - filled);
  const body = `${fmtTok(u)}/${fmtTok(b)} ${Math.round(pct)}% ${bar}`;
  // >=95% danger, >=80% warn — prefix a plain marker so it's legible without
  // color, then tint the whole gauge so it stands out at a glance.
  if (pct >= 95) return chalk.red(`! ${body}`);
  if (pct >= 80) return chalk.yellow(`⚠ ${body}`);
  return body;
}
```

- [ ] **Step 4: Drive the tween from `tui/status_bar.mjs`**

Add the imports (`tween`, `gaugeCells`) and, inside `StatusBar`, replace the `const ctx = …` line with:

```javascript
  // Fill the bar stepwise toward its new level instead of snapping. The tween
  // runs on its own short-lived interval and stops as soon as it lands.
  const targetCells = (ctxUsed != null && ctxTotal != null && ctxTotal > 0)
    ? gaugeCells((ctxUsed / ctxTotal) * 100) : 0;
  const [fromCells, setFromCells] = useState(targetCells);
  const [tweenStart, setTweenStart] = useState(0);
  useEffect(() => {
    if (!motion) { setFromCells(targetCells); return; }
    setFromCells((prev) => (prev === targetCells ? prev : prev));
    setTweenStart(Date.now());
  }, [targetCells, motion]);
  const tweening = motion && fromCells !== targetCells;
  const tweenTick = useMotion(tweening, GAUGE_TWEEN_STEP_MS);
  useEffect(() => {
    if (!tweening) return;
    const p = (Date.now() - tweenStart) / GAUGE_TWEEN_MS;
    if (p >= 1) setFromCells(targetCells);
  }, [tweenTick, tweening, tweenStart, targetCells]);
  const animCells = tweening
    ? tween(fromCells, targetCells, (Date.now() - tweenStart) / GAUGE_TWEEN_MS)
    : null;
  const ctx = (ctxUsed != null && ctxTotal != null)
    ? formatGauge(ctxUsed, ctxTotal, animCells) : '--';
```

and add the two constants near `BLINK_MS`:

```javascript
// How long the ctx gauge takes to walk to its new fill, and how often it steps.
export const GAUGE_TWEEN_MS = 300;
export const GAUGE_TWEEN_STEP_MS = 50;
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test tests/f-ctx-gauge-tween.test.mjs tests/f-status-bar-motion.test.mjs tests/p3-statusbar-live.test.mjs
node --test $(grep -rl "formatGauge" tests/*.test.mjs)
npm run lint:size
```

Expected: PASS; `lint:size` exits 0.

- [ ] **Step 6: Commit**

```bash
git add tui/hud.mjs tui/status_bar.mjs tests/f-ctx-gauge-tween.test.mjs
git commit -m "feat(tui): tween the ctx gauge instead of snapping it

formatGauge takes an optional cell override so the bar can animate while the
counts and percentage keep reporting the real window usage."
```

---

### Task 11: Live rate + cost meter in the HUD

**Files:**
- Modify: `tui/hud.mjs`
- Test: `tests/f-hud-live-meter.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks (pure formatting).
- Produces: `tui/hud.mjs` → `formatRate(chars: number, elapsedMs: number) => string` (`''` when there is nothing meaningful to show) and `formatHudRow(fields, live?: {chars?: number, elapsedMs?: number})` — with `live` present and non-trivial, appends a `⇅ <n>/s` segment. Without it, `formatHudRow` output is byte-identical to today.

- [ ] **Step 1: Write the failing test**

Create `tests/f-hud-live-meter.test.mjs`:

```javascript
// tests/f-hud-live-meter.test.mjs — while a turn streams, the HUD row shows
// throughput next to the existing token/cost fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHudRow, formatRate } from '../tui/hud.mjs';

const fields = { inTok: 1200, outTok: 340, costUsd: 0.0123, trainer: 'claude-cli', orch: '' };

test('formatRate reports characters per second', () => {
  assert.equal(formatRate(1000, 1000), '1000/s');
  assert.equal(formatRate(500, 2000), '250/s');
  assert.equal(formatRate(12_500, 1000), '12.5k/s');
});

test('formatRate returns empty for a meaningless sample', () => {
  assert.equal(formatRate(0, 1000), '');
  assert.equal(formatRate(100, 0), '');
  assert.equal(formatRate(100, 150), '', 'samples under 250ms are too noisy to show');
});

test('formatHudRow is unchanged without a live sample', () => {
  const out = formatHudRow(fields);
  assert.match(out, /↑1.2k ↓340 tok/);
  assert.match(out, /\$0.0123/);
  assert.doesNotMatch(out, /⇅/);
});

test('formatHudRow appends the rate segment during a stream', () => {
  const out = formatHudRow(fields, { chars: 5000, elapsedMs: 2000 });
  assert.match(out, /⇅ 2500\/s/);
  assert.match(out, /↑1.2k ↓340 tok/, 'existing segments must survive');
});

test('formatHudRow drops the rate segment when the sample is meaningless', () => {
  assert.doesNotMatch(formatHudRow(fields, { chars: 0, elapsedMs: 5000 }), /⇅/);
  assert.doesNotMatch(formatHudRow(fields, {}), /⇅/);
});

test('formatHudRow still returns empty for no fields', () => {
  assert.equal(formatHudRow(null), '');
  assert.equal(formatHudRow(null, { chars: 100, elapsedMs: 1000 }), '');
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test tests/f-hud-live-meter.test.mjs
```

Expected: FAIL — `does not provide an export named 'formatRate'`.

- [ ] **Step 3: Implement**

In `tui/hud.mjs`, add above `formatHudRow`:

```javascript
// Throughput during a streaming turn. Characters (not tokens) because that is
// what the REPL can count locally and instantly — providers only report token
// usage at the end of a turn, which is too late to animate.
//
// Samples shorter than this are dominated by first-token latency and produce a
// wildly wrong number, so they render as nothing at all.
const RATE_MIN_SAMPLE_MS = 250;
export function formatRate(chars, elapsedMs) {
  const c = Number(chars) || 0;
  const ms = Number(elapsedMs) || 0;
  if (c <= 0 || ms < RATE_MIN_SAMPLE_MS) return '';
  const perSec = (c / ms) * 1000;
  return perSec >= 1000 ? `${(perSec / 1000).toFixed(1)}k/s` : `${Math.round(perSec)}/s`;
}
```

and change `formatHudRow`'s signature + tail:

```javascript
export function formatHudRow(f, live = null) {
  if (!f) return '';
  const seg = [`↑${fmtTok(f.inTok)} ↓${fmtTok(f.outTok)} tok`];
  if (f.costUsd > 0) seg.push(`$${f.costUsd.toFixed(4)}`);
  const rate = live ? formatRate(live.chars, live.elapsedMs) : '';
  if (rate) seg.push(`⇅ ${rate}`);
  if (f.trainer) seg.push(`trainer ${f.trainer}`);
  if (f.orch) seg.push(`orch ${f.orch}`);
  return seg.join('   ');
}
```

- [ ] **Step 4: Feed the live sample from the status bar**

In `tui/status_bar.mjs`, the `hudRow` line becomes:

```javascript
  const hudRow = hud ? formatHudRow(hud, streaming && streamStartedAt
    ? { chars: liveChars || 0, elapsedMs } : null) : '';
```

and add `liveChars` to the destructured props. In `tui/repl.mjs`, pass it from the live buffer on the existing `StatusBar` element:

```javascript
        liveChars: state.liveAssistant.length,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test tests/f-hud-live-meter.test.mjs tests/f-status-bar-motion.test.mjs
node --test $(grep -rl "formatHudRow" tests/*.test.mjs)
wc -l tui/repl.mjs
npm run lint:size
```

Expected: PASS; `tui/repl.mjs` ≤ 570; `lint:size` exits 0.

- [ ] **Step 6: Commit**

```bash
git add tui/hud.mjs tui/status_bar.mjs tui/repl.mjs tests/f-hud-live-meter.test.mjs
git commit -m "feat(tui): live throughput meter in the HUD row

Characters/sec while a turn streams — providers only report token usage at the
end of a turn, so chars are the only thing countable in real time. Samples
under 250ms are suppressed because first-token latency dominates them."
```

---

### Task 12: Error flash on the input border

**Files:**
- Modify: `tui/editor.mjs` (border color), `tui/repl.mjs` (pass the error timestamp), `tui/repl_reducers.mjs` (record it)
- Test: `tests/f-error-flash.test.mjs` (create)

**Interfaces:**
- Consumes: `motionEnabled`, `useMotion` from Task 7.
- Produces: `tui/editor.mjs` → `flashBorderColor(errorAt: number|null, now: number, motion: boolean, t?: theme) => string` — returns the red hex during the flash window, `theme.border` otherwise. `Editor` gains an optional `errorAt: number|null` prop. `makeReplState()` gains `lastErrorAt: null`; `onTurnComplete` sets it to `Date.now()` when `reason === 'error'` and to `null` otherwise.

- [ ] **Step 1: Write the failing test**

Create `tests/f-error-flash.test.mjs`:

```javascript
// tests/f-error-flash.test.mjs — a failed turn pulses the input border red so
// the failure is visible even if the error text scrolled past.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flashBorderColor, FLASH_MS } from '../tui/editor.mjs';
import { theme } from '../tui/theme.mjs';
import { makeReplState, onUserInput, onTurnComplete } from '../tui/repl_reducers.mjs';

test('no error means the normal border', () => {
  assert.equal(flashBorderColor(null, 1000, true), theme.border);
});

test('motion off means the normal border even right after an error', () => {
  assert.equal(flashBorderColor(1000, 1000, false), theme.border);
});

test('the border is red inside the flash window and normal after it', () => {
  const at = 1000;
  assert.notEqual(flashBorderColor(at, at, true), theme.border);
  assert.notEqual(flashBorderColor(at, at + FLASH_MS - 1, true), theme.border);
  assert.equal(flashBorderColor(at, at + FLASH_MS, true), theme.border);
  assert.equal(flashBorderColor(at, at + FLASH_MS + 5000, true), theme.border);
});

test('the flash pulses rather than staying solid', () => {
  const at = 0;
  const samples = [];
  for (let t = 0; t < FLASH_MS; t += FLASH_MS / 8) samples.push(flashBorderColor(at, t, true));
  assert.ok(new Set(samples).size > 1, 'expected the colour to alternate during the flash');
});

test('onTurnComplete records the error timestamp and clears it on success', () => {
  const ctrl = { abort: () => {} };
  assert.equal(makeReplState().lastErrorAt, null);

  let s = onUserInput(makeReplState(), { text: 'x', controller: ctrl });
  s = onTurnComplete(s, { reason: 'error', error: 'boom' });
  assert.ok(typeof s.lastErrorAt === 'number' && s.lastErrorAt > 0);

  let ok = onUserInput(s, { text: 'y', controller: ctrl });
  ok = onTurnComplete(ok, { reason: 'done' });
  assert.equal(ok.lastErrorAt, null, 'a successful turn clears the flash');
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test tests/f-error-flash.test.mjs
```

Expected: FAIL — `does not provide an export named 'flashBorderColor'`.

- [ ] **Step 3: Implement in `tui/editor.mjs`**

Add near the top, after the imports:

```javascript
// How long the input border pulses red after a failed turn, and the colour it
// pulses to. Two full pulses inside the window — long enough to notice, short
// enough not to read as a permanent error state.
export const FLASH_MS = 900;
const FLASH_HEX = '#F87171';
const FLASH_PULSES = 2;

export function flashBorderColor(errorAt, now, motion, t = theme) {
  if (!motion || !errorAt) return t.border;
  const age = now - errorAt;
  if (age < 0 || age >= FLASH_MS) return t.border;
  const phase = Math.floor((age / FLASH_MS) * FLASH_PULSES * 2);
  return phase % 2 === 0 ? FLASH_HEX : t.border;
}
```

Add `errorAt` to the `Editor` props list, and inside the component body before the returned element:

```javascript
  const flashMotion = motionEnabled();
  // Re-render through the flash window so the pulse is visible; the interval
  // stops the moment the window closes.
  const flashActive = flashMotion && !!errorAt && (Date.now() - errorAt) < FLASH_MS;
  const flashTick = useMotion(flashActive, FLASH_MS / (FLASH_PULSES * 2));
  void flashTick; // consumed only for its re-render side effect
  const borderColor = flashBorderColor(errorAt, Date.now(), flashMotion);
```

Change the Box's `borderColor: theme.border` to `borderColor`. Add the import:

```javascript
import { motionEnabled, useMotion } from './motion.mjs';
```

- [ ] **Step 4: Record and pass the timestamp**

In `tui/repl_reducers.mjs`: add `lastErrorAt: null,` to `makeReplState`'s returned object, and in `onTurnComplete`'s returned object add:

```javascript
    lastErrorAt: reason === 'error' ? Date.now() : null,
```

In `tui/repl.mjs`, add one prop to the existing `React.createElement(Editor, {...})` call:

```javascript
          errorAt: state.lastErrorAt,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test tests/f-error-flash.test.mjs tests/v53-editor-block.test.mjs tests/f-tui-input-ux.test.mjs tests/v53-repl-layout.test.mjs
wc -l tui/editor.mjs tui/repl.mjs
npm run lint:size
```

Expected: PASS; `tui/editor.mjs` ≤ 500 and `tui/repl.mjs` ≤ 570; `lint:size` exits 0. If `editor.mjs` crosses 500, move `flashBorderColor` + its constants into `tui/motion.mjs` and re-export them from `editor.mjs` so the test's import path still resolves.

- [ ] **Step 6: Commit**

```bash
git add tui/editor.mjs tui/repl_reducers.mjs tui/repl.mjs tests/f-error-flash.test.mjs
git commit -m "feat(tui): pulse the input border red after a failed turn

A long reply can push the error line out of view; the border pulse makes the
failure visible where the user is already looking."
```

---

### Task 13: Splash boot reveal + wordmark shimmer

**Deviation from the spec, recorded deliberately:** the spec proposed animating the splash inside the REPL and replaying it after `/clear`. Ink's `<Static>` is write-once, so a splash rendered through it cannot animate — animating it would mean rendering the splash live during the intro and swapping it for a static copy mid-flight, which is exactly the class of erase/cursor desync Task 6 just fixed. Instead the intro plays **before Ink mounts**, writing frames straight to a screen it fully owns, then clears and hands over. Consequence: the intro plays at startup only, not after `/clear` (`/clear` re-prints the settled splash, per Task 4). Total intro cost is ~1.15 s, skipped entirely when motion is off.

**Files:**
- Create: `tui/splash_intro.mjs`
- Modify: `commands/chat.mjs` (call it before `render(...)`)
- Test: `tests/f-splash-intro.test.mjs` (create)

**Interfaces:**
- Consumes: `motionEnabled`, `revealRows`, `shimmerIndex` from Task 7; `renderSplashToString` from `tui/splash.mjs`; `wordmark` from `tui/wordmark.mjs`.
- Produces: `tui/splash_intro.mjs` → `introFrames(splashText: string, opts: {revealMs, shimmerMs, fps, columns}) => string[]` (pure — the sequence of screen bodies) and `async playSplashIntro(splashProps, deps?: {write?, sleep?, env?, stream?, columns?}) => boolean` (returns `false` and writes nothing when motion is off).

- [ ] **Step 1: Write the failing test**

Create `tests/f-splash-intro.test.mjs`:

```javascript
// tests/f-splash-intro.test.mjs — the launch animation. It runs BEFORE Ink
// mounts, on a screen it owns outright, then clears and hands over — so it
// cannot desync Ink's erase bookkeeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { introFrames, playSplashIntro, REVEAL_MS, SHIMMER_MS } from '../tui/splash_intro.mjs';

const splashText = ['row-a', 'row-b', 'row-c', 'row-d'].join('\n');

test('the reveal grows from empty to the full splash', () => {
  const frames = introFrames(splashText, { revealMs: 200, shimmerMs: 0, fps: 20, columns: 80 });
  assert.ok(frames.length >= 2, 'expected several reveal frames');
  assert.ok(frames[0].split('\n').filter(Boolean).length < 4, 'first frame must be partial');
  assert.equal(frames[frames.length - 1].replace(/\x1b\[[0-9;]*m/g, ''), splashText,
    'the last frame must be exactly the settled splash');
});

test('every reveal frame is a prefix of the splash', () => {
  const frames = introFrames(splashText, { revealMs: 200, shimmerMs: 0, fps: 20, columns: 80 });
  const rows = splashText.split('\n');
  for (const f of frames) {
    const got = f.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l, i) => i < rows.length);
    assert.deepEqual(got, rows.slice(0, got.length), `frame diverged from the splash:\n${f}`);
  }
});

test('the shimmer phase adds frames that all render the full splash', () => {
  const withShimmer = introFrames(splashText, { revealMs: 100, shimmerMs: 300, fps: 20, columns: 80 });
  const revealOnly = introFrames(splashText, { revealMs: 100, shimmerMs: 0, fps: 20, columns: 80 });
  assert.ok(withShimmer.length > revealOnly.length, 'shimmer must add frames');
  for (const f of withShimmer.slice(revealOnly.length)) {
    assert.equal(f.replace(/\x1b\[[0-9;]*m/g, '').split('\n').length, 4);
  }
});

test('playSplashIntro writes nothing when motion is off', async () => {
  const writes = [];
  const played = await playSplashIntro({ version: '1.0.0' }, {
    write: (s) => writes.push(s),
    sleep: async () => {},
    env: { LAZYCLAW_NO_MOTION: '1' },
    stream: { isTTY: true },
  });
  assert.equal(played, false);
  assert.deepEqual(writes, []);
});

test('playSplashIntro writes nothing without a TTY', async () => {
  const writes = [];
  const played = await playSplashIntro({ version: '1.0.0' }, {
    write: (s) => writes.push(s),
    sleep: async () => {},
    env: {},
    stream: { isTTY: false },
  });
  assert.equal(played, false);
  assert.deepEqual(writes, []);
});

test('playSplashIntro leaves the screen cleared for Ink', async () => {
  const writes = [];
  await playSplashIntro({ version: '1.0.0', tools: [], skills: [], provider: 'p', model: 'm' }, {
    write: (s) => writes.push(s),
    sleep: async () => {},
    env: {},
    stream: { isTTY: true },
    columns: 100,
  });
  assert.ok(writes.length > 0, 'expected frames to be written');
  const last = writes[writes.length - 1];
  assert.ok(last.includes('\x1b[2J') && last.includes('\x1b[3J') && last.endsWith('\x1b[H'),
    `the final write must hand Ink a clean screen, got: ${JSON.stringify(last)}`);
});

test('the intro budget stays short enough not to delay the prompt', () => {
  assert.ok(REVEAL_MS + SHIMMER_MS <= 1300, 'intro must stay under ~1.3s total');
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
node --test tests/f-splash-intro.test.mjs
```

Expected: FAIL — `Cannot find module '.../tui/splash_intro.mjs'`.

- [ ] **Step 3: Create `tui/splash_intro.mjs`**

```javascript
// tui/splash_intro.mjs — the launch animation: the splash reveals top-to-
// bottom, then the LAZYCLAW wordmark's gradient sweeps once, then the screen
// is cleared and Ink mounts and draws the settled splash.
//
// Why before Ink and not inside it: on the primary buffer the splash is
// rendered through Ink's <Static>, which is write-once — a component there
// paints one frame and never repaints. Animating it would mean rendering a
// live splash and swapping it for a static copy mid-flight, i.e. exactly the
// erase/cursor desync class that produced the stale-row bug. Owning the screen
// outright for ~1.15s and then handing Ink a cleared screen is strictly
// simpler and has no interaction with Ink's bookkeeping at all.

import { renderSplashToString } from './splash.mjs';
import { wordmark } from './wordmark.mjs';
import { motionEnabled, revealRows, shimmerIndex } from './motion.mjs';

export const REVEAL_MS = 350;
export const SHIMMER_MS = 800;
export const FPS = 30;
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';
const HOME = '\x1b[H\x1b[J';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function _paintWordmarkRow(row, paletteIdx) {
  return `\x1b[38;2;${_hexToRgb(wordmark.palette[paletteIdx]).join(';')}m${row}\x1b[0m`;
}

function _hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// The whole animation as a list of screen bodies. Pure, so the frame sequence
// is testable without a terminal or a clock.
export function introFrames(splashText, { revealMs = REVEAL_MS, shimmerMs = SHIMMER_MS, fps = FPS, columns = 100 } = {}) {
  const rows = String(splashText).split('\n');
  const step = Math.max(1, Math.round(1000 / fps));
  const frames = [];

  // Phase 1 — reveal. Each frame is a strict prefix of the settled splash.
  for (let t = step; t <= revealMs; t += step) {
    const n = revealRows(t, rows.length, revealMs);
    if (n <= 0) continue;
    frames.push(rows.slice(0, n).join('\n'));
  }
  if (frames.length === 0 || frames[frames.length - 1].split('\n').length < rows.length) {
    frames.push(rows.join('\n'));
  }

  // Phase 2 — shimmer. Only the wordmark band (the first wordmark.height rows,
  // and only when the WIDE tier actually drew it) is recoloured per frame.
  const hasWordmark = columns >= 140 && rows.length > wordmark.height;
  if (shimmerMs > 0 && hasWordmark) {
    const steps = Math.max(1, Math.round(shimmerMs / step));
    for (let i = 0; i < steps; i++) {
      const painted = rows.map((row, r) =>
        r < wordmark.height ? _paintWordmarkRow(row, shimmerIndex(r, i, wordmark.palette.length)) : row);
      frames.push(painted.join('\n'));
    }
  } else if (shimmerMs > 0) {
    // No wordmark on screen (narrow terminal): hold the settled splash for the
    // same beat so the timing feels identical across tiers.
    const steps = Math.max(1, Math.round(shimmerMs / step));
    for (let i = 0; i < steps; i++) frames.push(rows.join('\n'));
  }
  return frames;
}

export async function playSplashIntro(splashProps, deps = {}) {
  const env = deps.env || process.env;
  const stream = deps.stream || process.stdout;
  if (!motionEnabled(env, stream)) return false;
  const write = deps.write || ((s) => { try { stream.write(s); } catch { /* stdout closed */ } });
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const columns = deps.columns || stream.columns || 100;

  const splashText = renderSplashToString(splashProps, { columns });
  const frames = introFrames(splashText, { columns });
  const step = Math.max(1, Math.round(1000 / FPS));

  write(HIDE_CURSOR + CLEAR);
  for (const frame of frames) {
    write(HOME + frame);
    await sleep(step);
  }
  // Hand Ink a clean screen — it re-draws the settled splash via <Static>.
  write(SHOW_CURSOR + CLEAR);
  return true;
}
```

- [ ] **Step 4: Call it before Ink mounts**

In `commands/chat.mjs`, immediately before the `const ink = render(...)` call, add:

```javascript
      // Launch animation. Owns the screen outright, then clears it and hands
      // over to Ink, so it cannot interfere with Ink's erase bookkeeping.
      // No-ops without a TTY or under LAZYCLAW_NO_MOTION / NO_COLOR.
      const { playSplashIntro } = await import('../tui/splash_intro.mjs');
      await playSplashIntro(splashProps);
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test tests/f-splash-intro.test.mjs tests/phaseC-splash.test.mjs tests/f-splash-tip.test.mjs tests/v53-splash-narrow-has-panel.test.mjs tests/v53-splash-narrow-has-sloth.test.mjs tests/v53-splash-narrow-wraps.test.mjs tests/v53-narrow-color.test.mjs
wc -l commands/chat.mjs
npm run lint:size
```

Expected: PASS (the existing splash snapshots must be untouched — `renderSplashToString` was not modified); `commands/chat.mjs` ≤ 676; `lint:size` exits 0.

- [ ] **Step 6: Manual TTY check, both ways**

```bash
node cli.mjs
```

Expected: the splash reveals top-to-bottom, the wordmark sweeps once (on a ≥140-column terminal), the screen clears, and the settled splash + prompt appear. `/exit`.

```bash
LAZYCLAW_NO_MOTION=1 node cli.mjs
```

Expected: no animation at all — the splash appears immediately, exactly as before this task. `/exit`.

- [ ] **Step 7: Commit**

```bash
git add tui/splash_intro.mjs commands/chat.mjs tests/f-splash-intro.test.mjs
git commit -m "feat(tui): animated launch intro (reveal + wordmark shimmer)

Plays before Ink mounts, on a screen it owns outright, then clears and hands
over — Ink's <Static> is write-once so a splash rendered through it cannot
animate, and swapping a live splash for a static one mid-flight is the same
erase/cursor desync class as the stale-row bug. ~1.15s, skipped entirely
without a TTY or under LAZYCLAW_NO_MOTION / NO_COLOR."
```

---

### Task 14: Docs + full-suite verification

`/gateway` is a new user-facing command and `LAZYCLAW_NO_MOTION` is a new environment variable, so §5.5 of the engineering directives requires a README update.

**Files:**
- Modify: `README.md`, `CHANGELOG.md`
- Test: the whole node suite

- [ ] **Step 1: Run the full node test suite and record the result**

```bash
node --test tests/*.test.mjs 2>&1 | tail -30
```

Expected: no failures. If anything fails, fix it before continuing — do not document work that does not pass.

- [ ] **Step 2: Add `/gateway` to the README's slash-command section**

In `README.md`, in the chat/slash-command area (near line 143, where argument completion is described), add:

```markdown
Manage the always-on gateway without leaving the chat:

```
/gateway              # or /gateway status — pid, port, /health, auth, channels
/gateway start        # spawn a detached gateway and wait for it to come up
/gateway stop         # SIGTERM the recorded pid
```
```

- [ ] **Step 3: Document the motion opt-out**

In `README.md`, next to the existing environment-variable documentation, add:

```markdown
| `LAZYCLAW_NO_MOTION` | `1` disables every terminal animation (launch intro, streaming spinner, gauge tween, error flash). Animation is also off automatically without a TTY, under `NO_COLOR`, and on `TERM=dumb`. |
```

- [ ] **Step 4: Add the CHANGELOG entry**

In `CHANGELOG.md`, under a new `## [Unreleased]` section (Keep a Changelog format):

```markdown
### Added
- `/gateway status|start|stop` slash command in the chat REPL.
- The gateway records `gateway.pid` so its status can be probed and it can be stopped by pidfile.
- Terminal motion package: launch reveal + wordmark shimmer, braille streaming spinner with elapsed time, thinking indicator, tweened ctx gauge, live throughput meter, red border flash on a failed turn. Disable with `LAZYCLAW_NO_MOTION=1`.

### Fixed
- `/clear` left a blank screen instead of the splash: Ink's `<Static>` is write-once, so the retained splash item was never re-printed. It is now keyed by a generation counter that the reset bumps.
- Stale duplicated status rows and orphaned editor borders on the primary buffer: the editor's cursor-anchor shim only compensated for chunks starting with the `eraseLines` prefix (and `eraseLines(0)` is the empty string), and the Ink slash handler streamed straight to `process.stdout` while Ink owned the screen.
```

- [ ] **Step 5: Final verification**

```bash
node --test tests/*.test.mjs 2>&1 | tail -10
npm run lint:size
npm run lint:pack
git status --short
```

Expected: suite green, both lint gates exit 0, only the intended files changed.

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document /gateway and LAZYCLAW_NO_MOTION"
```

---

## Self-Review

**Spec coverage**

| Spec item | Task |
|---|---|
| W1 `/gateway` status/start/stop, pidfile reuse, detached spawn, readable errors | 2, 3 |
| W2 splash survives `/clear` (generation key on `<Static>`) | 4 |
| W3 stale rows: repro first, then fix | 5 (reproduce — mandatory gate), 6 (fix) |
| W4.1 streaming spinner + elapsed | 8 |
| W4.2 boot sequence | 13 |
| W4.3 banner shimmer | 13 |
| W4.4 thinking indicator | 9 |
| W4.5 ctx gauge tween | 10 |
| W4.6 live meter | 11 |
| W4.7 error flash | 12 |
| Motion gate (`TTY` / `NO_COLOR` / `LAZYCLAW_NO_MOTION`), `renderSplashToString` unchanged | 7, and asserted in 13 |
| Scrollback must not re-render on animation ticks | Held: all animation state lives in `StatusBar`, `Editor`, `Thinking` — never in `state.scrollback`, and `ScrollbackItem` stays `React.memo`'d. |
| Testing: pure helpers, reducer generation, `/gateway` with injected deps | 2, 3, 4, 7, 8, 10, 11, 12, 13 |
| README + CHANGELOG | 14 |

**Deviation from the spec:** the splash animation runs pre-mount and therefore does **not** replay after `/clear` (spec §W4.3 said "startup and post-`/clear` remount"). Rationale is recorded in Task 13's header and must be reflected back into the spec when the branch merges.

**Ratchet budget check** — files that may not grow past their pin:
- `tui/slash_dispatcher.mjs` (1397): Task 1 removes ~58 lines, Tasks 1+3 add 2 import lines and 1 map entry. Net ≈ −55.
- `tui/repl.mjs` (570): Task 4 edits one line in place; Tasks 8, 9, 11, 12 add 1 import line and 4 prop lines, and Task 9 replaces two `: null` tails with element calls (net 0). Net ≈ +5 → 575, **over the ceiling**. Mitigation, to apply during Task 9: move the two live-region branches into a `LiveRegion` component in `tui/thinking.mjs` and call it from both paths, which removes ~12 lines from `repl.mjs`. Verify with `wc -l tui/repl.mjs` at every task's verification step — the plan already instructs this.
- `commands/chat.mjs` (676): Task 6 adds ~6 lines, Task 13 adds 2. Net ≈ +8 → 684, **over the ceiling**. Mitigation, to apply during Task 6: extract `_inkSlashHandler` into `commands/chat_slash_bridge.mjs` (it is ~14 lines plus the new accumulator) and import it, netting ≈ −10.

Both mitigations are mandatory, not optional — treat the `wc -l` check in each task's verification step as a gate.
