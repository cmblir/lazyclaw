// f-ink-approve — the Ink agentic path needs an approval channel so sensitive
// tools (bash/write) can be confirmed in chat instead of being denied by the
// fail-closed gate. _makeInkApprove is now exported from slash_dispatcher and
// wired onto the Ink chat ctx (commands/chat.mjs). Pins both.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { _makeInkApprove } from '../tui/slash_dispatcher.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

test('_makeInkApprove is exported and returns the operator verdict', async () => {
  // Approve path: openPicker resolves to the approve row.
  const approveCtx = { openPicker: async () => ({ id: 'approve' }) };
  const approve = _makeInkApprove(approveCtx);
  const yes = await approve({ tool: 'bash', args: { command: 'ls' }, agent: 'chat' });
  assert.equal(yes.approved, true);

  // Deny path: anything other than approve denies (fail-closed).
  const denyCtx = { openPicker: async () => ({ id: 'deny' }) };
  const no = await _makeInkApprove(denyCtx)({ tool: 'bash', args: {}, agent: 'chat' });
  assert.equal(no.approved, false);

  // Cancel (null) denies too.
  const cancelCtx = { openPicker: async () => null };
  const cancelled = await _makeInkApprove(cancelCtx)({ tool: 'write', args: {}, agent: 'chat' });
  assert.equal(cancelled.approved, false);
});

test('commands/chat.mjs wires the Ink approval hook onto the chat ctx', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'commands', 'chat.mjs'), 'utf8');
  assert.match(src, /_makeInkApprove/, 'chat.mjs must import _makeInkApprove');
  assert.match(src, /_inkCtx\.approve\s*=\s*_makeInkApprove\(_inkCtx\)/,
    'chat.mjs must set _inkCtx.approve = _makeInkApprove(_inkCtx)');
});
