// tests/p4-arg-complete-e2e.test.mjs — end-to-end: typing a value after a
// command, pressing Tab to autocomplete (host returns the value), then Enter
// submits the FULL completed line.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { ReplApp } from '../tui/repl.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';

function mkStdio() {
  const stdout = new PassThrough(); stdout.columns = 80; stdout.rows = 24;
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
  stdin.ref = () => {}; stdin.unref = () => {};
  return { stdin, stdout, stderr: new PassThrough() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Tab after /model fills the value the host returns, then Enter submits it', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let submitted = null;
  const inst = render(React.createElement(ReplApp, {
    splashProps: { provider: 'mock', model: 'm', version: '6.x', cwd: '/tmp', tools: [], skills: [] },
    slashCommands: SLASH_COMMANDS,
    onSlashCommand: async (line) => { submitted = line; return 'ok'; },
    onArgComplete: async (buf) => (buf.startsWith('/model') ? 'gpt-4.1' : null),
    runTurnFactory: () => async () => {},
  }), { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false });
  try {
    stdin.write('/model gpt');
    await sleep(60);
    stdin.write('\t');                 // arg-complete → buffer becomes "/model gpt-4.1"
    await sleep(100);
    stdin.write('\r');                 // submit
    for (let i = 0; i < 30 && submitted === null; i++) await sleep(25);
    assert.equal(submitted, '/model gpt-4.1');
  } finally { try { inst.unmount(); } catch {} try { inst.cleanup(); } catch {} }
});

test('args still submit normally when there is no completer (regression)', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let submitted = null;
  const inst = render(React.createElement(ReplApp, {
    splashProps: { provider: 'mock', model: 'm', version: '6.x', cwd: '/tmp', tools: [], skills: [] },
    slashCommands: SLASH_COMMANDS,
    onSlashCommand: async (line) => { submitted = line; return 'ok'; },
    onArgComplete: async () => null,
    runTurnFactory: () => async () => {},
  }), { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false });
  try {
    stdin.write('/help now');
    await sleep(60);
    stdin.write('\r');
    for (let i = 0; i < 30 && submitted === null; i++) await sleep(25);
    assert.equal(submitted, '/help now');
  } finally { try { inst.unmount(); } catch {} try { inst.cleanup(); } catch {} }
});
