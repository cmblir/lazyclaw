// tests/f-legacy-ghost-crash.test.mjs — the legacy readline path must not
// crash on a real terminal.
//
// Regression (v6.3.0): _attachGhostAutocomplete referenced SLASH_COMMANDS
// without importing it — a leftover from the D4 extraction out of cli.mjs.
// The `!process.stdout.isTTY` early-return meant every non-TTY test/CI run
// skipped the broken line; the first REAL terminal that fell back to the
// legacy path (ink unavailable / narrow window) hit
// `ReferenceError: SLASH_COMMANDS is not defined` and chat died at boot.
// These tests force the TTY branch so the bug class stays covered.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { _attachGhostAutocomplete, _printChatBanner } from '../tui/pickers.mjs';

function withTTY(fn) {
  const prev = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  const writes = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (s) => { writes.push(String(s)); return true; };
  return Promise.resolve()
    .then(() => fn(writes))
    .finally(() => {
      process.stdout.write = origWrite;
      if (prev) Object.defineProperty(process.stdout, 'isTTY', prev);
      else delete process.stdout.isTTY;
    });
}

test('ghost autocomplete attaches on a TTY without throwing (the 6.3.0 crash)', async () => {
  await withTTY(async () => {
    const rl = new EventEmitter();
    rl.line = '';
    rl.cursor = 0;
    const ghost = _attachGhostAutocomplete(rl);
    assert.equal(typeof ghost.dispose, 'function');
    assert.equal(typeof ghost.suspend, 'function');
    // Drive a keypress with a slash prefix so the SLASH_COMMANDS lookup
    // actually executes (the line that crashed).
    rl.line = '/mo';
    process.stdin.emit('keypress', 'o', { name: 'o' });
    ghost.dispose();
  });
});

test('legacy chat banner renders the v5 splash, not the v4 figlet box', async () => {
  await withTTY(async (writes) => {
    await _printChatBanner('claude-cli', 'claude-fable-5', '6.x');
    const out = writes.join('');
    assert.ok(out.includes('provider ·'), 'banner printed');
    assert.ok(!out.includes('__,_/___'), 'figlet "lazy" art is gone');
    assert.ok(/[⠀-⣿]/.test(out) || out.includes('pompos v'), 'v5 splash (braille sloth / wordmark) shown');
  });
});
