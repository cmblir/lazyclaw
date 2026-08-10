// tests/f-slash-sse.test.mjs — long commands must show progress as it happens.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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
  // Fixture: /clear used to double as both "destructive" and "streaming",
  // but needsLiveSession (daemon/lib/slash_http.mjs) now refuses it with
  // NO_SESSION before destructivePrompt ever runs, so it can no longer prove
  // this. The fixture must be a genuine member of STREAMING (checked below)
  // AND trigger destructivePrompt (daemon/lib/slash_destructive.mjs) — of
  // STREAMING's two entries, only /task has a destructive subcommand
  // (abandon|remove|rm|delete); /loop has none. `/task abandon <id>` is a
  // command that would actually reach the SSE path in production and must
  // still be gated before it does.
  assert.ok(STREAMING.has('/task'), 'the fixture below must be a real streaming command, not an arbitrary one');
  let ran = false;
  const runner = makeSlashRunner({
    cfgDir: CFG, confirmStore: makeConfirmStore(),
    dispatch: async () => { ran = true; return 'x'; },
  });
  const out = await runner.runStreaming({ line: '/task abandon nosuchtask', onLine: () => {} });
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

// --- real dispatcher, not a fake — fix round 1 ------------------------------
//
// Every test above injects `dispatch`, so none of them ever reach the real
// tui/slash_dispatcher.mjs handlers. That let /loop ship with no working
// trigger: buildHttpCtx (daemon/lib/slash_ctx.mjs) never set ctx.getProv, and
// _loop calls it unguarded — `runStreaming({ line: '/loop say hi' })` crashed
// with "ctx.getProv is not a function" before emitting a single line. These
// tests run the REAL dispatcher against the REAL ctx, with a non-empty prompt
// (empty args only exercises /loop's usage branch, which never reaches
// ctx.getProv() at all — see the strengthened gate-coverage test in
// tests/f-slash-http.test.mjs for the general form of this gap), so a
// regression here means the streaming feature is inert again, not just that
// a mock dispatch shuffles lines correctly.
test('/loop runs through the REAL dispatcher and streams the real (mock) provider output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-sse-real-loop-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: 'mock', model: 'mock-model' }));
    // No `dispatch` override — makeSlashRunner defaults to the real
    // tui/slash_dispatcher.mjs.
    const runner = makeSlashRunner({ cfgDir: dir, confirmStore: makeConfirmStore() });
    const seen = [];
    const times = [];
    const out = await runner.runStreaming({
      line: '/loop say hi --max 1',
      onLine: (l) => { seen.push(l); times.push(Date.now()); },
    });
    assert.equal(out.ok, true, `real /loop must succeed, got: ${JSON.stringify(out)}`);
    assert.match(out.lines.join(''), /✓ loop done — 1\/1 iteration/);
    // providers/registry.mjs's mock provider streams one character at a time
    // (5ms apart) — a real run produces many onLine calls, not one buffered
    // blob, and the reply text must actually be there.
    assert.ok(seen.length > 5, `expected many onLine calls from a real char-by-char stream, got ${seen.length}`);
    assert.match(seen.join(''), /mock-reply: say hi/, 'the real mock provider ran and its reply reached onLine');
    // Genuine streaming, not a buffered-then-replayed burst: the mock
    // provider sleeps between characters, so the calls must be measurably
    // spread out in wall-clock time, not all fired within the same tick.
    assert.ok(times[times.length - 1] - times[0] >= 15, 'onLine calls should be spread over real time, not fired all at once');
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// /task tick has the same shape as /loop (takes write(), runs a real
// multi-agent turn via mas/mention_router.mjs's runTaskTurn) and was added to
// STREAMING alongside it — same real-dispatcher proof. Unlike /loop, the mock
// provider can't stand in for the agent here: mas/agent_turn.mjs requires a
// real tool-use adapter (mas/provider_adapters.mjs), and 'mock' has none — a
// real run throws "provider \"mock\" does not support tool-use yet" before
// ctx.resolveAuthKey/resolveBaseUrl are ever exercised. Proving those two are
// wired (not just present-but-unguarded) needs a provider whose adapter
// actually sends the key/URL somewhere observable: 'openai' does, and
// _resolveBaseUrl (lib/config.mjs) honours POMPOS_OPENAI_BASE_URL, so
// pointing that at a local HTTP server gets a fully offline, deterministic
// run that still exercises the real wire path.
function startFakeOpenAI(reply) {
  return new Promise((resolve) => {
    const captured = { authorization: null, calls: 0 };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        captured.authorization = req.headers.authorization || null;
        captured.calls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 3 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, captured, port: server.address().port }));
  });
}

test('/task tick runs a real multi-agent turn through the REAL dispatcher and streams its log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-slash-sse-real-task-'));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  const prevBaseUrl = process.env.POMPOS_OPENAI_BASE_URL;
  const { server, captured, port } = await startFakeOpenAI('all done here');
  process.env.POMPOS_CONFIG_DIR = dir;
  process.env.POMPOS_OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    // The persisted key below is what ctx.resolveAuthKey must actually
    // deliver to the adapter's Authorization header — asserted at the
    // bottom, not just assumed.
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      provider: 'mock', model: 'mock-model', 'api-key': 'sk-test-real-key-123',
    }));
    const agentsMod = await import('../agents.mjs');
    const teamsMod = await import('../teams.mjs');
    const tasksMod = await import('../tasks.mjs');
    // memoryWrite/skillWrite 'off' — this test is about the router turn
    // actually running end to end, not about the (also-real) post-task
    // reflection/skill-synthesis hooks, which would need extra fake replies.
    agentsMod.registerAgent({ name: 'alice', provider: 'openai', memoryWrite: 'off', skillWrite: 'off' }, dir);
    teamsMod.registerTeam({ name: 'solo', agents: ['alice'], lead: 'alice' }, dir);
    const task = tasksMod.registerTask({ title: 'ship it', team: 'solo', lead: 'alice', status: 'pending' }, dir);

    const runner = makeSlashRunner({ cfgDir: dir, confirmStore: makeConfirmStore() });
    const seen = [];
    const times = [];
    const t0 = Date.now();
    const out = await runner.runStreaming({
      line: `/task tick ${task.id} go`,
      onLine: (l) => { seen.push(l); times.push(Date.now() - t0); },
    });
    assert.equal(out.ok, true, `real /task tick must succeed, got: ${JSON.stringify(out)}`);
    assert.match(out.lines.join(''), /→ paused \(1 agent turn/, 'the real router ran exactly one agent turn against the fake server, then idled with nothing further queued');
    // `seen.length > 0` alone proves nothing here: finalizeEnvelope always
    // emits the trailing return string through the same onLine path, so a
    // single-element `seen` is exactly what a fully-buffered /task tick
    // (intermediate write silently dropped) would also produce — the
    // regression this test exists to catch. The handler writes
    // "  ↻ running task turn…\n" (tui/slash_dispatcher.mjs:1203) BEFORE
    // awaiting router.runTaskTurn, and the trailing "✓ task … → paused …"
    // line only exists AFTER that await resolves (a real network round trip
    // to the fake server below plus real disk writes), so removing the
    // intermediate write would collapse `seen` to length 1 AND erase the gap
    // between the two timestamps — both checked below, not just presence.
    assert.equal(seen.length, 2, 'expected the intermediate "running task turn" write AND the trailing status line as two distinct onLine events, not one');
    assert.match(seen[0], /running task turn/, 'the first onLine event must be the write that fires BEFORE dispatching to the router, not the trailing result');
    assert.match(seen[1], /→ paused \(1 agent turn/, 'the second onLine event is the trailing return value, arriving separately from the first');
    // Real progressive delivery, not a buffered-then-replayed burst: the
    // router await does real async work (network + disk) between the two
    // writes, so their timestamps must be measurably apart. Empirically
    // ~17-19ms across repeated local runs; 5ms is a generous floor for a
    // slower CI machine while still being far above "fired in the same
    // tick" (~0ms), which is what a collapsed-to-one-write regression would
    // look like.
    assert.ok(times[1] - times[0] >= 5, `onLine calls should be measurably spread over real time, not fired all at once (got ${times[1] - times[0]}ms apart)`);
    assert.equal(captured.calls, 1, 'the fake OpenAI-compatible server must have actually been called once — proves runAgentTurn really reached the network layer');
    assert.equal(captured.authorization, 'Bearer sk-test-real-key-123', 'ctx.resolveAuthKey must deliver the REAL persisted config.json key, not a stub or null');
  } finally {
    process.env.POMPOS_CONFIG_DIR = prevEnv;
    if (prevBaseUrl === undefined) delete process.env.POMPOS_OPENAI_BASE_URL;
    else process.env.POMPOS_OPENAI_BASE_URL = prevBaseUrl;
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
