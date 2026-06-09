// tests/f-slash-args.test.mjs — a slash command WITH arguments must submit the
// full line, not get reverted to the bare command. Regression: the slash popup
// stayed open as a one-row hint while typing args (e.g. `/orchestrator off`),
// and the editor's Enter handler "filled" the matched command — dropping the
// args and reverting the buffer to `/orchestrator `.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { ReplApp } from '../tui/repl.mjs';
import { filterSlashCommands } from '../tui/slash_popup.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';

function mkStdio() {
  const stdout = new PassThrough(); stdout.columns = 80; stdout.rows = 24;
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {};
  stdin.ref = () => {}; stdin.unref = () => {};
  return { stdin, stdout, stderr };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('filterSlashCommands still head-matches an args buffer (the hint source)', () => {
  // The matcher itself is unchanged; the fix is that the REPL stops treating
  // that match as an interactive popup once a space is present.
  assert.deepEqual(filterSlashCommands('/orchestrator off', SLASH_COMMANDS).map((c) => c.cmd), ['/orchestrator']);
});

test('ReplApp: Enter on `/provider openai` forwards the FULL line to onSlashCommand', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let got = null;
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: { provider: 'mock', model: 'm', version: '6.x', cwd: '/tmp', tools: [], skills: [] },
      slashCommands: SLASH_COMMANDS,
      onSlashCommand: async (line) => { got = line; return 'ok'; },
      runTurnFactory: () => async () => {},
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    stdin.write('/provider openai');
    await sleep(60);
    stdin.write('\r');
    for (let i = 0; i < 30 && got === null; i++) await sleep(25);
    assert.equal(got, '/provider openai', 'args must be preserved (not reverted to /provider)');
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});
