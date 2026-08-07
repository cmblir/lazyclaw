// tests/p3-noalt-default.test.mjs — v5.5: the chat defaults to the Static
// scrollback (no full-frame redraw → no typing flicker; the splash prints once
// and scrolls naturally, never the alt-canvas vanish/blank). Alt-buffer
// fullscreen is opt-in via LAZYCLAW_ALT=1; LAZYCLAW_NO_ALT=1 still forces off.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { ReplApp, computeAltEnabled } from '../tui/repl.mjs';

// ─── pure decision ─────────────────────────────────────────────────────────

test('computeAltEnabled defaults to non-alt and is opt-in via LAZYCLAW_ALT', () => {
  assert.equal(computeAltEnabled({}, true), false, 'default = non-alt even on a TTY');
  assert.equal(computeAltEnabled({ LAZYCLAW_ALT: '1' }, true), true, 'opt-in');
  assert.equal(computeAltEnabled({ LAZYCLAW_ALT: '1' }, false), false, 'never on a non-TTY');
  assert.equal(computeAltEnabled({ LAZYCLAW_ALT: '1', LAZYCLAW_NO_ALT: '1' }, true), false, 'NO_ALT wins');
});

// ─── render: default shows the splash and does NOT enter the alt-buffer ──────

const ALT_ENTER = '\x1b[?1049h';

function mkTtyStdio() {
  const stdout = new PassThrough();
  stdout.columns = 80; stdout.rows = 24; stdout.isTTY = true;
  stdout.cursorTo = () => {}; stdout.clearLine = () => {}; stdout.moveCursor = () => {};
  const stderr = new PassThrough(); stderr.isTTY = true;
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
  const chunks = [];
  stdout.on('data', (b) => chunks.push(b.toString('utf8')));
  return { stdin, stdout, stderr, frames: () => chunks.join('') };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('default chat (no env) shows the splash and never enters the alt-buffer', async () => {
  const pa = process.env.LAZYCLAW_ALT; const pn = process.env.LAZYCLAW_NO_ALT;
  delete process.env.LAZYCLAW_ALT; delete process.env.LAZYCLAW_NO_ALT;
  const io = mkTtyStdio();
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: { provider: 'ollama', model: 'llama3.1', version: '5.x', cwd: '/tmp', tools: [], skills: [] },
      statusInfo: { provider: 'ollama', model: 'llama3.1' },
      onSlashCommand: async () => 'ok',
      runTurn: async () => {},
    }),
    { stdout: io.stdout, stdin: io.stdin, stderr: io.stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    await wait(50);
    assert.ok(!io.frames().includes(ALT_ENTER), 'must NOT enter the alt-buffer by default');
    assert.match(io.frames(), /subcommand/i, 'splash (art + manual) visible by default');
    // and it survives a committed command (Static keeps it)
    io.stdin.write('/zzcmd'); await wait(30); io.stdin.write('\r'); await wait(120);
    assert.match(io.frames(), /subcommand/i, 'splash still visible after a command');
  } finally {
    try { instance.unmount(); } catch {}
    if (pa === undefined) delete process.env.LAZYCLAW_ALT; else process.env.LAZYCLAW_ALT = pa;
    if (pn === undefined) delete process.env.LAZYCLAW_NO_ALT; else process.env.LAZYCLAW_NO_ALT = pn;
  }
});
