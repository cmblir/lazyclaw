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
import { readConfig } from '../lib/config.mjs';

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

// --- ctx.getProv / resolveAuthKey / resolveBaseUrl (fix round 1) ----------
//
// /loop and /dream (tui/slash_dispatcher.mjs:660,433) call ctx.getProv()
// UNGUARDED — its absence is a crash (`ctx.getProv is not a function`), not a
// graceful fallback, which is exactly what shipped in task 5's first pass:
// STREAMING advertised /loop as runnable but buildHttpCtx never set
// ctx.getProv at all. These pin the fix directly against a real config.json,
// separately from the heavier real-dispatcher SSE tests in
// tests/f-slash-sse.test.mjs, so a regression here is diagnosed in one line
// instead of by chasing a deep integration failure.
test('ctx.getProv resolves the REAL provider named by the persisted config, not a stub', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-getprov-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: 'mock', model: 'mock-model' }));
    const ctx = buildHttpCtx({ cfgDir: dir });
    assert.equal(typeof ctx.getProv, 'function', '/loop and /dream call this unguarded — its absence is a crash, not a fallback');
    const prov = ctx.getProv();
    assert.equal(prov?.name, 'mock', 'must be the actual registry entry for the persisted provider, not a placeholder');
    assert.equal(typeof prov.sendMessage, 'function');
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ctx.getProv returns undefined (not a throw) for an unconfigured/unknown provider — /loop already turns that into "no active provider"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-getprov-none-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: 'not-a-real-provider' }));
    const ctx = buildHttpCtx({ cfgDir: dir });
    assert.equal(ctx.getProv(), undefined);
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ctx.resolveAuthKey returns the REAL persisted api-key, the same resolver daemon/routes/providers.mjs already uses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-authkey-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: 'openai', 'api-key': 'sk-real-persisted-key' }));
    const ctx = buildHttpCtx({ cfgDir: dir });
    assert.equal(typeof ctx.resolveAuthKey, 'function', '/loop and /task tick call this — guarded, but silently wrong without a real value');
    assert.equal(ctx.resolveAuthKey('openai'), 'sk-real-persisted-key');
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ctx.resolveBaseUrl honours the same POMPOS_*_BASE_URL env override the CLI uses', () => {
  const ctx = buildHttpCtx({ cfgDir: CFG });
  assert.equal(typeof ctx.resolveBaseUrl, 'function');
  const prev = process.env.POMPOS_OPENAI_BASE_URL;
  process.env.POMPOS_OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
  try {
    assert.equal(ctx.resolveBaseUrl('openai'), 'http://127.0.0.1:9/v1');
  } finally {
    if (prev === undefined) delete process.env.POMPOS_OPENAI_BASE_URL;
    else process.env.POMPOS_OPENAI_BASE_URL = prev;
  }
});

// --- ctx.cfg must be real, and must not go stale mid-request --------------

test('ctx.cfg is populated — /status does not blank out a key that is actually configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-cfg-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      provider: 'anthropic', model: 'claude-x', 'api-key': 'sk-ant-seeded-secret-value',
    }));
    const ctx = buildHttpCtx({ cfgDir: dir });
    assert.deepEqual(ctx.cfg, readConfig(), 'ctx.cfg must be the real, current config — not absent, not a stale copy');
    const { dispatchSlash } = await import('../tui/slash_dispatcher.mjs');
    const status = await dispatchSlash('/status', '', ctx, () => {});
    assert.doesNotMatch(status, /api key:\s*\n/, '/status must not print a blank key line for a config that has one');
    assert.match(status, /api key:\s+\S/, 'the masked key must actually appear');
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ctx.writeConfig keeps ctx.cfg in sync within the SAME request — no stale read after a write', async () => {
  const r = runnerWith(async (_cmd, _args, ctx) => {
    ctx.writeConfig({ ...ctx.cfg, marker: 'written-mid-request' });
    // A handler reading ctx.cfg again later in the same call (e.g. a second
    // in-chat step chained off /menu) must see what it JUST wrote, not the
    // snapshot taken when the request started.
    return ctx.cfg.marker;
  });
  const out = await r.run({ line: '/anything' });
  assert.deepEqual(out, { ok: true, lines: ['written-mid-request'] });
});

// --- cfgDir must actually govern the request, or fail loudly --------------

test('buildHttpCtx refuses a cfgDir that does not match POMPOS_CONFIG_DIR', () => {
  assert.throws(
    () => buildHttpCtx({ cfgDir: '/not/the/active/config/dir' }),
    /POMPOS_CONFIG_DIR/,
    'readConfig/writeConfig resolve the directory from the env var, not from cfgDir — a mismatch must not pass silently',
  );
});

test('a mismatched cfgDir surfaces as a clean envelope through run(), not a crash', async () => {
  const r = makeSlashRunner({ cfgDir: '/not/the/active/config/dir', confirmStore: makeConfirmStore() });
  const out = await r.run({ line: '/status' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'CONFIG_DIR_MISMATCH');
});

// --- commands that cannot honor what they claim over a one-shot call ------

test('/skill <name> is refused before dispatch — there is no chat session to persist it into', async () => {
  let ran = false;
  const r = runnerWith(async () => { ran = true; return 'active skills: review'; });
  const out = await r.run({ line: '/skill review' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NO_SESSION');
  assert.match(out.error, /session/i);
  assert.equal(ran, false, 'nothing reaches the dispatcher — it would falsely report success');
});

test('/skill clear is refused the same way (no point confirming a no-op)', async () => {
  let ran = false;
  const r = runnerWith(async () => { ran = true; return 'cleared system prompt (no active skills)'; });
  const out = await r.run({ line: '/skill clear' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NO_SESSION');
  assert.equal(ran, false);
});

test('/skill with no args is read-only (list/usage) and still reaches the dispatcher', async () => {
  const r = runnerWith(async () => 'usage: /skill <name>[,<name>]');
  const out = await r.run({ line: '/skill' });
  assert.equal(out.ok, true);
});

test('/skills <name> is refused the same way — it forwards straight into _skill', async () => {
  let ran = false;
  const r = runnerWith(async () => { ran = true; return 'active skills: review'; });
  const out = await r.run({ line: '/skills review' });
  assert.equal(out.code, 'NO_SESSION');
  assert.equal(ran, false);
});

test('/goal <name> (switch) is refused before dispatch — same reason as /skill', async () => {
  let ran = false;
  const r = runnerWith(async () => { ran = true; return '✓ switched to goal: mygoal (session: goal:mygoal, 0 prior turn(s))'; });
  const out = await r.run({ line: '/goal mygoal' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NO_SESSION');
  assert.equal(ran, false);
});

test('/goal add|list|show|close persist through goals.mjs, not a session — they reach the dispatcher', async () => {
  const r = runnerWith(async (cmd, args) => `${cmd} ${args}`);
  for (const line of ['/goal add myname --desc hi', '/goal list', '/goal show myname', '/goal close myname done']) {
    const out = await r.run({ line });
    assert.equal(out.ok, true, `${line} must not be treated as session-only`);
  }
});

// --- commands that spawn or kill a process on the DAEMON'S OWN HOST must
//     never reach dispatch over HTTP (fix round 1: /gateway start|stop was
//     the sibling the first pass of this guard missed — /dashboard was
//     covered, /gateway was not, even though gatewayStop() reaches
//     process.kill(pid, ...) on a real pidfile'd process). Asserted on the
//     guard's own behaviour (a spy dispatch that must never run), not by
//     spawning or killing anything real. ------------------------------------

test('/dashboard is refused before dispatch — it would spawn a process on the daemon host', async () => {
  let ran = false;
  const r = runnerWith(async () => { ran = true; return 'started'; });
  const out = await r.run({ line: '/dashboard' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NEEDS_TERMINAL');
  assert.equal(ran, false, 'nothing reaches the dispatcher — no child process may be spawned');
});

test('/dashboard stop is refused the same way — it would pkill processes on the daemon host', async () => {
  let ran = false;
  const r = runnerWith(async () => { ran = true; return 'stopped'; });
  const out = await r.run({ line: '/dashboard stop' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NEEDS_TERMINAL');
  assert.equal(ran, false);
});

test('/gateway start is refused before dispatch — it would spawn a process on the daemon host', async () => {
  let ran = false;
  const r = runnerWith(async () => { ran = true; return 'gateway: started'; });
  const out = await r.run({ line: '/gateway start' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NEEDS_TERMINAL', 'same code as /dashboard — same class of problem');
  assert.equal(ran, false, 'nothing reaches the dispatcher — no child process may be spawned');
});

test('/gateway stop is refused before dispatch — it would process.kill a real pid on the daemon host', async () => {
  let ran = false;
  const r = runnerWith(async () => { ran = true; return 'gateway: stopped'; });
  const out = await r.run({ line: '/gateway stop' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NEEDS_TERMINAL', 'same code as /dashboard — same class of problem');
  assert.equal(ran, false, 'nothing reaches the dispatcher — no process may be killed');
});

test('/gateway START (any case) is refused the same way — the guard is not case-sensitive on the subcommand', async () => {
  let ran = false;
  const r = runnerWith(async () => { ran = true; });
  const out = await r.run({ line: '/gateway START' });
  assert.equal(out.code, 'NEEDS_TERMINAL');
  assert.equal(ran, false);
});

test('/gateway status and bare /gateway reach the dispatcher — read-only, no process touched', async () => {
  const r = runnerWith(async (cmd, args) => `${cmd} ${args}`.trim());
  for (const line of ['/gateway status', '/gateway']) {
    const out = await r.run({ line });
    assert.equal(out.ok, true, `${line} must not be treated as host-only`);
  }
});

test('/gateway port reaches the dispatcher — it only reads/writes a config value, no process touched', async () => {
  const r = runnerWith(async (cmd, args) => `${cmd} ${args}`);
  const out = await r.run({ line: '/gateway port 19700' });
  assert.equal(out.ok, true);
});

// --- EXIT + a foreground-action flag must never collapse to a silent
//     success — fix round 2 found /login was missing from this check
//     (only requestSetup/requestConfigStep were covered). All three flags
//     tested here by name, via a spy dispatch, so a regression on ANY of
//     them — not just the one that was reported — fails loudly. ------------

test('EXIT + ctx.requestSetup collapses to NEEDS_TERMINAL, not a silent success', async () => {
  const r = runnerWith(async (_cmd, _args, ctx) => { ctx.requestSetup = true; return 'EXIT'; });
  const out = await r.run({ line: '/setup' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NEEDS_TERMINAL');
});

test('EXIT + ctx.requestConfigStep collapses to NEEDS_TERMINAL, not a silent success', async () => {
  const r = runnerWith(async (_cmd, _args, ctx) => { ctx.requestConfigStep = 'channel'; return 'EXIT'; });
  const out = await r.run({ line: '/config' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NEEDS_TERMINAL');
});

test('EXIT + ctx.requestLogin collapses to NEEDS_TERMINAL, not {ok:true, lines:[]} (fix round 2)', async () => {
  // tui/login_flow.mjs's maybeLoginForCli really sets ctx.requestLogin and
  // returns 'EXIT' this way once ctx.openPicker exists and the operator
  // picks "browser"/"install" — proven directly against the real handler in
  // tests/f-cli-login.test.mjs ("browser pick queues a foreground login").
  // This adapter's plain HTTP ctx has no openPicker (buildHttpCtx only adds
  // one for a redeemed destructive confirmation, and /login isn't
  // destructive), so a bare `/login <provider>` can't reach that branch
  // TODAY — but the moment anything gives this ctx a picker, it will, and
  // this is the mechanism that must catch it. The spy reproduces exactly
  // that shape without needing a picker plumbed all the way through.
  const r = runnerWith(async (_cmd, _args, ctx) => {
    ctx.requestLogin = { provider: 'codex-cli', mode: 'browser' };
    return 'EXIT';
  });
  const out = await r.run({ line: '/login codex-cli' });
  assert.equal(out.ok, false, 'a foreground login was queued and never ran — this must not read as success');
  assert.equal(out.code, 'NEEDS_TERMINAL');
  assert.notDeepEqual(out, { ok: true, lines: [] });
});

// --- /provider and /model must actually persist, not just claim to --------

test('/provider <name> and /model <name> persist to config.json (real dispatcher, no mock)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-persist-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: 'openai', model: 'gpt-4' }));
    const r = makeSlashRunner({ cfgDir: dir, confirmStore: makeConfirmStore() }); // default dispatch = the real one
    const p = await r.run({ line: '/provider anthropic' });
    assert.equal(p.ok, true);
    assert.equal(readConfig().provider, 'anthropic', 'the switch must land on disk, not just in the response string');

    const m = await r.run({ line: '/model claude-x' });
    assert.equal(m.ok, true);
    assert.equal(readConfig().model, 'claude-x');

    // A later, independent request (a fresh ctx, same as a new HTTP call)
    // must see the switch too — proving it is not an artifact of one ctx.
    const status = await r.run({ line: '/status' });
    assert.match(status.lines[0], /provider:\s+anthropic/);
    assert.match(status.lines[0], /model:\s+claude-x/);
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- /provider and /model must not claim success when persistence silently
//     failed — the same defect class Critical 2 removed, reopened in this
//     narrower path by making corrupt-config reads no longer throw eagerly --

test('/provider <name> against a corrupt config.json does not report success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-pfail-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), 'not json {');
    const r = makeSlashRunner({ cfgDir: dir, confirmStore: makeConfirmStore() }); // real dispatcher, no mock
    const out = await r.run({ line: '/provider anthropic' });
    assert.equal(out.ok, false, 'nothing changed — the envelope must not claim it did');
    assert.notEqual(out.code, 'CONFIG_DIR_MISMATCH', 'cfgDir and POMPOS_CONFIG_DIR agree here');
    assert.match(out.error, /provider/i);
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/model <name> against a corrupt config.json does not report success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-mfail-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), 'not json {');
    const r = makeSlashRunner({ cfgDir: dir, confirmStore: makeConfirmStore() });
    const out = await r.run({ line: '/model claude-x' });
    assert.equal(out.ok, false, 'nothing changed — the envelope must not claim it did');
    assert.notEqual(out.code, 'CONFIG_DIR_MISMATCH');
    assert.match(out.error, /model/i);
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/provider orchestrator does not report success, and does not blame config.json', async () => {
  // config.json here is perfectly valid — persistActiveProvider's OWN
  // deliberate guard (lib/config.mjs:109) refuses to write the literal name
  // "orchestrator" (that routing is owned by /orchestrator on|off). The
  // outcome (ok:false) is correct; the earlier version of this fix invented
  // "check that config.json is valid JSON and writable" as the cause, which
  // sends an operator to inspect a file that has nothing wrong with it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-orch-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: 'openai', model: 'gpt-4' }));
    const r = makeSlashRunner({ cfgDir: dir, confirmStore: makeConfirmStore() });
    const out = await r.run({ line: '/provider orchestrator' });
    assert.equal(out.ok, false, 'nothing changed — /provider deliberately never sets this value');
    assert.doesNotMatch(out.error, /valid JSON|writable/i,
      'config.json is fine here — the message must not send the operator to inspect it');
    assert.match(out.error, /orchestrator/i, 'the message should name the actual reason: orchestrator routing');
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- a corrupt config.json must not take down commands that never touch it,
//     and must not be mislabelled as a cfgDir/env mismatch when it does -----

test('/help succeeds even when config.json is present but corrupt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-corrupt-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json');
    const r = makeSlashRunner({ cfgDir: dir, confirmStore: makeConfirmStore() });
    const out = await r.run({ line: '/help' });
    assert.equal(out.ok, true, '/help reads no config at all — a broken config.json must not block it');
    assert.match(out.lines[0], /slash commands:/);
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a config-reading command against a corrupt config.json names the parse problem, not a cfgDir mismatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-corrupt2-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json');
    const r = makeSlashRunner({ cfgDir: dir, confirmStore: makeConfirmStore() });
    const out = await r.run({ line: '/status' });
    assert.equal(out.ok, false);
    assert.notEqual(out.code, 'CONFIG_DIR_MISMATCH', 'cfgDir and POMPOS_CONFIG_DIR actually agree here — this is not that failure');
    assert.match(out.error, /not valid JSON/i, 'the operator must learn the FILE is bad, not go hunting for an env mismatch');
    assert.match(out.error, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the message must name the config file');
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the corrupt-config stderr diagnostic is deduped per file mtime, not printed once per request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-corrupt3-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  const origWrite = process.stderr.write.bind(process.stderr);
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), 'not json {');
    const r = makeSlashRunner({ cfgDir: dir, confirmStore: makeConfirmStore() });
    let calls = 0;
    process.stderr.write = (...a) => { calls += 1; return origWrite(...a); };
    for (let i = 0; i < 5; i++) await r.run({ line: '/status' });
    assert.equal(calls, 1, 'five requests against the SAME unchanged corrupt file must log the diagnostic once, not five times');

    // A genuine change to the file (new mtime) must be re-detected, not
    // masked forever by the dedup cache.
    fs.writeFileSync(path.join(dir, 'config.json'), 'still not json {{');
    calls = 0;
    await r.run({ line: '/status' });
    assert.equal(calls, 1, 'a file that actually changed must log again, not stay silent');
  } finally {
    process.stderr.write = origWrite;
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- gate coverage --------------------------------------------------------

test('every registered command survives the HTTP ctx without throwing', async () => {
  // A handler that reaches for something the HTTP ctx does not provide would
  // throw and take the route down with it. Running the whole registry through
  // the real ctx is what keeps a future command from doing that. Every thrown
  // class is recorded, not just TypeError — a handler that throws a plain
  // Error, a ReferenceError, or anything else given this ctx is just as much
  // a crash, and filtering by class let that whole category pass silently.
  const { dispatchSlash } = await import('../tui/slash_dispatcher.mjs');
  const ctx = buildHttpCtx({ cfgDir: CFG });
  const broke = [];
  for (const name of SLASH_HANDLERS.keys()) {
    try {
      await dispatchSlash(name, '', { ...ctx }, () => {});
    } catch (err) {
      broke.push(`${name}: ${err?.constructor?.name || typeof err}: ${err?.message || err}`);
    }
  }
  assert.deepEqual(broke, [], 'these throw when run through the HTTP ctx');
});

// Empty args alone is not a strong enough gate: it only exercises the usage/
// no-op branch of many handlers (e.g. /loop's `if (!args) return usage...`,
// tui/slash_dispatcher.mjs:645), which is exactly how the missing
// ctx.getProv() crash slipped past this suite (task 5, fix round 1) — /loop
// only reaches ctx.getProv() when given an actual prompt, and the fake
// `dispatch` every OTHER test in this file injects never reaches a real
// handler at all. A single non-empty token is enough to fall past every
// "no args" branch in tui/slash_dispatcher.mjs without hand-crafting real
// syntax per command: for a multi-subcommand handler it becomes an
// unrecognised `sub` (verified by reading each one — /agent, /team, /task,
// /goal, /gateway, /trainer, /channels, /config, /orchestrator, /personality
// all answer an unknown first token with a safe "unknown sub"/"unknown
// subcommand" string rather than acting on it), and for a single-value
// command (/loop, /provider, /model, /skill, /login, /recall, ...) it is
// exactly the representative argument the review round asked for. Isolated
// cfgDir + real ctx (not the shared CFG / not a fake dispatch) so a command
// that DOES persist on a real arg (e.g. /model) can't leak into any other
// test in this file.
test('every registered command survives the HTTP ctx without throwing OR silently reporting a missing ctx accessor, given a representative arg', async () => {
  const { dispatchSlash } = await import('../tui/slash_dispatcher.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-http-gate-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    const ctx = buildHttpCtx({ cfgDir: dir });
    const broke = [];
    for (const args of ['', 'hello']) {
      for (const name of SLASH_HANDLERS.keys()) {
        let out;
        try {
          out = await dispatchSlash(name, args, { ...ctx }, () => {});
        } catch (err) {
          broke.push(`${name} ${JSON.stringify(args)}: threw ${err?.constructor?.name || typeof err}: ${err?.message || err}`);
          continue;
        }
        // A handler that catches its own TypeError internally and reports it
        // as a plain string (this is exactly how /dream — which also calls
        // ctx.getProv() unconditionally — masked the same bug: its own
        // try/catch turned the TypeError into a returned "dream error: ctx.
        // getProv is not a function" string, so it never threw at all) would
        // pass the throw-only check above either way. This is the check that
        // actually would have caught it.
        if (typeof out === 'string' && /is not a function/i.test(out)) {
          broke.push(`${name} ${JSON.stringify(args)}: returned "${out}" — a ctx accessor this command needs is missing`);
        }
      }
    }
    assert.deepEqual(broke, [], 'these throw, or silently report a missing ctx accessor, when run through the HTTP ctx with a real argument');
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listCommands mirrors the dispatcher registry exactly', () => {
  const names = listCommands().map((c) => c.name).sort();
  assert.deepEqual(names, [...SLASH_HANDLERS.keys()].sort(),
    'the dashboard autocomplete must not drift from what the dispatcher accepts');
  for (const c of listCommands()) assert.equal(typeof c.description, 'string');
});
