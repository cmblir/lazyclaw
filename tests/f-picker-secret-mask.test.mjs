// tests/f-picker-secret-mask.test.mjs — a secret picker (/provider key, /login
// apikey, /channels credential entry) must mask the typed value. ModalPicker
// supports a `secret` prop (renders bullets), but ReplApp.openPicker dropped
// opts.secret into the modal state and never passed it to ModalPicker — so the
// API key was echoed in plaintext to the screen and any screen-share.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { ReplApp } from '../tui/repl.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('openPicker({secret:true}) masks the typed query — no plaintext key on screen', async () => {
  const pickerRef = { current: null };
  const instance = render(
    React.createElement(ReplApp, {
      splashProps: { provider: 'mock', model: 'm', version: '6.x', cwd: '/tmp', tools: [], skills: [] },
      runTurnFactory: () => async () => {},
      onSlashCommand: async () => 'ok\n',
      pickerRef,
    }),
  );
  try {
    await sleep(60);
    assert.equal(typeof pickerRef.current?.openPicker, 'function', 'pickerRef must expose openPicker');
    pickerRef.current.openPicker({ secret: true, title: 'enter api key', items: [{ id: '__text__', label: 'use what I typed' }], searchable: true });
    await sleep(50);
    const SECRET = 'xoxbSECRET99';
    for (const ch of SECRET) { instance.stdin.write(ch); await sleep(12); }
    await sleep(80);
    const frame = instance.lastFrame();
    assert.ok(!frame.includes(SECRET), 'typed secret must NOT appear in plaintext in the modal');
    assert.match(frame, /•/, 'masked bullets must render for a secret query');
  } finally {
    try { instance.unmount(); } catch {}
    try { instance.cleanup(); } catch {}
  }
});
