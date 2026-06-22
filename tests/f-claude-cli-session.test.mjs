import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { getSession, _resetSessions } from '../providers/claude_cli_session.mjs';

// A fake `claude --input-format stream-json` child: each user line written to
// stdin produces a stream_event text delta + a result event on stdout.
function fakeClaude(state) {
  const child = new EventEmitter();
  child.killed = false;
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  child.stdin = {
    write: (line) => {
      const msg = JSON.parse(line);
      const text = 'echo:' + msg.message.content;
      setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }) + '\n');
        child.stdout.emit('data', JSON.stringify({ type: 'result', result: text, usage: { input_tokens: 3, output_tokens: 5 }, total_cost_usd: 0 }) + '\n');
      });
      return true;
    },
    end: () => {},
  };
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')); };
  if (state) state.child = child;
  return child;
}

// A fake that emits an arbitrary list of stream-json frames per stdin write.
function fakeEmitting(frames) {
  const child = new EventEmitter();
  child.killed = false;
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  child.stdin = {
    write: () => { setImmediate(() => { for (const f of frames) child.stdout.emit('data', JSON.stringify(f) + '\n'); }); return true; },
    end: () => {},
  };
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')); };
  return child;
}

test('session: onUsage accumulates cache tokens from the assistant event', async () => {
  _resetSessions();
  const usage = [];
  const frames = [
    { type: 'assistant', message: { usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } },
    { type: 'result', result: 'ok', total_cost_usd: 0.01, usage: { input_tokens: 0 } },
  ];
  const s = getSession('cache', { _spawn: () => fakeEmitting(frames) });
  for await (const _ of s.send('hi', { onUsage: (u) => usage.push(u) })) { /* drain */ }
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 2);
  assert.equal(usage[0].cacheReadInputTokens, 100);
  assert.equal(usage[0].cacheCreationInputTokens, 50);
  assert.equal(usage[0].totalCostUsd, 0.01);
  s.close();
});

test('session: a --max-turns cut (error_max_turns) fires onTruncated', async () => {
  _resetSessions();
  const trunc = [];
  const frames = [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } },
    { type: 'result', subtype: 'error_max_turns', is_error: true, result: 'partial', usage: { input_tokens: 1 } },
  ];
  const s = getSession('trunc', { _spawn: () => fakeEmitting(frames) });
  for await (const _ of s.send('hi', { onTruncated: (r) => trunc.push(r) })) { /* drain */ }
  assert.deepEqual(trunc, ['max_turns']);
  s.close();
});

test('persistent session: ONE warm child reused across turns (boot amortized)', async () => {
  _resetSessions();
  let spawnCount = 0;
  const _spawn = () => { spawnCount++; return fakeClaude(); };
  const s = getSession('s1', { _spawn });
  let out1 = ''; for await (const c of s.send('hello')) out1 += c;
  let out2 = ''; for await (const c of s.send('again')) out2 += c;
  assert.equal(out1, 'echo:hello');
  assert.equal(out2, 'echo:again');
  assert.equal(spawnCount, 1, 'the same child handles both turns (no re-spawn)');
  s.close();
});

test('getSession returns the same live session for a key, a fresh one after close', async () => {
  _resetSessions();
  let spawnCount = 0;
  const _spawn = () => { spawnCount++; return fakeClaude(); };
  const a = getSession('k', { _spawn });
  const b = getSession('k', { _spawn });
  assert.equal(a, b);
  assert.equal(spawnCount, 1);
  a.close();
  const c = getSession('k', { _spawn });
  assert.notEqual(c, a, 'a closed session is replaced by a fresh spawn');
  assert.equal(spawnCount, 2);
  c.close();
});

test('send surfaces usage from the result event', async () => {
  _resetSessions();
  const s = getSession('u', { _spawn: () => fakeClaude() });
  let usage = null;
  // eslint-disable-next-line no-unused-vars
  for await (const _ of s.send('hi', { onUsage: (u) => { usage = u; } })) { /* drain */ }
  assert.equal(usage.inputTokens, 3);
  assert.equal(usage.outputTokens, 5);
  s.close();
});

test('a crashed child is evicted so the next getSession respawns', async () => {
  _resetSessions();
  const state = {};
  let spawnCount = 0;
  const _spawn = () => { spawnCount++; return fakeClaude(state); };
  const s = getSession('crash', { _spawn });
  state.child.emit('exit', 1, null); // simulate crash
  const s2 = getSession('crash', { _spawn });
  assert.notEqual(s2, s, 'crashed session evicted; fresh spawn');
  assert.equal(spawnCount, 2);
  s2.close();
});

test('getSession respawns when the system prompt changes (no stale warm session)', async () => {
  _resetSessions();
  let n = 0;
  const _spawn = () => { n++; return fakeClaude(); };
  const a = getSession('k', { _spawn, system: 'A' });
  const b = getSession('k', { _spawn, system: 'A' });
  assert.equal(a, b, 'same system reuses the warm session');
  assert.equal(n, 1);
  const c = getSession('k', { _spawn, system: 'B' });   // e.g. plan-mode toggled the system
  assert.notEqual(c, a, 'a changed system evicts the stale session and respawns');
  assert.equal(n, 2);
  c.close();
});
