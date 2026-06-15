// tests/p4-arg-complete-e2e.test.mjs — end-to-end argument completion:
//  • modal kind  — Tab opens the drill-in; host returns the value; Enter submits.
//  • inline kind — candidates render in the popup; ↑/↓ select, Enter fills, Enter submits.
// Generous sleeps: these render real Ink over PassThrough and are timing-sensitive
// under a loaded parallel suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { ReplApp } from '../tui/repl.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';

const DOWN = '[B'; // ANSI down-arrow

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
    await sleep(120);
    stdin.write('\t');                 // arg-complete → buffer becomes "/model gpt-4.1"
    await sleep(200);
    stdin.write('\r');                 // submit
    for (let i = 0; i < 60 && submitted === null; i++) await sleep(40);
    assert.equal(submitted, '/model gpt-4.1');
  } finally { try { inst.unmount(); } catch {} try { inst.cleanup(); } catch {} }
});

test('inline arg popup: /login shows candidates; down + Enter fills the token, Enter submits', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let submitted = null;
  const inst = render(React.createElement(ReplApp, {
    splashProps: { provider: 'mock', model: 'm', version: '6.x', cwd: '/tmp', tools: [], skills: [] },
    slashCommands: SLASH_COMMANDS,
    onSlashCommand: async (line) => { submitted = line; return 'ok'; },
    // synchronous, mirroring the real _inkArgList (no async render hop)
    onArgList: (buf) => (buf.startsWith('/login')
      ? [{ value: 'codex-cli', desc: '' }, { value: 'gemini-cli', desc: '' }]
      : []),
    runTurnFactory: () => async () => {},
  }), { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false });
  try {
    stdin.write('/login ');
    await sleep(300);   // popup ready (generous for parallel-suite load)
    stdin.write(DOWN);  // select gemini-cli
    await sleep(120);
    stdin.write('\r');  // fill token
    await sleep(200);
    stdin.write('\r');  // submit completed line
    for (let i = 0; i < 60 && submitted === null; i++) await sleep(40);
    assert.equal(submitted, '/login gemini-cli');
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
    await sleep(120);
    stdin.write('\r');
    for (let i = 0; i < 60 && submitted === null; i++) await sleep(40);
    assert.equal(submitted, '/help now');
  } finally { try { inst.unmount(); } catch {} try { inst.cleanup(); } catch {} }
});
