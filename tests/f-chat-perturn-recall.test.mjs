// tests/f-chat-perturn-recall.test.mjs
//
// Roadmap #7: the streaming chat path sent a fixed system prompt, so it never
// surfaced context relevant to the CURRENT message. _injectRecall prepends a
// fresh recall layer to the last user turn (transient — the stored session
// keeps the original), so a warm claude-cli persistent session and every other
// provider both get per-turn recall.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _injectRecall } from '../tui/run_turn.mjs';
import { recalledLayer } from '../mas/prompt_stack.mjs';
import { openIndex, indexSessionTurn, closeIndex } from '../mas/index_db.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-ptr-'));

test('prepends the recall layer to the last user message as a transient copy', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'find the bug' },
  ];
  const fakeRecall = (dir, q) => `## Relevant recalled context\n- [sessions] prior note (q=${q})`;
  const out = _injectRecall(messages, '/cfg', fakeRecall);
  assert.match(out[3].content, /Relevant recalled context/);
  assert.match(out[3].content, /find the bug$/, 'original question preserved AFTER the layer');
  assert.equal(messages[3].content, 'find the bug', 'original messages must not be mutated');
  assert.equal(out[0].content, 'sys');
});

test('returns messages unchanged when there is no user message, an empty layer, or no fn', () => {
  const sysOnly = [{ role: 'system', content: 's' }];
  assert.equal(_injectRecall(sysOnly, '/c', () => 'x'), sysOnly);
  const u = [{ role: 'user', content: 'hi' }];
  assert.equal(_injectRecall(u, '/c', () => ''), u, 'empty recall → unchanged');
  assert.equal(_injectRecall(u, '/c', null), u, 'no recall fn → unchanged');
});

test('end-to-end: a seeded prior turn surfaces in the next message via real recall', () => {
  const dir = tmp();
  openIndex(dir);
  indexSessionTurn({ session_id: 's1', turn_idx: 0, role: 'user', ts: 1, content: 'the deploy script lives in scripts/deploy.sh' }, dir);
  const messages = [{ role: 'user', content: 'where is the deploy script?' }];
  const out = _injectRecall(messages, dir, recalledLayer);
  assert.match(out[0].content, /deploy\.sh/, 'recalled prior context surfaces in the sent message');
  assert.match(out[0].content, /where is the deploy script/, 'original question preserved');
  closeIndex(dir);
});
