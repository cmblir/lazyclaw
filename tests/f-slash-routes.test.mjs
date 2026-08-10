// tests/f-slash-routes.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
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
// The brief's original stub only implemented async-iteration, but the real
// daemon/lib/respond.mjs#readJson consumes the body via the classic
// EventEmitter stream API (req.setEncoding + 'data'/'end'/'error'), which a
// bare async-iterable object doesn't provide. Building on a real
// node:stream Readable gives us both for free, so readJson works unmodified
// against this stub — extending the stub, not the route, per the brief.
function mkReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  return req;
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

test('POST /slash threads c.workflowStateDir through to /workflow (fix round 1 — daemon-level wiring)', async () => {
  // c.workflowStateDir is the SAME resolver daemon/routes/workflows.mjs's
  // REST handlers call (daemon.mjs). Pre-seed a state file in a directory
  // ONLY reachable via that resolver, then prove /workflow clear consulted
  // it — not POMPOS_WORKFLOW_STATE_DIR or the CWD-relative default.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-route-wfdir-'));
  fs.writeFileSync(path.join(dir, 'ghost.json'), JSON.stringify({ sessionId: 'ghost', order: [], nodes: {} }));
  const line = '/workflow clear ghost';

  const first = mkRes();
  await slashRun({ req: mkReq({ line }), res: first, gwConfigDir: CFG, workflowStateDir: () => dir });
  assert.equal(first.statusCode, 409, '/workflow clear is destructive, so it asks first');

  const second = mkRes();
  await slashRun({
    req: mkReq({ line, confirm: first.body.token }),
    res: second, gwConfigDir: CFG, workflowStateDir: () => dir,
  });
  assert.equal(second.statusCode, 200);
  assert.match(second.body.lines[0], /cleared/);
  assert.equal(fs.existsSync(path.join(dir, 'ghost.json')), false, 'the c.workflowStateDir-supplied directory is what got consulted');
  fs.rmSync(dir, { recursive: true, force: true });
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

// ── /dashboard must never spawn a process or open a browser ON THE DAEMON
// HOST just because someone POSTed a slash command to it — see task-4-brief
// and the Task 3 report ("flagged for the daemon-route task"). Covered here,
// not only via NODE_TEST_CONTEXT (tui/slash_dashboard.mjs's own guard),
// because that guard is a test-runner accident, not a fix for production
// HTTP traffic; this route must refuse it on its own regardless of env.
test('POST /slash refuses /dashboard instead of spawning a process on the daemon host', async () => {
  const res = mkRes();
  await slashRun({ req: mkReq({ line: '/dashboard' }), res, gwConfigDir: CFG });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NEEDS_TERMINAL');
  assert.ok(res.body.hint, 'should explain where /dashboard does work');
});

test('POST /slash refuses /dashboard stop the same way (it would pkill host processes)', async () => {
  const res = mkRes();
  await slashRun({ req: mkReq({ line: '/dashboard stop' }), res, gwConfigDir: CFG });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'NEEDS_TERMINAL');
});

// ── fix round 1: /gateway start|stop is the sibling the first pass of this
// guard missed — same class as /dashboard (spawns/kills a process on the
// daemon's own host), caught by review rather than by this test suite. The
// no-spawn/no-kill proof itself lives in tests/f-slash-http.test.mjs (it
// injects a spy dispatch to assert dispatch is never called); these confirm
// the same refusal surfaces correctly through the real route.
test('POST /slash refuses /gateway start the same way as /dashboard', async () => {
  const res = mkRes();
  await slashRun({ req: mkReq({ line: '/gateway start' }), res, gwConfigDir: CFG });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NEEDS_TERMINAL');
});

test('POST /slash refuses /gateway stop the same way — it would process.kill a real pid', async () => {
  const res = mkRes();
  await slashRun({ req: mkReq({ line: '/gateway stop' }), res, gwConfigDir: CFG });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'NEEDS_TERMINAL');
});

test('POST /slash still allows /gateway status — read-only, no process touched', async () => {
  const res = mkRes();
  await slashRun({ req: mkReq({ line: '/gateway status' }), res, gwConfigDir: CFG });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});
