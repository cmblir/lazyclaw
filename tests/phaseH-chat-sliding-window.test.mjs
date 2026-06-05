// Group B / M6 — chat sliding window.
//
// A multi-day chat session accumulates hundreds of turns; without a
// cap the prompt grows linearly and the cache breakpoint advances
// past the useful prefix. The window trims the in-memory messages
// array (the on-disk JSONL log is untouched) so the wire request is
// bounded.
//
// _applyChatWindow is the pure helper that both the chat REPL and
// these tests exercise. It honours:
//   - turns cap   — keep at most N non-system turns
//   - tokens cap  — drop oldest non-system turns until estimated
//                   tokens ≤ budget (4 chars/token approx)
//   - system message at index 0 is always preserved

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChatWindow as _applyChatWindow, CHAT_WINDOW_TURNS, CHAT_WINDOW_TOKEN_BUDGET } from '../chat_window.mjs';

function fakeTurns(n, role = null) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: role || (i % 2 === 0 ? 'user' : 'assistant'),
      content: `turn-${i}`,
    });
  }
  return out;
}

test('M6 — 50-turn session loaded with default window keeps last 20 turns + system msg', () => {
  const messages = [{ role: 'system', content: 'STATIC_SYS' }, ...fakeTurns(50)];
  const { messages: out, dropped } = _applyChatWindow(messages, { turns: 20, tokens: 1_000_000 });
  // System msg + 20 turns = 21 total
  assert.equal(out.length, 21,
    `expected 21 messages (system + 20 turns), got ${out.length}`);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'STATIC_SYS');
  assert.equal(dropped, 30,
    `expected 30 turns dropped (50 - 20), got ${dropped}`);
  // The kept turns should be the LAST 20, not the first.
  assert.equal(out[1].content, 'turn-30',
    `expected oldest kept turn to be turn-30, got ${out[1].content}`);
  assert.equal(out[20].content, 'turn-49',
    `expected newest turn to be turn-49, got ${out[20].content}`);
});

test('M6 — env-override-style explicit turns=5 cap trims aggressively', () => {
  const messages = [{ role: 'system', content: 'SYS' }, ...fakeTurns(50)];
  const { messages: out, dropped } = _applyChatWindow(messages, { turns: 5, tokens: 1_000_000 });
  assert.equal(out.length, 6, 'expected 1 system + 5 turns = 6');
  assert.equal(dropped, 45);
});

test('M6 — token budget cap kicks in when turns × avg_len exceeds budget', () => {
  // 20 turns × 200 chars each = 4000 chars ≈ 1000 tokens. Budget of
  // 300 tokens forces aggressive trimming below the turn-count cap.
  const heavy = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(200),
  }));
  const messages = [{ role: 'system', content: 'SYS' }, ...heavy];
  const { messages: out, dropped } = _applyChatWindow(messages, { turns: 100, tokens: 300 });
  // Should drop more than zero turns even though we're under the
  // turn-count cap of 100, because the token budget bites first.
  assert.ok(dropped > 0,
    `token budget should have forced trimming, got dropped=${dropped}`);
  // System message must still be at index 0.
  assert.equal(out[0].role, 'system');
});

test('M6 — empty messages array is a no-op', () => {
  const { messages: out, dropped } = _applyChatWindow([], { turns: 20, tokens: 8000 });
  assert.deepEqual(out, []);
  assert.equal(dropped, 0);
});

test('M6 — messages with no system message at index 0 still trim by turn count', () => {
  const messages = fakeTurns(30);
  const { messages: out, dropped } = _applyChatWindow(messages, { turns: 10, tokens: 1_000_000 });
  assert.equal(out.length, 10);
  assert.equal(dropped, 20);
  // No system to preserve, so the result is just the last 10 turns.
  assert.equal(out[0].content, 'turn-20');
  assert.equal(out[9].content, 'turn-29');
});

test('M6 — under-cap messages pass through unchanged', () => {
  const messages = [{ role: 'system', content: 'S' }, ...fakeTurns(5)];
  const { messages: out, dropped } = _applyChatWindow(messages, { turns: 20, tokens: 1_000_000 });
  assert.equal(out.length, 6);
  assert.equal(dropped, 0);
  assert.deepEqual(out, messages, 'under-cap input must round-trip identically');
});
