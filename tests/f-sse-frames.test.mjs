// tests/f-sse-frames.test.mjs — the SSE frame parser sits between the daemon
// and every live panel. A chunk boundary in the wrong place used to mean a
// silently dropped event, so pin the splitting rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParser } from '../web/ui/stream.mjs';

test('parses one complete frame', () => {
  const seen = [];
  const feed = makeParser((t, d) => seen.push([t, d]));
  feed('event: delegate\ndata: {"from":"lead","to":"scout"}\n\n');
  assert.deepEqual(seen, [['delegate', { from: 'lead', to: 'scout' }]]);
});

test('a frame split across chunks still parses once', () => {
  const seen = [];
  const feed = makeParser((t, d) => seen.push([t, d]));
  feed('event: tool.call\nda');
  assert.equal(seen.length, 0, 'nothing emitted until the blank line arrives');
  feed('ta: {"tool":"read_file"}\n\n');
  assert.deepEqual(seen, [['tool.call', { tool: 'read_file' }]]);
});

test('several frames in one chunk all parse, in order', () => {
  const seen = [];
  const feed = makeParser((t, d) => seen.push(t));
  feed('event: a\ndata: {}\n\nevent: b\ndata: {}\n\nevent: c\ndata: {}\n\n');
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('a comment heartbeat is ignored', () => {
  const seen = [];
  const feed = makeParser((t) => seen.push(t));
  feed(': heartbeat\n\n');
  assert.deepEqual(seen, []);
});

test('a malformed data payload is skipped without throwing', () => {
  const seen = [];
  const feed = makeParser((t) => seen.push(t));
  assert.doesNotThrow(() => feed('event: bad\ndata: {not json\n\nevent: good\ndata: {}\n\n'));
  assert.deepEqual(seen, ['good'], 'a bad frame must not stop the stream');
});

test('a frame with no event: line defaults to message', () => {
  const seen = [];
  const feed = makeParser((t) => seen.push(t));
  feed('data: {"x":1}\n\n');
  assert.deepEqual(seen, ['message']);
});
