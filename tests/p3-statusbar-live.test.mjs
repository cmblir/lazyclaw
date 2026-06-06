// tests/p3-statusbar-live.test.mjs — P3 restore: the StatusBar must reflect a
// /provider or /model switch. The v5.4 bar read a frozen literal captured at
// mount, so after a slash it kept showing the old provider/model. ReplApp now
// refreshes from a getStatus() callback after each slash command.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';

import { ReplApp } from '../tui/repl.mjs';

function mkStdio({ columns = 80 } = {}) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = 24;
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.setEncoding = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const chunks = [];
  stdout.on('data', (b) => chunks.push(b.toString('utf8')));
  return { stdin, stdout, stderr, frames: () => chunks.join('') };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('StatusBar refreshes provider/model after a /model slash command', async () => {
  const { stdin, stdout, stderr, frames } = mkStdio();
  // Mutable "host" state the slash command flips, mirroring cli.mjs's
  // activeProvName / activeModel closure.
  const live = { provider: 'ollama', model: 'llama3.1' };
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: { provider: 'ollama', model: 'llama3.1', version: '5.x', cwd: '/tmp', tools: [], skills: [] },
      statusInfo: { provider: 'ollama', model: 'llama3.1' },
      getStatus: () => ({ provider: live.provider, model: live.model }),
      onSlashCommand: async () => {
        // Mirror what /provider+/model do to the host closure. The literal
        // command text is irrelevant to the StatusBar refresh under test; we
        // use a non-matching slash so the slash popup doesn't eat the Enter.
        live.provider = 'openai';
        live.model = 'gpt-4.1';
        return 'provider → openai · model → gpt-4.1';
      },
      runTurn: async () => {},
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );

  try {
    await wait(40);
    assert.match(frames(), /llama3\.1/, 'initial StatusBar shows the seeded model');

    stdin.write('/zzswitch');
    await wait(30);
    stdin.write('\r');
    await wait(150);

    assert.match(frames(), /gpt-4\.1/, 'StatusBar updated to the new model after the slash');
    assert.match(frames(), /openai/, 'StatusBar updated to the new provider');
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});
