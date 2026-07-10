// tests/f-phase1-typed-streaming.test.mjs
//
// Phase 1 wave-B "typed-streaming": the daemon /agent SSE stream and the TUI
// stream historically emitted only bare {text} token frames, so a client
// couldn't distinguish tool calls / thinking / usage from plain assistant
// text. The streaming providers ALREADY expose onToolUse/onThinking/onUsage
// callbacks; this suite pins that:
//   (a) a mock streaming turn that calls a tool emits a NEW typed `tool_use`
//       SSE frame IN ADDITION to the existing `token` frames;
//   (b) a client reducer that only understands `token` frames still works
//       (backward-compat — the token/usage/done frames are byte-unchanged);
//   (c) thinking + usage typed frames are emitted when the provider surfaces
//       them;
//   (d) the TUI run_turn renders tool_use / thinking events distinctly while
//       still streaming plain text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PROVIDERS } from '../providers/registry.mjs';
import { agent } from '../daemon/routes/conversation.mjs';
import { makeRunTurn } from '../tui/run_turn.mjs';

// A mock streaming provider that fires the tool_use / thinking / usage
// callbacks the real providers surface, then yields plain text tokens.
const TOOLSTREAM = 'mock_toolstream';
function installToolStreamProvider() {
  PROVIDERS[TOOLSTREAM] = {
    name: TOOLSTREAM,
    async *sendMessage(_messages, opts = {}) {
      if (typeof opts.onThinking === 'function') opts.onThinking('let me think');
      if (typeof opts.onToolUse === 'function') {
        opts.onToolUse({ id: 'tu_1', name: 'read_file', input: { path: '/etc/hosts' } });
      }
      yield 'Hello';
      yield ' world';
      if (typeof opts.onUsage === 'function') {
        opts.onUsage({ inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
      }
    },
  };
}
function uninstallToolStreamProvider() { delete PROVIDERS[TOOLSTREAM]; }

// Minimal fake req/res mirroring tests/f-events-sse.test.mjs. Captures the raw
// SSE bytes so we can parse frames the way a real client would.
function fakeReqRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.chunks = [];
  res.writeHead = (code, h) => { res.code = code; res.headers = h; };
  res.write = (s) => { res.chunks.push(s); return true; };
  res.end = () => { res.writableEnded = true; res.emit('close'); return res; };
  const req = new EventEmitter();
  req.setEncoding = () => {};
  return { req, res };
}

// Build the per-request dispatch context the agent handler destructures.
function fakeCtx(body) {
  const { req, res } = fakeReqRes();
  return {
    ctx: {
      readConfig: () => ({ provider: TOOLSTREAM, model: 'x' }),
      sessionsDirGetter: () => '/tmp/lazyclaw-typed-streaming-test',
      // No sessionId in body → sessionsMod is never touched.
      sessionsMod: { loadTurns: () => [], appendTurn: () => {} },
    },
    logger: null,
    metrics: { costsByCurrency: {}, tokensTotal: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    costCap: null,
    cachedByName: null,
    req,
    res,
    // readJson reads the request body off `req`; simpler to stub it by
    // pre-parsing via the body we push through the stream below.
  };
}

// Parse the collected SSE bytes into a list of { event, data } frames the way a
// browser EventSource / a hand-rolled client would.
function parseFrames(chunks) {
  const raw = chunks.join('');
  const frames = [];
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    let data = null;
    try { data = JSON.parse(dataLines.join('\n')); } catch { /* leave null */ }
    frames.push({ event, data });
  }
  return frames;
}

// Drive the agent handler with a JSON body delivered over the fake req stream.
async function driveAgent(body) {
  const c = fakeCtx(body);
  // readJson(req) consumes req as a stream; emit the body then end.
  const done = agent(c);
  c.req.emit('data', Buffer.from(JSON.stringify(body)));
  c.req.emit('end');
  await done;
  return parseFrames(c.res.chunks);
}

test('(a) a streaming turn that calls a tool emits a typed tool_use frame in addition to text frames', async () => {
  installToolStreamProvider();
  try {
    const frames = await driveAgent({ provider: TOOLSTREAM, prompt: 'hi', stream: true });
    const tokenFrames = frames.filter((f) => f.event === 'token');
    assert.ok(tokenFrames.length >= 1, 'plain text token frames still emitted');
    assert.equal(tokenFrames.map((f) => f.data.text).join(''), 'Hello world');
    const toolFrames = frames.filter((f) => f.event === 'tool_use');
    assert.equal(toolFrames.length, 1, 'exactly one typed tool_use frame');
    assert.equal(toolFrames[0].data.type, 'tool_use');
    assert.equal(toolFrames[0].data.name, 'read_file');
    assert.deepEqual(toolFrames[0].data.input, { path: '/etc/hosts' });
    // The done frame still terminates the stream.
    assert.ok(frames.some((f) => f.event === 'done'), 'done frame still emitted');
  } finally {
    uninstallToolStreamProvider();
  }
});

test('(b) a client that only understands token frames still reconstructs the reply (backward-compat)', async () => {
  installToolStreamProvider();
  try {
    const frames = await driveAgent({ provider: TOOLSTREAM, prompt: 'hi', stream: true });
    // A legacy reducer that only knows the `token` event ignores every other
    // frame type and must still get the full assistant text.
    let reply = '';
    for (const f of frames) {
      if (f.event === 'token' && f.data && typeof f.data.text === 'string') reply += f.data.text;
    }
    assert.equal(reply, 'Hello world', 'legacy token-only client is unaffected by the new frames');
  } finally {
    uninstallToolStreamProvider();
  }
});

test('(c) thinking + usage typed frames are emitted when the provider surfaces them', async () => {
  installToolStreamProvider();
  try {
    // body.usage:true opts into the usage frame (existing contract).
    const frames = await driveAgent({ provider: TOOLSTREAM, prompt: 'hi', stream: true, usage: true });
    const thinking = frames.filter((f) => f.event === 'thinking');
    assert.equal(thinking.length, 1, 'one typed thinking frame');
    assert.equal(thinking[0].data.type, 'thinking');
    assert.equal(thinking[0].data.text, 'let me think');
    const usage = frames.filter((f) => f.event === 'usage');
    assert.equal(usage.length, 1, 'usage frame still emitted when body.usage set');
    assert.equal(usage[0].data.inputTokens, 3);
  } finally {
    uninstallToolStreamProvider();
  }
});

test('(c2) usage frame is NOT emitted when body.usage is unset (byte-stable default)', async () => {
  installToolStreamProvider();
  try {
    const frames = await driveAgent({ provider: TOOLSTREAM, prompt: 'hi', stream: true });
    assert.equal(frames.filter((f) => f.event === 'usage').length, 0, 'usage frame stays opt-in');
  } finally {
    uninstallToolStreamProvider();
  }
});

test('(d) TUI run_turn renders tool_use + thinking events distinctly while still streaming text', async () => {
  const out = [];
  const messages = [];
  const prov = {
    name: TOOLSTREAM,
    async *sendMessage(_messages, opts = {}) {
      if (typeof opts.onThinking === 'function') opts.onThinking('pondering');
      if (typeof opts.onToolUse === 'function') opts.onToolUse({ id: 't1', name: 'grep', input: {} });
      yield 'answer';
    },
  };
  const runTurn = makeRunTurn({
    ctx: {
      cfg: { chat: { recall: false } },
      cfgDir: '/tmp/lazyclaw-typed-streaming-test',
      sandboxSpec: null,
      syntheticChatSessionId: 'sess1',
      getMessages: () => messages,
      getProv: () => prov,
      getActiveProvName: () => TOOLSTREAM,
      getActiveModel: () => 'x',
      getSessionId: () => null,
      persistTurn: () => {},
      accumulateUsage: () => {},
      resolveAuthKey: () => '',
    },
    writeFn: (s) => out.push(s),
  });
  await runTurn('hi');
  const text = out.join('');
  assert.match(text, /answer/, 'plain assistant text still streamed');
  assert.match(text, /tool:\s*grep/i, 'a compact tool line rendered for the tool_use event');
  assert.match(text, /thinking/i, 'a thinking indicator rendered for the thinking event');
});
