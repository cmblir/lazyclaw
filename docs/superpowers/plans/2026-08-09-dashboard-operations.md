# Dashboard Operations (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every routine operation completes in the dashboard, with the slash dispatcher as the single write path.

**Architecture:** One mutating daemon route (`POST /slash`) plus one read route (`GET /slash/commands`). A pure adapter builds an HTTP-flavoured slash `ctx` and calls the existing `dispatchSlash` from `tui/slash_dispatcher.mjs`; nothing moves out of the dispatcher. Destructive commands are intercepted *before* dispatch by an explicit table and answered with a one-shot confirm token. Panels compose the same slash lines a user would type.

**Tech Stack:** Node 18+ ES modules, no build step, `node:test`, Playwright, zero new dependencies.

## Global Constraints

- Write path: `dispatchSlash` only. No typed REST route may be added for agents/teams/tasks/config/workflows.
- Authorization: the existing bearer gate is the only gate. Token holder has full authority; a loopback daemon with no token stays unauthenticated-full-rights. No new permission concept.
- Envelope, verbatim: success `{ ok: true, lines: string[], data?: object }`; failure `{ ok: false, error: string, code: 'SLASH_ERR' }`; interactive-only `{ ok: false, code: 'TTY_ONLY', error: string, hint: string }`; confirmation `{ ok: false, code: 'CONFIRM_REQUIRED', prompt: string, token: string }`.
- Confirm tokens: 60000 ms TTL, single-use, bound to the exact `line`.
- File-size gate: 500 lines per file (`npm run lint:size`). Never add an `ALLOW` entry — split instead.
- Every new file must be reachable from the published package (`npm run lint:pack`).
- Tests must never write into the operator's real config directory; set `POMPOS_CONFIG_DIR` to a `mkdtemp` dir at module scope and remove it in `after()`.
- The UI never invents a second grammar: a panel button composes the exact line a user would type.

---

### Task 1: Confirm-token store

**Files:**
- Create: `daemon/lib/confirm_tokens.mjs`
- Test: `tests/f-confirm-tokens.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `makeConfirmStore({ ttlMs = 60000, now = Date.now } = {}) -> { issue(line) -> string, redeem(token, line) -> boolean, size() -> number }`

- [ ] **Step 1: Write the failing test**

```js
// tests/f-confirm-tokens.test.mjs
// A confirm token is the only thing standing between a dashboard click and a
// destructive slash command. It must be single-use (a replayed token cannot
// re-run the delete), bound to its line (a token minted for a harmless
// command cannot authorise a dangerous one), and short-lived.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfirmStore } from '../daemon/lib/confirm_tokens.mjs';

test('a freshly issued token redeems exactly once', () => {
  const s = makeConfirmStore();
  const t = s.issue('/team remove crew');
  assert.equal(s.redeem(t, '/team remove crew'), true);
  assert.equal(s.redeem(t, '/team remove crew'), false, 'a replayed token must not work twice');
});

test('a token is bound to the line it was issued for', () => {
  const s = makeConfirmStore();
  const t = s.issue('/skill remove note-taker');
  assert.equal(s.redeem(t, '/team remove crew'), false,
    'a token minted for one command must not authorise another');
  assert.equal(s.redeem(t, '/skill remove note-taker'), true, 'the original line still works');
});

test('a token expires after its TTL', () => {
  let clock = 1000;
  const s = makeConfirmStore({ ttlMs: 60000, now: () => clock });
  const t = s.issue('/team remove crew');
  clock += 59999;
  assert.equal(s.redeem(t, '/team remove crew'), true, 'still valid just inside the window');

  const t2 = s.issue('/team remove crew');
  clock += 60001;
  assert.equal(s.redeem(t2, '/team remove crew'), false, 'expired');
});

test('unknown and malformed tokens are refused, not thrown on', () => {
  const s = makeConfirmStore();
  for (const bad of ['', null, undefined, 'c_nope', 42, {}]) {
    assert.equal(s.redeem(bad, '/team remove crew'), false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('redeeming and expiring both release storage', () => {
  let clock = 1000;
  const s = makeConfirmStore({ ttlMs: 1000, now: () => clock });
  const t = s.issue('/a');
  s.issue('/b');
  assert.equal(s.size(), 2);
  s.redeem(t, '/a');
  assert.equal(s.size(), 1, 'a redeemed token is deleted');
  clock += 1001;
  s.issue('/c');            // any write sweeps expired entries
  assert.equal(s.size(), 1, 'the expired /b entry is swept, leaving only /c');
});

test('two issues for the same line produce distinct tokens', () => {
  const s = makeConfirmStore();
  assert.notEqual(s.issue('/team remove crew'), s.issue('/team remove crew'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/f-confirm-tokens.test.mjs`
Expected: FAIL — `Cannot find module '../daemon/lib/confirm_tokens.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// daemon/lib/confirm_tokens.mjs — one-shot confirmations for destructive
// slash commands issued over HTTP.
//
// The REPL asks "are you sure?" with a picker and blocks on the answer. HTTP
// has no such turn, so the two halves become two requests: the first is
// refused with a token, the second carries it back. The token is what makes
// the second request an *answer* rather than an independent command — so it
// is single-use (a replay cannot re-run the delete), bound to the exact line
// (a token for a harmless command cannot authorise a dangerous one), and
// short-lived (a stale browser tab cannot confirm something the operator has
// forgotten about).
//
// In-process memory on purpose: a daemon restart clears pending confirmations,
// which is the safe direction — the UI simply asks again.
import crypto from 'node:crypto';

export function makeConfirmStore({ ttlMs = 60000, now = Date.now } = {}) {
  const pending = new Map();   // token -> { line, expiresAt }

  function sweep(at) {
    for (const [tok, rec] of pending) if (rec.expiresAt <= at) pending.delete(tok);
  }

  return {
    issue(line) {
      const at = now();
      sweep(at);
      const token = `c_${crypto.randomBytes(16).toString('hex')}`;
      pending.set(token, { line: String(line), expiresAt: at + ttlMs });
      return token;
    },
    redeem(token, line) {
      if (typeof token !== 'string' || !token) return false;
      const rec = pending.get(token);
      if (!rec) return false;
      const at = now();
      // Delete first: an expired or mismatched token is spent either way, so a
      // caller cannot probe for a valid line by retrying with guesses.
      pending.delete(token);
      if (rec.expiresAt <= at) return false;
      return rec.line === String(line);
    },
    size() { return pending.size; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/f-confirm-tokens.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add daemon/lib/confirm_tokens.mjs tests/f-confirm-tokens.test.mjs
git commit -m "feat(daemon): one-shot confirm tokens for destructive slash commands"
```

---

### Task 2: The destructive-command table

**Files:**
- Create: `daemon/lib/slash_destructive.mjs`
- Test: `tests/f-slash-destructive.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `destructivePrompt(cmd, args) -> string | null` — the confirmation prompt for a destructive line, or `null` when the line is safe.

**Why a table rather than reading the dispatcher's intent:** `_promptConfirm` in `tui/slash_helpers.mjs` returns `false` when `ctx.openPicker` is absent, so over HTTP a destructive command would report "cancelled" instead of asking. Intercepting *before* dispatch is what turns that silent refusal into a real question, and an explicit table is reviewable in a way that sniffing picker shapes is not.

- [ ] **Step 1: Write the failing test**

```js
// tests/f-slash-destructive.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { destructivePrompt } from '../daemon/lib/slash_destructive.mjs';

test('remove/delete subcommands are recognised and name their target', () => {
  const p = destructivePrompt('/team', 'remove crew');
  assert.match(p, /crew/, 'the prompt must name what is about to be destroyed');
  assert.match(p, /remove|delete/i);
  assert.ok(destructivePrompt('/agent', 'remove dev'));
  assert.ok(destructivePrompt('/skill', 'remove note-taker'));
  assert.ok(destructivePrompt('/task', 'abandon t_123'));
});

test('the reset family is destructive even with no arguments', () => {
  for (const cmd of ['/new', '/reset', '/clear']) {
    assert.ok(destructivePrompt(cmd, ''), `${cmd} discards the conversation`);
  }
});

test('read-only and additive commands are not gated', () => {
  for (const [cmd, args] of [
    ['/status', ''], ['/help', ''], ['/team', 'list'], ['/team', 'add crew'],
    ['/agent', 'list'], ['/skill', 'list'], ['/model', ''], ['/config', 'get provider'],
  ]) {
    assert.equal(destructivePrompt(cmd, args), null, `${cmd} ${args} must not prompt`);
  }
});

test('a removal-looking word inside a value does not trigger the gate', () => {
  // The subcommand is the first token; anything later is data.
  assert.equal(destructivePrompt('/team', 'add remove-crew'), null);
  assert.equal(destructivePrompt('/config', 'set note "remove this later"'), null);
});

test('matching is case-insensitive and tolerant of extra whitespace', () => {
  assert.ok(destructivePrompt('/team', '  REMOVE   crew '));
});

test('an unknown command is never gated — dispatch reports it', () => {
  assert.equal(destructivePrompt('/nope', 'remove everything'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/f-slash-destructive.test.mjs`
Expected: FAIL — `Cannot find module '../daemon/lib/slash_destructive.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// daemon/lib/slash_destructive.mjs — which slash lines must be confirmed
// before they run over HTTP.
//
// The REPL prompts inline via ctx.openPicker. Over HTTP there is no turn to
// block on, and tui/slash_helpers.mjs's _promptConfirm returns FALSE when
// openPicker is absent — so an unintercepted destructive command would report
// "cancelled" rather than asking. This table is checked before dispatch, so
// the question reaches the operator.
//
// Explicit rather than inferred: reviewing a list of subcommands is something
// a human can do; guessing intent from a picker's item shape is not.

// cmd -> { sub: RegExp on the FIRST token only, prompt(target) }
const RULES = new Map([
  ['/team', { sub: /^(remove|delete)$/i, prompt: (t) => `Remove team ${t || '(unnamed)'}? Its members stay, the team does not.` }],
  ['/agent', { sub: /^(remove|delete)$/i, prompt: (t) => `Remove agent ${t || '(unnamed)'}? Any team referencing it keeps the dangling name.` }],
  ['/skill', { sub: /^(remove|delete|uninstall)$/i, prompt: (t) => `Uninstall skill ${t || '(unnamed)'}? The file is deleted from disk.` }],
  ['/task', { sub: /^(abandon|cancel|delete|remove)$/i, prompt: (t) => `Abandon task ${t || '(unnamed)'}? It stops and cannot be resumed.` }],
  ['/workflow', { sub: /^(clear|delete|remove|stop)$/i, prompt: (t) => `Clear workflow state for ${t || '(all)'}? Saved progress is discarded.` }],
  ['/config', { sub: /^(unset|delete|remove)$/i, prompt: (t) => `Unset config key ${t || '(unnamed)'}?` }],
]);

// Commands whose whole purpose is discarding, so there is no subcommand to
// inspect.
const ALWAYS = new Map([
  ['/new', 'Start a new conversation? The current transcript is discarded.'],
  ['/reset', 'Reset the conversation? The current transcript is discarded.'],
  ['/clear', 'Clear the conversation? The current transcript is discarded.'],
]);

/**
 * @param {string} cmd  the slash command, e.g. '/team'
 * @param {string} args everything after it
 * @returns {string|null} the confirmation prompt, or null when safe
 */
export function destructivePrompt(cmd, args) {
  const key = String(cmd || '').toLowerCase();
  const always = ALWAYS.get(key);
  if (always) return always;
  const rule = RULES.get(key);
  if (!rule) return null;
  // Only the FIRST token is the subcommand; a later "remove" is data, not verb.
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !rule.sub.test(tokens[0])) return null;
  return rule.prompt(tokens[1] || '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/f-slash-destructive.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add daemon/lib/slash_destructive.mjs tests/f-slash-destructive.test.mjs
git commit -m "feat(daemon): explicit table of slash commands that need confirmation"
```

---

### Task 3: The HTTP slash adapter

**Files:**
- Create: `daemon/lib/slash_http.mjs`
- Test: `tests/f-slash-http.test.mjs`

**Interfaces:**
- Consumes: `makeConfirmStore` (Task 1), `destructivePrompt` (Task 2), and from `tui/slash_dispatcher.mjs` the existing exports `dispatchSlash(cmd, args, ctx, write)`, `parseSlashLine(line) -> {cmd, args}`, `SLASH_HANDLERS: Map<string, Function>`.
- Produces:
  - `makeSlashRunner({ cfgDir, confirmStore, dispatch = dispatchSlash }) -> { run({ line, confirm }) -> Promise<Envelope> }`
  - `buildHttpCtx({ cfgDir, autoApprove = false }) -> object` — the slash ctx for HTTP callers.
  - `listCommands() -> Array<{ name: string, description: string }>`

**Envelope shapes** (Global Constraints, verbatim). `'EXIT'` and `'NEW'` are sentinels the REPL acts on; over HTTP they are not errors and not output — they collapse to `{ ok: true, lines: [] }` plus whatever was streamed.

- [ ] **Step 1: Write the failing test**

```js
// tests/f-slash-http.test.mjs — the adapter that lets the dashboard run the
// same slash commands the REPL runs.
//
// The dispatcher is not modified; this pins the translation layer: what a
// handler streams and returns becomes an envelope, TTY-only affordances are
// absent so handlers degrade to text, and destructive lines are answered with
// a confirmation instead of being silently cancelled.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSlashRunner, buildHttpCtx, listCommands } from '../daemon/lib/slash_http.mjs';
import { makeConfirmStore } from '../daemon/lib/confirm_tokens.mjs';
import { SLASH_HANDLERS } from '../tui/slash_dispatcher.mjs';

// Handlers resolve the config directory for themselves; keep every write in a
// temp dir so a test run never touches the operator's own state.
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-'));
process.env.POMPOS_CONFIG_DIR = CFG;
after(() => fs.rmSync(CFG, { recursive: true, force: true }));

function runnerWith(dispatch) {
  return makeSlashRunner({ cfgDir: CFG, confirmStore: makeConfirmStore(), dispatch });
}

test('what a handler streams and returns becomes lines, in order', async () => {
  const r = runnerWith(async (_cmd, _args, _ctx, write) => {
    write('first\n'); write('second\n');
    return 'returned';
  });
  const out = await r.run({ line: '/anything' });
  assert.deepEqual(out, { ok: true, lines: ['first\n', 'second\n', 'returned'] });
});

test('a handler that only returns produces a single line', async () => {
  const r = runnerWith(async () => 'just this');
  assert.deepEqual(await r.run({ line: '/status' }), { ok: true, lines: ['just this'] });
});

test('the EXIT and NEW sentinels are not output and not errors', async () => {
  for (const sentinel of ['EXIT', 'NEW']) {
    const r = runnerWith(async () => sentinel);
    assert.deepEqual(await r.run({ line: '/whatever' }), { ok: true, lines: [] },
      `${sentinel} is a REPL sentinel with no meaning over HTTP`);
  }
});

test('a thrown handler becomes a SLASH_ERR envelope, never a crash', async () => {
  const r = runnerWith(async () => { throw new Error('team already exists'); });
  const out = await r.run({ line: '/team add crew' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SLASH_ERR');
  assert.match(out.error, /team already exists/);
});

test('a blank or non-slash line is refused before dispatch', async () => {
  let called = false;
  const r = runnerWith(async () => { called = true; });
  for (const line of ['', '   ', 'hello', null, undefined]) {
    const out = await r.run({ line });
    assert.equal(out.ok, false, `${JSON.stringify(line)} must be refused`);
    assert.equal(out.code, 'SLASH_ERR');
  }
  assert.equal(called, false, 'nothing reaches the dispatcher');
});

// --- confirmation ---------------------------------------------------------

test('a destructive line is answered with a prompt and a token, and does NOT run', async () => {
  let ran = false;
  const r = runnerWith(async () => { ran = true; return 'removed'; });
  const out = await r.run({ line: '/team remove crew' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CONFIRM_REQUIRED');
  assert.match(out.prompt, /crew/);
  assert.match(out.token, /^c_[0-9a-f]{32}$/);
  assert.equal(ran, false, 'the command must not run before it is confirmed');
});

test('the same line with a valid token runs, and the token does not work twice', async () => {
  let runs = 0;
  const r = runnerWith(async () => { runs += 1; return 'removed team crew'; });
  const first = await r.run({ line: '/team remove crew' });
  const ok = await r.run({ line: '/team remove crew', confirm: first.token });
  assert.deepEqual(ok, { ok: true, lines: ['removed team crew'] });
  assert.equal(runs, 1);

  const replay = await r.run({ line: '/team remove crew', confirm: first.token });
  assert.equal(replay.code, 'CONFIRM_REQUIRED', 'a spent token asks again rather than running');
  assert.equal(runs, 1, 'the command did not run a second time');
});

test('a token minted for one line cannot confirm another', async () => {
  let ran = null;
  const r = runnerWith(async (cmd, args) => { ran = `${cmd} ${args}`; return 'done'; });
  const t = (await r.run({ line: '/team remove crew' })).token;
  const out = await r.run({ line: '/agent remove dev', confirm: t });
  assert.equal(out.code, 'CONFIRM_REQUIRED');
  assert.equal(ran, null);
});

test('a confirmed run can answer the handler own prompt', async () => {
  // _promptConfirm returns false without ctx.openPicker, which would make a
  // confirmed delete report "cancelled". On a redemption the ctx supplies an
  // approving picker so the handler completes.
  const r = runnerWith(async (_cmd, _args, ctx) => {
    const approved = typeof ctx.openPicker === 'function'
      ? (await ctx.openPicker({ kind: 'menu', items: [{ id: 'approve' }, { id: 'deny' }] })).id === 'approve'
      : false;
    return approved ? 'removed' : 'cancelled';
  });
  const t = (await r.run({ line: '/team remove crew' })).token;
  const out = await r.run({ line: '/team remove crew', confirm: t });
  assert.deepEqual(out.lines, ['removed']);
});

// --- the HTTP ctx ---------------------------------------------------------

test('the plain HTTP ctx offers no picker, so handlers take their text path', () => {
  const ctx = buildHttpCtx({ cfgDir: CFG });
  assert.equal(typeof ctx.openPicker, 'undefined',
    'every picker call site is guarded by typeof; absence is what selects the listing fallback');
  assert.equal(ctx.cfgDir, CFG);
  assert.equal(typeof ctx.readConfig, 'function');
  assert.equal(typeof ctx.writeConfig, 'function');
});

test('the auto-approve ctx answers a confirm picker affirmatively', async () => {
  const ctx = buildHttpCtx({ cfgDir: CFG, autoApprove: true });
  const picked = await ctx.openPicker({ kind: 'menu', items: [{ id: 'approve' }, { id: 'deny' }] });
  assert.equal(picked.id, 'approve');
});

// --- gate coverage --------------------------------------------------------

test('every registered command survives the HTTP ctx without throwing', async () => {
  // A handler that reaches for a TTY affordance we do not provide would throw
  // a TypeError and take the route down with it. Running the whole registry
  // through the real ctx is what keeps a future command from doing that.
  const { dispatchSlash } = await import('../tui/slash_dispatcher.mjs');
  const ctx = buildHttpCtx({ cfgDir: CFG });
  const broke = [];
  for (const name of SLASH_HANDLERS.keys()) {
    try {
      await dispatchSlash(name, '', { ...ctx }, () => {});
    } catch (err) {
      if (err instanceof TypeError) broke.push(`${name}: ${err.message}`);
    }
  }
  assert.deepEqual(broke, [], 'these reach for something the HTTP ctx does not provide');
});

test('listCommands mirrors the dispatcher registry exactly', () => {
  const names = listCommands().map((c) => c.name).sort();
  assert.deepEqual(names, [...SLASH_HANDLERS.keys()].sort(),
    'the dashboard autocomplete must not drift from what the dispatcher accepts');
  for (const c of listCommands()) assert.equal(typeof c.description, 'string');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/f-slash-http.test.mjs`
Expected: FAIL — `Cannot find module '../daemon/lib/slash_http.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// daemon/lib/slash_http.mjs — run REPL slash commands over HTTP.
//
// The dispatcher is the single write path for the dashboard, so this file is
// a translation layer and nothing more: no command logic lives here, and
// tui/slash_dispatcher.mjs is not modified. What it translates:
//
//   · output   — handlers stream through write() and/or return a string; both
//                become `lines`, in the order they were produced.
//   · sentinels— 'EXIT' and 'NEW' are things the REPL does to itself. Over
//                HTTP they are neither output nor errors.
//   · pickers  — every ctx.openPicker call site in the dispatcher is guarded
//                by `typeof ctx.openPicker === 'function'`, so OMITTING it is
//                what selects each handler's text fallback. The one exception
//                is a redeemed confirmation, where we supply an approving
//                picker so _promptConfirm (which returns false without one)
//                does not turn a confirmed delete into "cancelled".
//   · danger   — destructive lines are intercepted BEFORE dispatch and
//                answered with a token; see daemon/lib/slash_destructive.mjs.
import { dispatchSlash as _dispatchSlash, parseSlashLine, SLASH_HANDLERS } from '../../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../../tui/slash_commands.mjs';
import { destructivePrompt } from './slash_destructive.mjs';
import { readConfig, writeConfig } from '../../lib/config.mjs';

/**
 * The slash ctx for HTTP callers.
 *
 * @param {{cfgDir: string, autoApprove?: boolean}} opts
 *   autoApprove is set only when replaying a confirmed line.
 */
export function buildHttpCtx({ cfgDir, autoApprove = false }) {
  const ctx = {
    cfgDir,
    readConfig: () => readConfig(cfgDir),
    writeConfig: (next) => writeConfig(next, cfgDir),
  };
  if (autoApprove) {
    // The operator already answered this question at the HTTP layer; the
    // handler's own prompt is the second half of the same decision.
    ctx.openPicker = async ({ items } = {}) => {
      const approve = (items || []).find((i) => i && i.id === 'approve');
      return approve || (items && items[0]) || { id: 'approve' };
    };
  }
  return ctx;
}

/** The command list the dashboard's autocomplete reads. */
export function listCommands() {
  const described = new Map(
    (SLASH_COMMANDS || []).map((c) => [c.name || c.cmd, c.desc || c.description || '']),
  );
  return [...SLASH_HANDLERS.keys()].map((name) => ({
    name,
    description: described.get(name) || '',
  }));
}

function fail(error, code = 'SLASH_ERR') {
  return { ok: false, error: String(error), code };
}

export function makeSlashRunner({ cfgDir, confirmStore, dispatch = _dispatchSlash }) {
  return {
    async run({ line, confirm } = {}) {
      const raw = typeof line === 'string' ? line.trim() : '';
      if (!raw.startsWith('/')) return fail('a slash command is required, e.g. /status');

      const { cmd, args } = parseSlashLine(raw);
      let autoApprove = false;

      const prompt = destructivePrompt(cmd, args);
      if (prompt) {
        if (!confirmStore.redeem(confirm, raw)) {
          return { ok: false, code: 'CONFIRM_REQUIRED', prompt, token: confirmStore.issue(raw) };
        }
        autoApprove = true;
      }

      const lines = [];
      const ctx = buildHttpCtx({ cfgDir, autoApprove });
      let result;
      try {
        result = await dispatch(cmd, args, ctx, (chunk) => { lines.push(String(chunk)); });
      } catch (err) {
        return fail(err?.message || err);
      }
      if (typeof result === 'string' && result !== 'EXIT' && result !== 'NEW' && result.length) {
        lines.push(result);
      }
      return { ok: true, lines };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/f-slash-http.test.mjs`
Expected: PASS, 13 tests.

**TTY_ONLY ruling:** the gate-coverage test decides whether this exists at all. If it names zero commands, do NOT add a `TTY_ONLY` set or envelope branch — unused code is not shipped. If it names any, add exactly those to a `TTY_ONLY` set in this file, return `{ ok: false, code: 'TTY_ONLY', error, hint }` for them before dispatch, and add a test asserting one of them produces that envelope.

- [ ] **Step 5: Verify file sizes and commit**

```bash
npm run lint:size
git add daemon/lib/slash_http.mjs tests/f-slash-http.test.mjs
git commit -m "feat(daemon): HTTP adapter over the slash dispatcher"
```

---

### Task 4: The routes

**Files:**
- Modify: `daemon/route_table.mjs` (add two entries next to the other `POST /...` rows)
- Create: `daemon/routes/slash.mjs`
- Test: `tests/f-slash-routes.test.mjs`

**Interfaces:**
- Consumes: `makeSlashRunner`, `listCommands` (Task 3); `makeConfirmStore` (Task 1); from `daemon/routes/_deps.mjs` the existing `readJson`, `writeJson`.
- Produces: route handlers `slashRun(c)` and `slashCommands(c)`, matching the module-per-area convention in `daemon/routes/`.

- [ ] **Step 1: Write the failing test**

```js
// tests/f-slash-routes.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slashRun, slashCommands } from '../daemon/routes/slash.mjs';
import { SLASH_HANDLERS } from '../tui/slash_dispatcher.mjs';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-route-'));
process.env.POMPOS_CONFIG_DIR = CFG;
after(() => fs.rmSync(CFG, { recursive: true, force: true }));

// Minimal stand-ins for the node req/res the route layer passes around.
function mkRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.writeHead = (code, h) => { res.statusCode = code; Object.assign(res.headers, h || {}); return res; };
  res.end = (b) => { res.body = b ? JSON.parse(b) : null; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
function mkReq(body) {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return { method: 'POST', headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
}

test('POST /slash returns the envelope for a real command', async () => {
  const res = mkRes();
  await slashRun({ req: mkReq({ line: '/version' }), res, gwConfigDir: CFG });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.lines.length > 0, '/version prints something');
});

test('POST /slash refuses a malformed body with 400, not a crash', async () => {
  const res = mkRes();
  await slashRun({ req: mkReq({ nope: 1 }), res, gwConfigDir: CFG });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'SLASH_ERR');
});

test('a destructive line answers 409 with a token, and the token completes it', async () => {
  const first = mkRes();
  await slashRun({ req: mkReq({ line: '/team remove definitely-not-a-team' }), res: first, gwConfigDir: CFG });
  assert.equal(first.statusCode, 409, 'a question, not a failure and not a success');
  assert.equal(first.body.code, 'CONFIRM_REQUIRED');
  assert.ok(first.body.token);

  const second = mkRes();
  await slashRun({
    req: mkReq({ line: '/team remove definitely-not-a-team', confirm: first.body.token }),
    res: second, gwConfigDir: CFG,
  });
  assert.notEqual(second.statusCode, 409, 'the confirmed line is not asked about again');
});

test('the confirm store is shared across requests to one daemon', async () => {
  // A token issued by one request must be redeemable by the next; a per-call
  // store would make every confirmation impossible.
  const a = mkRes();
  await slashRun({ req: mkReq({ line: '/new' }), res: a, gwConfigDir: CFG });
  assert.equal(a.body.code, 'CONFIRM_REQUIRED');
  const b = mkRes();
  await slashRun({ req: mkReq({ line: '/new', confirm: a.body.token }), res: b, gwConfigDir: CFG });
  assert.equal(b.body.ok, true);
});

test('GET /slash/commands lists exactly what the dispatcher accepts', async () => {
  const res = mkRes();
  await slashCommands({ res });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.map((c) => c.name).sort(), [...SLASH_HANDLERS.keys()].sort());
});

test('both routes are registered in the route table', async () => {
  const { ROUTES } = await import('../daemon/route_table.mjs');
  const has = (route) => ROUTES.some((r) => {
    try { return r.m({ route, req: { method: route.split(' ')[0] } }); } catch { return false; }
  });
  assert.ok(has('POST /slash'), 'POST /slash must be reachable');
  assert.ok(has('GET /slash/commands'), 'GET /slash/commands must be reachable');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/f-slash-routes.test.mjs`
Expected: FAIL — `Cannot find module '../daemon/routes/slash.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// daemon/routes/slash.mjs — the dashboard's single write path.
//
// Everything the dashboard changes goes through here, so the CLI and the
// browser cannot drift: both run the same dispatcher over the same commands.
import { readJson, writeJson } from './_deps.mjs';
import { makeSlashRunner, listCommands } from '../lib/slash_http.mjs';
import { makeConfirmStore } from '../lib/confirm_tokens.mjs';

// One store per daemon process: a token issued by one request is redeemed by
// the next, so it cannot live inside a handler call.
const confirmStore = makeConfirmStore();

export async function slashRun(c) {
  const { req, res, gwConfigDir } = c;
  let body;
  try { body = await readJson(req); }
  catch (e) { return writeJson(res, 400, { ok: false, error: e?.message || String(e), code: 'SLASH_ERR' }); }

  const runner = makeSlashRunner({ cfgDir: gwConfigDir, confirmStore });
  const out = await runner.run({ line: body?.line, confirm: body?.confirm });
  // 409 for CONFIRM_REQUIRED: the request conflicts with a policy the client
  // can resolve and retry, which is exactly what a confirmation is. 400 for a
  // genuine error, 200 for success.
  const status = out.ok ? 200 : (out.code === 'CONFIRM_REQUIRED' ? 409 : 400);
  return writeJson(res, status, out);
}

export async function slashCommands(c) {
  return writeJson(c.res, 200, listCommands());
}
```

Then add to `daemon/route_table.mjs`, beside the other `POST /...` entries:

```js
  { m: (c) => c.route === 'POST /slash', h: slash.slashRun },
  { m: (c) => c.route === 'GET /slash/commands', h: slash.slashCommands },
```

and the import alongside the other route-module imports:

```js
import * as slash from './routes/slash.mjs';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/f-slash-routes.test.mjs && node --test tests/f-dashboard-auth.test.mjs`
Expected: PASS both. The auth suite must stay green — `POST /slash` is a mutating route and has to sit behind the same bearer gate as its neighbours.

- [ ] **Step 5: Commit**

```bash
npm run lint:size && npm run lint:pack
git add daemon/routes/slash.mjs daemon/route_table.mjs tests/f-slash-routes.test.mjs
git commit -m "feat(daemon): POST /slash and GET /slash/commands"
```

---

### Task 5: SSE streaming for long-running commands

**Files:**
- Modify: `daemon/routes/slash.mjs`, `daemon/lib/slash_http.mjs`
- Test: `tests/f-slash-sse.test.mjs`

**Interfaces:**
- Consumes: `makeSlashRunner` (Task 3); `writeSseHead`, `writeSse` from `daemon/routes/_deps.mjs` (the helpers `POST /conversation` already uses).
- Produces: `STREAMING: Set<string>` exported from `daemon/lib/slash_http.mjs`; `runner.runStreaming({line, confirm, onLine}) -> Promise<Envelope>`; `runSlashStream(line, {onLine, confirm}) -> Promise<Envelope>` in `web/ui/slash_client.mjs`.

**Why:** without this, a `/loop` or agent run shows nothing until it finishes — the dashboard looks hung for the exact commands that take longest. The buffered path stays for everything else; only members of `STREAMING` upgrade.

- [ ] **Step 1: Write the failing test**

```js
// tests/f-slash-sse.test.mjs — long commands must show progress as it happens.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSlashRunner, STREAMING } from '../daemon/lib/slash_http.mjs';
import { makeConfirmStore } from '../daemon/lib/confirm_tokens.mjs';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-sse-'));
process.env.POMPOS_CONFIG_DIR = CFG;
after(() => fs.rmSync(CFG, { recursive: true, force: true }));

test('STREAMING names the commands that can run long', () => {
  assert.ok(STREAMING.has('/loop'), '/loop runs until stopped');
  assert.ok(STREAMING.size > 0);
  assert.equal(STREAMING.has('/status'), false, 'instant commands stay buffered');
});

test('runStreaming delivers each line as it is produced, not at the end', async () => {
  const seen = [];
  let resolveSecond;
  const gate = new Promise((r) => { resolveSecond = r; });
  const runner = makeSlashRunner({
    cfgDir: CFG, confirmStore: makeConfirmStore(),
    dispatch: async (_c, _a, _ctx, write) => {
      write('step one\n');
      // The test only proceeds once the first line has been observed, which
      // is impossible if lines are buffered until the handler returns.
      await gate;
      write('step two\n');
      return 'finished';
    },
  });
  const done = runner.runStreaming({
    line: '/loop',
    onLine: (l) => { seen.push(l); if (seen.length === 1) resolveSecond(); },
  });
  const out = await done;
  assert.deepEqual(seen, ['step one\n', 'step two\n', 'finished']);
  assert.deepEqual(out, { ok: true, lines: ['step one\n', 'step two\n', 'finished'] });
});

test('a streaming command still honours the confirmation gate', async () => {
  let ran = false;
  const runner = makeSlashRunner({
    cfgDir: CFG, confirmStore: makeConfirmStore(),
    dispatch: async () => { ran = true; return 'x'; },
  });
  const out = await runner.runStreaming({ line: '/clear', onLine: () => {} });
  assert.equal(out.code, 'CONFIRM_REQUIRED');
  assert.equal(ran, false, 'confirmation precedes streaming, same as the buffered path');
});

test('a thrown handler ends the stream with an error envelope', async () => {
  const runner = makeSlashRunner({
    cfgDir: CFG, confirmStore: makeConfirmStore(),
    dispatch: async (_c, _a, _ctx, write) => { write('partial\n'); throw new Error('boom'); },
  });
  const seen = [];
  const out = await runner.runStreaming({ line: '/loop', onLine: (l) => seen.push(l) });
  assert.deepEqual(seen, ['partial\n'], 'what was produced before the failure still reached the client');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SLASH_ERR');
  assert.match(out.error, /boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/f-slash-sse.test.mjs`
Expected: FAIL — `STREAMING` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `daemon/lib/slash_http.mjs`:

```js
// Commands that can run long enough that buffering their output would make
// the dashboard look hung. Everything else answers in one response.
export const STREAMING = new Set(['/loop', '/agent', '/team', '/workflow']);
```

and, inside the object `makeSlashRunner` returns, a sibling of `run`:

```js
    /**
     * Same contract as run(), but each line is handed to onLine the moment it
     * is produced. The envelope still carries the full list so a caller that
     * missed the start is not left with a partial record.
     */
    async runStreaming({ line, confirm, onLine } = {}) {
      const raw = typeof line === 'string' ? line.trim() : '';
      if (!raw.startsWith('/')) return fail('a slash command is required, e.g. /status');
      const { cmd, args } = parseSlashLine(raw);
      let autoApprove = false;
      const prompt = destructivePrompt(cmd, args);
      if (prompt) {
        if (!confirmStore.redeem(confirm, raw)) {
          return { ok: false, code: 'CONFIRM_REQUIRED', prompt, token: confirmStore.issue(raw) };
        }
        autoApprove = true;
      }
      const lines = [];
      const emit = (chunk) => { const s = String(chunk); lines.push(s); onLine?.(s); };
      const ctx = buildHttpCtx({ cfgDir, autoApprove });
      let result;
      try {
        result = await dispatch(cmd, args, ctx, emit);
      } catch (err) {
        return fail(err?.message || err);
      }
      if (typeof result === 'string' && result !== 'EXIT' && result !== 'NEW' && result.length) emit(result);
      return { ok: true, lines };
    },
```

In `daemon/routes/slash.mjs`, upgrade when the client asks for it AND the command is in `STREAMING`:

```js
  const { cmd } = parseSlashLine(String(body?.line || '').trim());
  const wantsStream = /text\/event-stream/.test(String(req.headers.accept || ''));
  if (wantsStream && STREAMING.has(cmd)) {
    writeSseHead(res);
    const out = await runner.runStreaming({
      line: body.line, confirm: body.confirm,
      onLine: (l) => writeSse(res, 'line', { text: l }),
    });
    writeSse(res, 'done', out);
    return res.end();
  }
```

Add `runSlashStream` to `web/ui/slash_client.mjs`:

```js
/**
 * Run a command that may take a while, delivering lines as they arrive.
 * Falls back to the buffered result if the server did not upgrade.
 */
export async function runSlashStream(line, { onLine, confirm } = {}) {
  const body = confirm ? { line, confirm } : { line };
  const res = await apiRaw('/slash', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!/text\/event-stream/.test(res.headers.get('content-type') || '')) return res.json();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let final = { ok: false, error: 'stream ended without a result', code: 'SLASH_ERR' };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() || '';
    for (const f of frames) {
      const ev = /event: (\w+)/.exec(f)?.[1];
      const data = /data: (.*)/.exec(f)?.[1];
      if (!data) continue;
      const payload = JSON.parse(data);
      if (ev === 'line') onLine?.(payload.text);
      else if (ev === 'done') final = payload;
    }
  }
  return final;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/f-slash-sse.test.mjs && node --test tests/f-slash-http.test.mjs tests/f-slash-routes.test.mjs`
Expected: PASS all — the buffered path must not regress.

- [ ] **Step 5: Commit**

```bash
npm run lint:size
git add daemon/lib/slash_http.mjs daemon/routes/slash.mjs web/ui/slash_client.mjs tests/f-slash-sse.test.mjs
git commit -m "feat(daemon): stream long-running slash commands over SSE"
```

---

### Task 6: Browser slash client

**Files:**
- Create: `web/ui/slash_client.mjs`
- Test: `tests/f-slash-client.test.mjs`

**Interfaces:**
- Consumes: `api`, `apiRaw` from `web/ui/api.mjs` (existing: `api(path, opts)` throws on non-2xx, `apiRaw(path, opts)` returns the `Response`).
- Produces: `runSlash(line, { confirm } = {}) -> Promise<Envelope>` and `fetchCommands() -> Promise<Array<{name, description}>>`.

`runSlash` must NOT throw on 409 — a confirmation is a normal outcome the caller acts on, which is why it goes through `apiRaw` rather than `api`.

- [ ] **Step 1: Write the failing test**

```js
// tests/f-slash-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// api.mjs reads localStorage at call time; a stub is enough for these.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

function stubFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return calls;
}

test('runSlash posts the line and returns the envelope', async () => {
  const calls = stubFetch(200, { ok: true, lines: ['done'] });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  const out = await runSlash('/team add crew');
  assert.deepEqual(out, { ok: true, lines: ['done'] });
  assert.match(calls[0].url, /\/slash$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].body, { line: '/team add crew' });
});

test('a 409 confirmation is returned, not thrown', async () => {
  stubFetch(409, { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Remove team crew?', token: 'c_x' });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  const out = await runSlash('/team remove crew');
  assert.equal(out.code, 'CONFIRM_REQUIRED', 'the caller decides whether to ask the user');
  assert.equal(out.token, 'c_x');
});

test('a confirm token is sent back with the same line', async () => {
  const calls = stubFetch(200, { ok: true, lines: ['removed'] });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  await runSlash('/team remove crew', { confirm: 'c_x' });
  assert.deepEqual(calls[0].body, { line: '/team remove crew', confirm: 'c_x' });
});

test('a 400 error is returned as an envelope too', async () => {
  stubFetch(400, { ok: false, error: 'unknown slash command: /nope', code: 'SLASH_ERR' });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  const out = await runSlash('/nope');
  assert.equal(out.ok, false);
  assert.match(out.error, /unknown slash command/);
});

test('a non-JSON response still yields an envelope rather than throwing', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
  const { runSlash } = await import('../web/ui/slash_client.mjs');
  const out = await runSlash('/status');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SLASH_ERR');
});

test('fetchCommands returns the list', async () => {
  stubFetch(200, [{ name: '/help', description: 'show help' }]);
  const { fetchCommands } = await import('../web/ui/slash_client.mjs');
  assert.deepEqual(await fetchCommands(), [{ name: '/help', description: 'show help' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/f-slash-client.test.mjs`
Expected: FAIL — `Cannot find module '../web/ui/slash_client.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// web/ui/slash_client.mjs — the browser half of the single write path.
//
// Every mutating action in the dashboard funnels through runSlash, composing
// the exact line a user would type in the REPL. Panels never build a second
// grammar, and there is no second endpoint to keep in step.
import { api, apiRaw } from './api.mjs';

/**
 * Run a slash command.
 *
 * Returns the envelope for EVERY outcome, including a 409 confirmation —
 * `api()` throws on non-2xx, and a confirmation is a normal answer the caller
 * has to act on, so this goes through apiRaw.
 *
 * @param {string} line e.g. '/team remove crew'
 * @param {{confirm?: string}} [opts]
 * @returns {Promise<{ok: boolean, lines?: string[], error?: string, code?: string, prompt?: string, token?: string}>}
 */
export async function runSlash(line, { confirm } = {}) {
  const body = confirm ? { line, confirm } : { line };
  try {
    const res = await apiRaw('/slash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err?.message || String(err), code: 'SLASH_ERR' };
  }
}

export async function fetchCommands() {
  return api('/slash/commands');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/f-slash-client.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add web/ui/slash_client.mjs tests/f-slash-client.test.mjs
git commit -m "feat(dashboard): browser client for the slash write path"
```

---

### Task 7: Confirm dialog

**Files:**
- Create: `web/ui/confirm_dialog.mjs`
- Test: `tests/f-confirm-dialog.test.mjs`

**Interfaces:**
- Consumes: `runSlash` (Task 6); `openModal`, `closeModal` from `web/ui/modal.mjs` (existing, already used by `web/ui/panels/tasks.mjs`); `el` from `web/ui/dom.mjs`.
- Produces: `runSlashConfirmed(line, { confirm: askFn }) -> Promise<Envelope>` — runs a line and, on `CONFIRM_REQUIRED`, asks via `askFn(prompt) -> Promise<boolean>` and retries with the token. `askFn` defaults to a modal.

Every panel calls `runSlashConfirmed`, never `runSlash` directly, so no panel can forget the confirmation step.

- [ ] **Step 1: Write the failing test**

```js
// tests/f-confirm-dialog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };

function stubFetchSequence(responses) {
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push(opts?.body ? JSON.parse(opts.body) : null);
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return calls;
}

test('a safe command runs without asking anything', async () => {
  stubFetchSequence([{ status: 200, body: { ok: true, lines: ['ok'] } }]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  let asked = 0;
  const out = await runSlashConfirmed('/team list', { confirm: async () => { asked += 1; return true; } });
  assert.equal(out.ok, true);
  assert.equal(asked, 0);
});

test('an accepted confirmation retries the same line with the token', async () => {
  const calls = stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Remove team crew?', token: 'c_1' } },
    { status: 200, body: { ok: true, lines: ['removed'] } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  let seenPrompt = null;
  const out = await runSlashConfirmed('/team remove crew', {
    confirm: async (p) => { seenPrompt = p; return true; },
  });
  assert.equal(seenPrompt, 'Remove team crew?', 'the user sees the blast radius, not a generic "are you sure"');
  assert.deepEqual(out, { ok: true, lines: ['removed'] });
  assert.deepEqual(calls[1], { line: '/team remove crew', confirm: 'c_1' });
});

test('a declined confirmation does NOT retry and reports cancellation', async () => {
  const calls = stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'Remove team crew?', token: 'c_1' } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  const out = await runSlashConfirmed('/team remove crew', { confirm: async () => false });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CANCELLED');
  assert.equal(calls.length, 1, 'nothing is sent after a decline');
});

test('a second confirmation is not asked twice in a row', async () => {
  // If the server asks again after a redemption something is wrong; surface it
  // rather than looping.
  stubFetchSequence([
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'p', token: 'c_1' } },
    { status: 409, body: { ok: false, code: 'CONFIRM_REQUIRED', prompt: 'p', token: 'c_2' } },
  ]);
  const { runSlashConfirmed } = await import('../web/ui/confirm_dialog.mjs');
  let asked = 0;
  const out = await runSlashConfirmed('/team remove crew', { confirm: async () => { asked += 1; return true; } });
  assert.equal(asked, 1, 'ask once, then stop');
  assert.equal(out.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/f-confirm-dialog.test.mjs`
Expected: FAIL — `Cannot find module '../web/ui/confirm_dialog.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// web/ui/confirm_dialog.mjs — the two-step destructive flow, in one place.
//
// Panels call runSlashConfirmed, never runSlash, so no panel can forget the
// confirmation. The prompt shown is the server's, which names the actual blast
// radius ("Remove team crew? Its members stay, the team does not.") rather than
// a generic "are you sure?".
import { el } from './dom.mjs';
import { openModal, closeModal } from './modal.mjs';
import { runSlash } from './slash_client.mjs';

/** Default asker: a modal with Cancel focused. Resolves true only on confirm. */
function askInModal(prompt) {
  return new Promise((resolve) => {
    const cancel = el('button', { class: 'btn', 'data-action': 'cancel', text: 'Cancel',
      onclick: () => { closeModal(); resolve(false); } });
    const go = el('button', { class: 'btn danger', 'data-action': 'confirm', text: 'Confirm',
      onclick: () => { closeModal(); resolve(true); } });
    // openModal takes an object, not positional args: {title, body, foot}.
    openModal({ title: 'Confirm', body: el('p', { text: prompt }), foot: el('div', { class: 'row gap' }, cancel, go) });
    // Destructive default: dismissing the modal any other way is a decline.
    cancel.focus();
  });
}

/**
 * Run a slash line, handling a CONFIRM_REQUIRED answer by asking once.
 *
 * @param {string} line
 * @param {{confirm?: (prompt: string) => Promise<boolean>}} [opts]
 * @returns {Promise<object>} the final envelope, or {ok:false, code:'CANCELLED'}
 */
export async function runSlashConfirmed(line, { confirm = askInModal } = {}) {
  const first = await runSlash(line);
  if (first.code !== 'CONFIRM_REQUIRED') return first;
  const approved = await confirm(first.prompt);
  if (!approved) return { ok: false, code: 'CANCELLED', error: 'cancelled' };
  // Exactly one retry: a second CONFIRM_REQUIRED means the token was rejected,
  // and asking again would loop.
  return runSlash(line, { confirm: first.token });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/f-confirm-dialog.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add web/ui/confirm_dialog.mjs tests/f-confirm-dialog.test.mjs
git commit -m "feat(dashboard): one confirm flow shared by every destructive action"
```

---

### Task 8: Panel write actions

**Files:**
- Modify: `web/ui/panels/agents.mjs`, `web/ui/panels/teams.mjs`, `web/ui/panels/tasks.mjs`, `web/ui/panels/config.mjs`, `web/ui/panels/workflows.mjs`
- Create: `web/ui/slash_actions.mjs` (line composers — pure, so they can be tested without a DOM)
- Test: `tests/f-slash-actions.test.mjs`

**Interfaces:**
- Consumes: `runSlashConfirmed` (Task 7).
- Produces: `web/ui/slash_actions.mjs` exporting pure composers used by the panels:
  - `agentCreate({name, role, model}) -> string`
  - `agentRemove(name) -> string`
  - `teamCreate({name, agents, lead}) -> string`
  - `teamMemberAdd(team, agent) -> string`
  - `teamRemove(name) -> string`
  - `taskIssue({team, title}) -> string`
  - `taskAbandon(id) -> string`
  - `configSet(key, value) -> string`
  - `configUnset(key) -> string`
  - `workflowRun(name) -> string`
  - `workflowResume(name) -> string`

Composers exist so the grammar lives in one tested place instead of being string-concatenated inside five DOM files.

- [ ] **Step 1: Write the failing test**

```js
// tests/f-slash-actions.test.mjs — the panel button → slash line grammar.
//
// These are the exact lines a user would type. Pinning them here means a panel
// cannot quietly invent a variant the CLI does not accept.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../web/ui/slash_actions.mjs';

test('agent lines', () => {
  assert.equal(A.agentCreate({ name: 'dev', role: 'backend', model: 'opus' }),
    '/agent add dev --role "backend" --model opus');
  assert.equal(A.agentCreate({ name: 'dev' }), '/agent add dev');
  assert.equal(A.agentRemove('dev'), '/agent remove dev');
});

test('team lines', () => {
  assert.equal(A.teamCreate({ name: 'crew', agents: ['dev', 'qa'], lead: 'dev' }),
    '/team add crew --agents dev,qa --lead dev');
  assert.equal(A.teamCreate({ name: 'crew' }), '/team add crew');
  assert.equal(A.teamMemberAdd('crew', 'qa'), '/team member add crew qa');
  assert.equal(A.teamRemove('crew'), '/team remove crew');
});

test('task, config and workflow lines', () => {
  assert.equal(A.taskIssue({ team: 'crew', title: 'ship the thing' }),
    '/task start crew "ship the thing"');
  assert.equal(A.taskAbandon('t_1'), '/task abandon t_1');
  assert.equal(A.configSet('provider', 'claude-cli'), '/config set provider claude-cli');
  assert.equal(A.configUnset('provider'), '/config unset provider');
  assert.equal(A.workflowRun('nightly'), '/workflow run nightly');
  assert.equal(A.workflowResume('nightly'), '/workflow resume nightly');
});

test('values containing spaces or quotes are quoted safely', () => {
  assert.equal(A.taskIssue({ team: 'crew', title: 'say "hi" now' }),
    '/task start crew "say \\"hi\\" now"');
  assert.equal(A.configSet('greeting', 'hello world'), '/config set greeting "hello world"');
});

test('a missing required name is a thrown programming error, not a malformed line', () => {
  // A blank name would compose '/team remove ' — which the confirm table reads
  // as a destructive command with no target.
  for (const fn of [() => A.agentRemove(''), () => A.teamRemove(null), () => A.taskAbandon(undefined)]) {
    assert.throws(fn, /required/);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/f-slash-actions.test.mjs`
Expected: FAIL — `Cannot find module '../web/ui/slash_actions.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// web/ui/slash_actions.mjs — panel buttons compose the exact line a user would
// type. The grammar lives here, tested, rather than being concatenated inside
// five DOM modules where a drifting variant would go unnoticed.

function req(value, what) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${what} is required`);
  return s;
}

// Quote only when needed, and escape embedded quotes — an unquoted value with
// a space becomes two arguments and silently changes the command.
function arg(value) {
  const s = String(value ?? '');
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

export function agentCreate({ name, role, model }) {
  let line = `/agent add ${req(name, 'agent name')}`;
  if (role) line += ` --role ${arg(role)}`;
  if (model) line += ` --model ${arg(model)}`;
  return line;
}
export function agentRemove(name) { return `/agent remove ${req(name, 'agent name')}`; }

export function teamCreate({ name, agents, lead }) {
  let line = `/team add ${req(name, 'team name')}`;
  if (agents && agents.length) line += ` --agents ${agents.join(',')}`;
  if (lead) line += ` --lead ${arg(lead)}`;
  return line;
}
export function teamMemberAdd(team, agent) {
  return `/team member add ${req(team, 'team name')} ${req(agent, 'agent name')}`;
}
export function teamRemove(name) { return `/team remove ${req(name, 'team name')}`; }

export function taskIssue({ team, title }) {
  return `/task start ${req(team, 'team name')} ${arg(req(title, 'task title'))}`;
}
export function taskAbandon(id) { return `/task abandon ${req(id, 'task id')}`; }

export function configSet(key, value) { return `/config set ${req(key, 'config key')} ${arg(value)}`; }
export function configUnset(key) { return `/config unset ${req(key, 'config key')}`; }

export function workflowRun(name) { return `/workflow run ${req(name, 'workflow name')}`; }
export function workflowResume(name) { return `/workflow resume ${req(name, 'workflow name')}`; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/f-slash-actions.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Wire the panels**

In each of the five panel modules, import the composer and the confirmed runner, and add the buttons. The pattern, identical everywhere — this exact shape goes in each panel, with the composer swapped:

```js
import { runSlashConfirmed } from '../confirm_dialog.mjs';
import { teamRemove } from '../slash_actions.mjs';

// inside the row renderer:
el('button', {
  class: 'btn danger', text: 'Remove',
  onclick: async () => {
    const out = await runSlashConfirmed(teamRemove(t.name));
    if (out.ok) load();                       // re-read the panel's data
    else if (out.code !== 'CANCELLED') banner(out.error || 'failed', 'err');
  },
}),
```

Buttons to add: agents — create, remove. teams — create, add member, remove. tasks — issue, abandon. config — set, unset (key row). workflows — run, resume.

- [ ] **Step 6: Verify nothing regressed and commit**

Run: `node --test tests/*.test.mjs && npm run lint:size && npm run lint:pack`
Expected: all pass. Any panel that crosses 500 lines gets its row renderer split into a sibling module rather than an `ALLOW` entry.

```bash
git add web/ui/slash_actions.mjs web/ui/panels/ tests/f-slash-actions.test.mjs
git commit -m "feat(dashboard): write actions on the agents, teams, tasks, config and workflows panels"
```

---

### Task 9: Chat slash routing and autocomplete

**Files:**
- Modify: `web/ui/panels/chat.mjs`
- Test: `tests/f-chat-slash-routing.test.mjs`

**Interfaces:**
- Consumes: `runSlashConfirmed` (Task 7), `fetchCommands` (Task 6).
- Produces: `isSlashLine(text) -> boolean` and `filterCommands(all, prefix) -> Array<{name, description}>`, both exported from `web/ui/panels/chat.mjs` so the routing rule is testable without a DOM.

- [ ] **Step 1: Write the failing test**

```js
// tests/f-chat-slash-routing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSlashLine, filterCommands } from '../web/ui/panels/chat.mjs';

test('only a leading slash routes to the dispatcher', () => {
  assert.equal(isSlashLine('/status'), true);
  assert.equal(isSlashLine('  /status'), true, 'leading whitespace is trimmed');
  assert.equal(isSlashLine('what is /status?'), false, 'a slash mid-sentence is prose');
  assert.equal(isSlashLine('http://x/y'), false);
  assert.equal(isSlashLine(''), false);
  assert.equal(isSlashLine('/'), false, 'a bare slash is not a command yet');
});

test('autocomplete filters by prefix and keeps registry order', () => {
  const all = [
    { name: '/status', description: 'show status' },
    { name: '/skill', description: 'skills' },
    { name: '/team', description: 'teams' },
  ];
  assert.deepEqual(filterCommands(all, '/s').map((c) => c.name), ['/status', '/skill']);
  assert.deepEqual(filterCommands(all, '/te').map((c) => c.name), ['/team']);
  assert.deepEqual(filterCommands(all, '/').map((c) => c.name), ['/status', '/skill', '/team']);
  assert.deepEqual(filterCommands(all, '/zz'), []);
});

test('filtering is case-insensitive and ignores a trailing argument', () => {
  const all = [{ name: '/team', description: 'teams' }];
  assert.deepEqual(filterCommands(all, '/TE').map((c) => c.name), ['/team']);
  assert.deepEqual(filterCommands(all, '/team add crew'), [],
    'once an argument is typed the popover closes');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/f-chat-slash-routing.test.mjs`
Expected: FAIL — `isSlashLine is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `web/ui/panels/chat.mjs`:

```js
import { runSlashConfirmed } from '../confirm_dialog.mjs';
import { fetchCommands } from '../slash_client.mjs';

/**
 * A leading slash routes to the dispatcher; anything else is a message.
 * Exported so the rule is testable without a DOM.
 */
export function isSlashLine(text) {
  const s = String(text ?? '').trim();
  return s.length > 1 && s.startsWith('/');
}

/**
 * Autocomplete candidates for what has been typed so far. Returns nothing once
 * an argument has been typed — the popover is for choosing a command, not for
 * hovering over one already chosen.
 */
export function filterCommands(all, prefix) {
  const p = String(prefix ?? '').trim().toLowerCase();
  if (!p.startsWith('/') || /\s/.test(p)) return [];
  return (all || []).filter((c) => c.name.toLowerCase().startsWith(p));
}
```

and in the send handler, before the existing `POST /conversation` call:

```js
if (isSlashLine(text)) {
  appendMsg('user', text);
  const out = await runSlashConfirmed(text);
  if (out.ok) for (const line of out.lines) appendMsg('system', line);
  else if (out.code !== 'CANCELLED') appendMsg('error', out.error || 'command failed');
  return;
}
```

Load the command list once on panel mount (`fetchCommands()`), and render `filterCommands(list, input.value)` as a popover under the input.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/f-chat-slash-routing.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
npm run lint:size
git add web/ui/panels/chat.mjs tests/f-chat-slash-routing.test.mjs
git commit -m "feat(dashboard): route slash input to the dispatcher, with autocomplete"
```

---

### Task 10: The terminal-zero E2E

**Files:**
- Create: `tests/phaseI-dashboard-operations.spec.ts`

**Interfaces:**
- Consumes: everything above, through the browser only.

This is the plan's done bar: the scenario approved during brainstorming, with no terminal command anywhere in it.

- [ ] **Step 1: Write the failing spec**

```ts
// tests/phaseI-dashboard-operations.spec.ts — the done bar for phase 2.
//
// A representative operating loop, start to finish, with no terminal command:
// build a team, give it work, answer its approval request, read the result,
// change a setting, run it again. If this passes, the dashboard is sufficient
// for a week of ordinary use — which is the whole point of the phase.
import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

let daemon: ChildProcess;
let baseUrl: string;
let cfgDir: string;

test.beforeAll(async () => {
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-e2e-ops-'));
  // A fake provider keeps the run deterministic and offline.
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ provider: 'fake' }));
  daemon = spawn(process.execPath, [path.resolve('cli.mjs'), 'daemon', '--port', '0'], {
    env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  baseUrl = await new Promise((resolve) => {
    daemon.stdout!.on('data', (b) => {
      const m = String(b).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) resolve(m[0]);
    });
  });
});

test.afterAll(async () => {
  daemon?.kill();
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

test('a full operating loop runs without touching the terminal', async ({ page }) => {
  await page.goto(baseUrl);

  // 1. build a team of two agents
  await page.click('[data-nav="agents"]');
  for (const name of ['dev', 'qa']) {
    await page.click('[data-action="agent-create"]');
    await page.fill('[name="agent-name"]', name);
    await page.click('[data-action="agent-create-submit"]');
    await expect(page.locator(`[data-agent="${name}"]`)).toBeVisible();
  }
  await page.click('[data-nav="teams"]');
  await page.click('[data-action="team-create"]');
  await page.fill('[name="team-name"]', 'crew');
  await page.fill('[name="team-agents"]', 'dev,qa');
  await page.click('[data-action="team-create-submit"]');
  await expect(page.locator('[data-team="crew"]')).toBeVisible();

  // 2. give it work, and watch progress arrive
  await page.click('[data-nav="tasks"]');
  await page.click('[data-action="task-issue"]');
  await page.fill('[name="task-team"]', 'crew');
  await page.fill('[name="task-title"]', 'ship the thing');
  await page.click('[data-action="task-issue-submit"]');
  const row = page.locator('[data-task-title="ship the thing"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.status')).not.toHaveText('pending', { timeout: 15_000 });

  // 3. answer the approval request inline
  await page.click('[data-nav="approvals"]');
  const approval = page.locator('[data-approval]').first();
  await expect(approval).toBeVisible({ timeout: 15_000 });
  await approval.locator('[data-action="approve"]').click();
  await expect(approval).toHaveCount(0);

  // 4. read the result, then change a setting
  await page.click('[data-nav="tasks"]');
  await expect(row.locator('.status')).toHaveText(/done|failed/, { timeout: 30_000 });
  await page.click('[data-nav="config"]');
  await page.fill('[name="config-key"]', 'maxTokens');
  await page.fill('[name="config-value"]', '4096');
  await page.click('[data-action="config-set"]');
  await expect(page.locator('[data-config-key="maxTokens"]')).toHaveText(/4096/);

  // 5. run it again
  await page.click('[data-nav="tasks"]');
  await row.locator('[data-action="task-retry"]').click();
  await expect(row.locator('.status')).not.toHaveText('failed', { timeout: 30_000 });
});

test('a destructive action asks before it acts, and a decline changes nothing', async ({ page }) => {
  await page.goto(baseUrl);
  await page.click('[data-nav="teams"]');
  await page.locator('[data-team="crew"] [data-action="team-remove"]').click();
  await expect(page.locator('.modal')).toContainText('crew');
  await page.click('.modal [data-action="cancel"]');
  await expect(page.locator('[data-team="crew"]')).toBeVisible();

  await page.locator('[data-team="crew"] [data-action="team-remove"]').click();
  await page.click('.modal [data-action="confirm"]');
  await expect(page.locator('[data-team="crew"]')).toHaveCount(0);
});
```

- [ ] **Step 2: Run the spec to see it fail**

Run: `npx playwright test tests/phaseI-dashboard-operations.spec.ts`
Expected: FAIL on the first missing `data-action` / `data-nav` hook.

- [ ] **Step 3: Add the hooks**

Add the `data-nav`, `data-action`, `data-agent`, `data-team`, `data-task-title` and `data-config-key` attributes named above to the panels and the confirm dialog. They are test hooks only — no behaviour changes.

- [ ] **Step 4: Run the spec until it passes**

Run: `npx playwright test tests/phaseI-dashboard-operations.spec.ts`
Expected: PASS, 2 tests. Run it alone — this suite flakes under concurrent load.

- [ ] **Step 5: Full gate and commit**

```bash
node --test tests/*.test.mjs && npm run lint:size && npm run lint:pack
npx playwright test
git add tests/phaseI-dashboard-operations.spec.ts web/ui/
git commit -m "test(dashboard): terminal-zero operating loop as the phase-2 done bar"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md` (the `## The dashboard` section), `README.ko.md` (the `## 대시보드` section), `CHANGELOG.md` (Unreleased)

**Interfaces:**
- Consumes: the shipped behaviour of Tasks 1-10.

- [ ] **Step 1: Update the dashboard section in both READMEs**

State what changed for a reader: the dashboard now creates and edits agents, teams and tasks, edits config, runs workflows, and accepts slash commands in chat; destructive actions ask first; everything goes through the same commands the CLI runs, so the two cannot drift.

- [ ] **Step 2: Add the CHANGELOG entry under `## [Unreleased]`**

```markdown
### Added

- **The dashboard is now a working surface, not just a view.** Agents, teams,
  tasks, config keys and workflows can be created, edited and run from the
  browser, and the chat input accepts every slash command the REPL does.
  Destructive actions ask first, naming what they will affect.

  Everything routes through one endpoint (`POST /slash`) that runs the same
  dispatcher the CLI uses, so a command added to the terminal appears in the
  dashboard with no extra work and the two cannot disagree about what a command
  means. Authorization is unchanged: the existing bearer token carries full
  authority, exactly as it does for the CLI.
```

- [ ] **Step 3: Commit**

```bash
git add README.md README.ko.md CHANGELOG.md
git commit -m "docs: dashboard operations in the READMEs and CHANGELOG"
```

---

## Self-Review

**Spec coverage:** architecture → Tasks 3-4; envelope → Task 3; confirm tokens → Tasks 1, 3, 4, 6; capability gating → Task 3 (gate-coverage test); destructive actions → Tasks 2, 6; panels → Task 7; chat → Task 8; done bar → Task 9; unit tests → Tasks 1-10; file map → all tasks. `data` on the envelope is declared optional in the spec and no task populates it, which matches "introduced per-command as panels need structure" — the panels here need only `lines`.

**Placeholder scan:** no TBD/TODO; every code step carries real code; Task 7 Step 5 and Task 9 Step 3 describe repetitive DOM edits with one complete worked example each rather than repeating it five times.

**Type consistency:** `makeConfirmStore` → `{issue, redeem, size}` used identically in Tasks 3-4. `destructivePrompt(cmd, args)` returns `string|null`, matching Task 3's `if (prompt)`. `runSlash` → envelope, consumed by `runSlashConfirmed`, consumed by panels and chat. `buildHttpCtx({cfgDir, autoApprove})` is called in exactly that shape in Task 3's implementation and tests.

---

### Task 12: `/config set` and `/config unset` as real slash commands

**Execute this task BEFORE Task 8** — Task 8's config composers depend on the grammar it creates. It is numbered 12 only so Tasks 1-2, already implemented, keep their numbers.

**Files:**
- Modify: `tui/config_picker.mjs` (`runConfigSlash`)
- Test: `tests/f-config-slash-set.test.mjs`

**Interfaces:**
- Consumes: `readConfig`/`writeConfig` off the slash `ctx`; `validateConfig` from `config-validate.mjs`; `PROVIDERS` from `providers/registry.mjs`.
- Produces: `/config set <key> <value>` and `/config unset <key>` accepted by the existing `/config` handler, returning a human string.

**Why:** `runConfigSlash(_args, ctx, handlers)` ignores its arguments and only opens a picker. Over HTTP there is no picker, so it sets `ctx.requestSetup` and returns `'EXIT'` — which the adapter collapses to `{ok: true, lines: []}`. A dashboard config edit would report success and change nothing. Rather than give the dashboard a grammar the CLI lacks, the command learns to take arguments; the no-argument picker path is untouched.

`daemon/routes/config.mjs`'s `configKeyPut` is the reference for the rules this must match: nested cargo is refused, the whole config is re-validated before persisting, and `api-key` is masked in the echo.

- [ ] **Step 1: Write the failing test**

```js
// tests/f-config-slash-set.test.mjs — /config learns to take arguments.
//
// Before this, `/config set provider claude-cli` opened a picker and ignored
// every argument. Over HTTP, where there is no picker, it reported success and
// changed nothing — the worst failure shape available: silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runConfigSlash } from '../tui/config_picker.mjs';

// A ctx with no openPicker is exactly what the HTTP adapter supplies.
function mkCtx(initial = {}) {
  let cfg = { ...initial };
  return {
    readConfig: () => ({ ...cfg }),
    writeConfig: (next) => { cfg = { ...next }; },
    _read: () => cfg,
  };
}

test('set writes the key and reports what it stored', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  const out = await runConfigSlash('set model opus', ctx, new Map());
  assert.match(String(out), /model/);
  assert.equal(ctx._read().model, 'opus');
});

test('unset deletes the key', async () => {
  const ctx = mkCtx({ provider: 'claude-cli', model: 'opus' });
  await runConfigSlash('unset model', ctx, new Map());
  assert.equal('model' in ctx._read(), false);
});

test('a numeric-looking value is stored as a number, not a string', async () => {
  // config.json is typed; storing "4096" where a number belongs fails
  // validation later, far from the command that caused it.
  const ctx = mkCtx({ provider: 'claude-cli' });
  await runConfigSlash('set maxTokens 4096', ctx, new Map());
  assert.strictEqual(ctx._read().maxTokens, 4096);
  await runConfigSlash('set someFlag true', ctx, new Map());
  assert.strictEqual(ctx._read().someFlag, true);
  await runConfigSlash('set note hello', ctx, new Map());
  assert.strictEqual(ctx._read().note, 'hello');
});

test('a quoted value keeps its spaces', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  await runConfigSlash('set note "hello world"', ctx, new Map());
  assert.equal(ctx._read().note, 'hello world');
});

test('nested cargo is refused, exactly as the daemon route refuses it', async () => {
  // daemon/routes/config.mjs sends customProviders / rates / authProfiles to
  // dedicated endpoints so schema validation cannot be bypassed. The slash
  // path must not become the bypass.
  const ctx = mkCtx({ provider: 'claude-cli' });
  for (const key of ['customProviders', 'rates', 'authProfiles']) {
    const out = await runConfigSlash(`set ${key} x`, ctx, new Map());
    assert.match(String(out), /dedicated endpoint|not settable/i, `${key} must be refused`);
    assert.equal(key in ctx._read(), false);
  }
});

test('a write that would break the config is rejected and nothing is persisted', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  const out = await runConfigSlash('set provider not-a-real-provider', ctx, new Map());
  assert.match(String(out), /invalid|unknown|not/i);
  assert.equal(ctx._read().provider, 'claude-cli', 'the previous value survives a rejected write');
});

test('an api-key value is not echoed back in the clear', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  const out = await runConfigSlash('set api-key sk-ant-SECRETVALUE', ctx, new Map());
  assert.doesNotMatch(String(out), /SECRETVALUE/, 'the reply is rendered into a browser and a terminal');
  assert.equal(ctx._read()['api-key'], 'sk-ant-SECRETVALUE', 'but the real value is stored');
});

test('usage is reported for a malformed line, and nothing is written', async () => {
  const ctx = mkCtx({ provider: 'claude-cli' });
  for (const line of ['set', 'set onlykey', 'unset']) {
    const out = await runConfigSlash(line, ctx, new Map());
    assert.match(String(out), /usage/i, `"${line}" must explain itself`);
  }
  assert.deepEqual(ctx._read(), { provider: 'claude-cli' });
});

test('no arguments still opens the picker — the existing behaviour is untouched', async () => {
  let opened = false;
  const ctx = { ...mkCtx({}), openPicker: async () => { opened = true; return { id: 'CANCEL' }; } };
  await runConfigSlash('', ctx, new Map());
  assert.equal(opened, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/f-config-slash-set.test.mjs`
Expected: FAIL — every argument is ignored, so the set/unset assertions fail.

- [ ] **Step 3: Write minimal implementation**

At the top of `runConfigSlash`, before the picker path, parse an argument line. Reuse `splitWhitespace` from `tui/slash_helpers.mjs` (it already handles quoted values) rather than writing a second tokenizer.

```js
// `/config set <key> <value>` / `/config unset <key>`. Added because the
// dashboard needs to change a setting and this command ignored its arguments
// entirely — over HTTP, where there is no picker, it reported success and
// wrote nothing. The rules mirror daemon/routes/config.mjs's configKeyPut:
// nested cargo goes to its dedicated endpoint, the whole config is
// re-validated before it is persisted, and api-key is never echoed.
const NESTED = new Set(['customProviders', 'rates', 'authProfiles']);
const USAGE = 'usage: /config set <key> <value>  ·  /config unset <key>  ·  /config with no arguments opens the picker';

// Values arrive as text but config.json is typed.
function coerce(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}
```

and inside `runConfigSlash`, first thing:

```js
  const tokens = splitWhitespace(String(_args || '').trim());
  const verb = (tokens[0] || '').toLowerCase();
  if (verb === 'set' || verb === 'unset') {
    if (typeof ctx.readConfig !== 'function' || typeof ctx.writeConfig !== 'function') {
      return 'config: this session cannot write config';
    }
    const key = tokens[1];
    if (!key || (verb === 'set' && tokens.length < 3)) return USAGE;
    if (NESTED.has(key)) {
      return `config: "${key}" is not settable here — use the dedicated endpoint (POST /providers · PUT /rates/<key> · authProfiles via CLI)`;
    }
    const cfg = ctx.readConfig();
    if (verb === 'unset') delete cfg[key];
    else cfg[key] = coerce(tokens.slice(2).join(' '));
    const v = validateConfig(cfg, PROVIDERS);
    if (!v.ok) return `config: invalid — ${(v.errors || []).join('; ') || 'validation failed'}`;
    ctx.writeConfig(cfg);
    if (verb === 'unset') return `config: unset ${key}`;
    const shown = key === 'api-key' ? maskApiKey(String(cfg[key])) : JSON.stringify(cfg[key]);
    return `config: set ${key} = ${shown}`;
  }
```

Add the imports this needs (`splitWhitespace`, `validateConfig`, `PROVIDERS`, `maskApiKey`) alongside the file's existing imports. Check the exact export names before importing — `maskApiKey` comes from `providers/registry.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/f-config-slash-set.test.mjs && node --test tests/*.test.mjs`
Expected: PASS. The REPL's own `/config` tests must stay green — the no-argument path is unchanged.

- [ ] **Step 5: Commit**

```bash
npm run lint:size
git add tui/config_picker.mjs tests/f-config-slash-set.test.mjs
git commit -m "feat(config): /config set and /config unset take arguments"
```

---
