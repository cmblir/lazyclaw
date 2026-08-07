// tests/f-ctx-gauge.test.mjs — the status-bar context gauge tracks the
// conversation history pompos holds, not a provider's self-reported usage.
// CLI providers (codex/claude/gemini) report tens of thousands of input tokens
// per call (their own system prompt + tool defs), which used to be shown over
// the 8000-token history budget — `ctx 49467/8000` on a one-line chat.

import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateMessagesTokens } from '../chat_window.mjs';

test('estimateMessagesTokens: empty / cleared conversation is ~0', () => {
  assert.equal(estimateMessagesTokens([]), 0);
  assert.equal(estimateMessagesTokens(null), 0);
});

test('estimateMessagesTokens: ~4 chars per token over message content', () => {
  // 40 chars total → 10 tokens.
  const msgs = [{ role: 'user', content: 'a'.repeat(20) }, { role: 'assistant', content: 'b'.repeat(20) }];
  assert.equal(estimateMessagesTokens(msgs), 10);
});

test('estimateMessagesTokens: a short turn stays far below the 8000 budget', () => {
  // The bug case: one short Q+A must read as a tiny gauge, not ~49k.
  const msgs = [
    { role: 'user', content: '지금 내 한도가 어느정도야?' },
    { role: 'assistant', content: '현재 이 대화에는 설정된 작업 한도나 토큰 예산이 없습니다.' },
  ];
  assert.ok(estimateMessagesTokens(msgs) < 200, 'short turn ≪ 8000 budget');
});

test('estimateMessagesTokens: ignores missing/non-string content safely', () => {
  assert.equal(estimateMessagesTokens([{ role: 'user' }, null, { content: 1234 }]), 1);
});
