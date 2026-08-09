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
