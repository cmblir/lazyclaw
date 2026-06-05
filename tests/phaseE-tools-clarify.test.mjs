import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as clarify from '../mas/tools/clarify.mjs';

test('clarify tool shape', () => {
  assert.equal(clarify.TOOL.name, 'clarify');
  assert.equal(clarify.TOOL.category, 'agents');
  assert.equal(clarify.TOOL.sensitive, false);
});

test('clarify routes via injected asker', async () => {
  let asked;
  clarify.__setAsker(async (q) => { asked = q; return 'because.'; });
  const r = await clarify.TOOL.exec({ question: 'why?' });
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'because.');
  assert.equal(asked.question, 'why?');
  clarify.__setAsker(null);
});

test('clarify fails when no asker bound and not a TTY', async () => {
  clarify.__setAsker(null);
  const r = await clarify.TOOL.exec({ question: 'why?' }, { isTTY: false });
  assert.equal(r.ok, false);
});
