// tests/p3-menu.test.mjs — the no-arg launcher menu (browse + run any
// subcommand) was hidden once the no-arg default became chat; it's only
// reachable via `pompos menu`. /menu brings the discoverable subcommand
// catalog back into the chat as a command palette.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSlash, SLASH_HANDLERS } from '../tui/slash_dispatcher.mjs';

test('/menu is a registered slash command', () => {
  assert.ok(SLASH_HANDLERS.has('/menu'));
});

test('/menu with a picker lists subcommands and echoes the run command', async () => {
  let seen = null;
  const ctx = { openPicker: async (opts) => { seen = opts; return 'doctor'; } };
  const out = await dispatchSlash('/menu', '', ctx);
  assert.equal(seen.kind, 'menu');
  const ids = seen.items.map((i) => i.id);
  assert.ok(ids.includes('dashboard') && ids.includes('doctor') && ids.includes('sessions'));
  assert.match(out, /pompos doctor/);
});

test('/menu without a picker lists the grouped catalog', async () => {
  const out = await dispatchSlash('/menu', '', {});
  assert.match(out, /doctor/);
  assert.match(out, /dashboard/);
  assert.match(out, /pompos <subcommand>/);
});

test('/menu cancel returns cancelled', async () => {
  const ctx = { openPicker: async () => null };
  const out = await dispatchSlash('/menu', '', ctx);
  assert.match(out, /cancelled/);
});
