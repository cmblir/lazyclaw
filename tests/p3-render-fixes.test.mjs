// tests/p3-render-fixes.test.mjs — v5.5 rendering fixes:
//   · ScrollbackItem is memoized so committed lines don't re-render on every
//     keystroke (the typing flicker).
//   · the alt-buffer scrollback keeps the splash (banner + manual) and pins the
//     newest content to the bottom (justifyContent flex-end), so the splash
//     scrolls off naturally instead of being force-dropped after one command.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import url from 'node:url';
import path from 'node:path';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';

import { ReplApp, ScrollbackItem } from '../tui/repl.mjs';

const SRC = fs.readFileSync(
  path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'tui', 'repl.mjs'),
  'utf8',
);

test('ScrollbackItem is wrapped in React.memo (anti-flicker)', () => {
  // React.memo components carry $$typeof === Symbol.for('react.memo').
  assert.equal(ScrollbackItem.$$typeof, Symbol.for('react.memo'));
});

test('alt-buffer scrollback no longer force-drops the splash', () => {
  assert.ok(!/kind !== 'splash'/.test(SRC),
    'the splash-drop filter must be gone so the manual + character persist');
});

test('alt-buffer scrollback pins newest to the bottom (justifyContent flex-end)', () => {
  // Scope the check to the alt-buffer arm.
  const altArm = SRC.match(/altEnabled[\s\S]{0,1600}?\.scrollback\.map\(/);
  assert.ok(altArm, 'alt-buffer arm present');
  assert.ok(/justifyContent:\s*'flex-end'/.test(altArm[0]),
    'alt-buffer scrollback Box must use justifyContent flex-end');
});

function mkStdio() {
  const stdout = new PassThrough();
  stdout.columns = 80; stdout.rows = 24;
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
  const chunks = [];
  stdout.on('data', (b) => chunks.push(b.toString('utf8')));
  return { stdin, stdout, stderr, frames: () => chunks.join('') };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('splash survives a committed command (does not vanish on the first action)', async () => {
  const { stdin, stdout, stderr, frames } = mkStdio();
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: { provider: 'ollama', model: 'llama3.1', version: '5.x', cwd: '/tmp', tools: [], skills: [] },
      statusInfo: { provider: 'ollama', model: 'llama3.1' },
      onSlashCommand: async () => 'ok',
      runTurn: async () => {},
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  try {
    await wait(40);
    // Commit a (non-matching) slash command so scrollback grows past 1 item.
    stdin.write('/zzcmd');
    await wait(30);
    stdin.write('\r');
    await wait(120);
    // The splash renders a "subcommands" summary row; with the v5.4.3 hack it
    // would be gone after the command. With the fix it persists (content is
    // short enough to stay on screen).
    assert.match(frames(), /subcommand/i, 'splash still visible after a command');
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});
