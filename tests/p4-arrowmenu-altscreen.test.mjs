// tests/p4-arrowmenu-altscreen.test.mjs — the wizard's arrow-key picker
// (_arrowMenu) must render on the ALTERNATE screen buffer so it doesn't push
// the previous wizard output into scrollback (the "화면이 밀린다" bug). Assert
// it emits the enter/leave alt-screen escapes and never clears the MAIN buffer
// on the way out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { _arrowMenu, _pickYesNo } from '../tui/pickers.mjs';

test('_arrowMenu uses the alternate screen buffer (no main-buffer push)', async () => {
  // Drive the real TTY path by faking TTY stdin/stdout and capturing bytes.
  // We buffer writes into `out` and restore the real stdout the instant the
  // menu resolves, so node:test's own reporter output is never swallowed.
  const out = [];
  const real = {
    soTTY: process.stdout.isTTY, soWrite: process.stdout.write.bind(process.stdout), soRows: process.stdout.rows,
    siTTY: process.stdin.isTTY, siRaw: process.stdin.setRawMode, siResume: process.stdin.resume, siRef: process.stdin.ref,
  };
  process.stdout.isTTY = true; process.stdout.rows = 24;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stdin.isTTY = true;
  process.stdin.setRawMode = () => {}; process.stdin.resume = () => {}; process.stdin.ref = () => {};
  const t = setTimeout(() => process.stdin.emit('keypress', '', { name: 'return' }), 20);
  let picked;
  try {
    picked = await _arrowMenu({ title: 'pick', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  } finally {
    clearTimeout(t);
    process.stdout.isTTY = real.soTTY; process.stdout.write = real.soWrite; process.stdout.rows = real.soRows;
    process.stdin.isTTY = real.siTTY; process.stdin.setRawMode = real.siRaw; process.stdin.resume = real.siResume; process.stdin.ref = real.siRef;
  }
  const s = out.join('');
  assert.equal(picked && picked.id, 'a', 'return confirms the first row');
  assert.ok(s.includes('\x1b[?1049h'), 'enters the alternate screen buffer');
  assert.ok(s.includes('\x1b[?1049l'), 'leaves the alternate screen buffer on cleanup');
  assert.ok(s.indexOf('\x1b[?1049h') < s.indexOf('\x1b[?1049l'), 'enter precedes leave');
  // No main-buffer clear after leaving the alt screen — that push/clear of the
  // main buffer was the scrollback-pollution bug.
  const tail = s.slice(s.indexOf('\x1b[?1049l') + 6);
  assert.ok(!tail.includes('\x1b[2J'), 'no main-buffer clear after leaving the alt screen');
});

test('_pickYesNo returns booleans and honours the default on cancel', async () => {
  assert.equal(await _pickYesNo('ok?', { pick: async () => ({ id: 'yes' }) }), true);
  assert.equal(await _pickYesNo('ok?', { pick: async () => ({ id: 'no' }) }), false);
  assert.equal(await _pickYesNo('ok?', { defaultYes: true, pick: async () => 'CANCEL' }), true);
  assert.equal(await _pickYesNo('ok?', { defaultYes: false, pick: async () => 'BACK' }), false);
});
