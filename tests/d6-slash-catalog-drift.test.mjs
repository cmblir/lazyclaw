// D6 drift-guard: the REPL slash catalog (tui/slash_commands.mjs, the
// descriptive source consumed by /help and the popup) must stay in sync
// with the runtime handler registry (SLASH_HANDLERS in
// tui/slash_dispatcher.mjs). Either side drifting — a command documented
// with no handler, or a handler with no /help entry — fails here.
//
// This is the single guard that replaced the third, hand-maintained
// SLASH_COMMANDS copy that used to live in cli.mjs (deleted in D6).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';
import { SLASH_HANDLERS } from '../tui/slash_dispatcher.mjs';

const catalogCmds = SLASH_COMMANDS.map((c) => c.cmd);
const handlerCmds = [...SLASH_HANDLERS.keys()];

test('catalog has no duplicate commands', () => {
  const seen = new Set();
  for (const cmd of catalogCmds) {
    assert.ok(!seen.has(cmd), `duplicate slash command in catalog: ${cmd}`);
    seen.add(cmd);
  }
});

test('every catalog command has a runtime handler', () => {
  const handlers = new Set(handlerCmds);
  const undocumented = catalogCmds.filter((cmd) => !handlers.has(cmd));
  assert.deepEqual(undocumented, [], `catalog commands missing a handler: ${undocumented.join(', ')}`);
});

test('every runtime handler is documented in the catalog', () => {
  const documented = new Set(catalogCmds);
  const missing = handlerCmds.filter((cmd) => !documented.has(cmd));
  assert.deepEqual(missing, [], `handlers missing a /help entry: ${missing.join(', ')}`);
});

test('catalog entries are well-formed { cmd, help }', () => {
  for (const c of SLASH_COMMANDS) {
    assert.equal(typeof c.cmd, 'string');
    assert.ok(c.cmd.startsWith('/'), `command must start with /: ${c.cmd}`);
    assert.equal(typeof c.help, 'string');
    assert.ok(c.help.length > 0, `command needs help text: ${c.cmd}`);
  }
});
