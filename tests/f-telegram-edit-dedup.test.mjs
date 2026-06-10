// tests/f-telegram-edit-dedup.test.mjs — a Telegram EDIT must not collide
// with the original message's dedup key. Telegram edits carry the SAME
// message_id as the original (only update_id is new), so keying dedup on
// message_id would replay the stale answer instead of processing the edit.
// The channel therefore keys on update_id (stable across getUpdates
// redeliveries, distinct per edit).

import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramChannel, normalizeUpdate } from '../channels/telegram.mjs';

test('normalizeUpdate: edited_message carries the original message_id + a new update_id', () => {
  const orig = normalizeUpdate({ update_id: 100, message: { message_id: 7, chat: { id: 5 }, from: { id: 9 }, text: 'hi' } });
  const edit = normalizeUpdate({ update_id: 101, edited_message: { message_id: 7, chat: { id: 5 }, from: { id: 9 }, text: 'hi (edited)' } });
  assert.equal(orig.messageId, edit.messageId, 'telegram reuses message_id for edits');
  assert.notEqual(orig.updateId, edit.updateId, 'update_id is fresh per edit');
});

test('the dedup id forwarded to the handler differs between a message and its edit', async () => {
  const ch = new TelegramChannel({ token: '123:test' });
  const seen = [];
  await ch.start(async (evt) => { seen.push(evt); return null; }, { poll: false }); // null => no send
  await ch._simulateInbound({ update_id: 100, message: { message_id: 7, chat: { id: 5 }, from: { id: 9 }, text: 'hi' } });
  await ch._simulateInbound({ update_id: 101, edited_message: { message_id: 7, chat: { id: 5 }, from: { id: 9 }, text: 'hi (edited)' } });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].messageId, '5:u100');
  assert.equal(seen[1].messageId, '5:u101');
  assert.notEqual(seen[0].messageId, seen[1].messageId, 'edit gets its own dedup id');
});

test('redelivery of the SAME update keeps the SAME dedup id (restart replay dedups)', async () => {
  const ch = new TelegramChannel({ token: '123:test' });
  const seen = [];
  await ch.start(async (evt) => { seen.push(evt); return null; }, { poll: false });
  const update = { update_id: 200, message: { message_id: 8, chat: { id: 5 }, from: { id: 9 }, text: 'once' } };
  await ch._simulateInbound(update);
  await ch._simulateInbound(update); // memory-only offset lost on restart -> same update again
  assert.equal(seen[0].messageId, seen[1].messageId, 'same update -> same key -> daemon dedups it');
});
