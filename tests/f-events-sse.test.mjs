import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { events } from '../daemon/routes/events.mjs';
import { emit, _reset } from '../mas/events.mjs';

function fakeReqRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.chunks = [];
  res.writeHead = (code, h) => { res.code = code; res.headers = h; };
  res.write = (s) => { res.chunks.push(s); return true; };
  res.end = () => { res.writableEnded = true; res.emit('close'); };
  const req = new EventEmitter();
  return { req, res };
}

test('GET /events replays the ring buffer then streams live events as SSE', () => {
  _reset();
  emit('turn.start', { agent: 'planner' }); // buffered before connect
  const { req, res } = fakeReqRes();
  events({ req, res });
  const replay = res.chunks.join('');
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.ok(replay.includes('event: turn.start'), 'buffered event replayed on connect');
  assert.ok(replay.includes('"agent":"planner"'));
  // live event streams to the open connection
  emit('delegate', { from: 'planner', to: 'data' });
  const out = res.chunks.join('');
  assert.ok(out.includes('event: delegate'));
  assert.ok(out.includes('"to":"data"'));
});

test('GET /events unsubscribes on client disconnect (no write after close)', () => {
  _reset();
  const { req, res } = fakeReqRes();
  events({ req, res });
  const before = res.chunks.length;
  res.emit('close');
  emit('tool.call', { agent: 'x' });
  assert.equal(res.chunks.length, before, 'no SSE writes after the client disconnected');
});
