import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as media from '../mas/tools/media.mjs';

test('exports 4 media tools', () => {
  const names = media.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, ['image_describe', 'image_generate', 'transcribe', 'tts_speak']);
});

test('tts_speak returns "deferred to v5.1"', async () => {
  const t = media.TOOLS.find(t => t.name === 'tts_speak');
  const r = await t.exec({ text: 'hi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /v5\.1|deferred/i);
});

test('image_generate requires provider key', async () => {
  const t = media.TOOLS.find(t => t.name === 'image_generate');
  const r = await t.exec({ prompt: 'x' }, { env: {} });
  assert.equal(r.ok, false);
});

test('all sensitive=true', () => {
  for (const t of media.TOOLS) assert.equal(t.sensitive, true);
});
