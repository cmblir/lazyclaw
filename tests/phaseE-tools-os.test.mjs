import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as osTools from '../mas/tools/os.mjs';

test('exports 6 os tools', () => {
  const names = osTools.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['clipboard_read','clipboard_write','file_dialog','notify','open_url','screenshot']);
});

test('all os tools have a description and exec', () => {
  for (const t of osTools.TOOLS) {
    assert.equal(typeof t.description, 'string');
    assert.equal(typeof t.exec, 'function');
    assert.equal(t.category, 'os');
  }
});

test('open_url rejects non-http(s)', async () => {
  const t = osTools.TOOLS.find(t => t.name === 'open_url');
  const r = await t.exec({ url: 'file:///etc/passwd' });
  assert.equal(r.ok, false);
});

test('clipboard_write reports unsupported gracefully on win32 stub', async () => {
  // Force platform via injected ctx.platform.
  const t = osTools.TOOLS.find(t => t.name === 'clipboard_write');
  const r = await t.exec({ text: 'x' }, { platform: 'win32' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unsupported/i);
});

test('sensitivity: clipboard_write/screenshot/notify/open_url/file_dialog sensitive=true; clipboard_read sensitive=true (privacy)', () => {
  const m = Object.fromEntries(osTools.TOOLS.map(t => [t.name, t.sensitive]));
  assert.equal(m.clipboard_read, true);
  assert.equal(m.clipboard_write, true);
  assert.equal(m.screenshot, true);
  assert.equal(m.notify, false);
  assert.equal(m.open_url, true);
  assert.equal(m.file_dialog, true);
});
