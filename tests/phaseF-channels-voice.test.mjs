import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Channel } from '../channels/base.mjs';

const entry = pathToFileURL(path.join(process.cwd(), 'channels-voice', 'index.mjs')).href;

test('voice: register + Channel subclass with name "voice"', async () => {
  const mod = await import(entry);
  assert.equal(typeof mod.register, 'function');
  const ch = new mod.VoiceChannel({ transcribe: async () => 'hello world' });
  assert.ok(ch instanceof Channel);
  assert.equal(ch.name, 'voice');
});

test('voice: ingestVoiceMemo routes transcript through handler', async () => {
  const mod = await import(entry);
  const calls = [];
  const ch = new mod.VoiceChannel({ transcribe: async (buf, mime) => {
    calls.push({ bytes: buf.length, mime });
    return 'transcribed text';
  }});
  let handlerArgs = null;
  await ch.start(async (evt) => { handlerArgs = evt; return 'ok'; });
  const reply = await ch.ingestVoiceMemo({
    threadId: 't-1', audio: Buffer.from('fake-ogg-bytes'), mime: 'audio/ogg',
  });
  assert.equal(reply, 'ok');
  assert.deepEqual(handlerArgs, { channel: 'voice', threadId: 't-1', text: 'transcribed text' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mime, 'audio/ogg');
});

test('voice: TTS reply is intentionally absent (spec §0.2)', async () => {
  const mod = await import(entry);
  const ch = new mod.VoiceChannel({ transcribe: async () => 'x' });
  // The plugin must NOT expose a tts/synthesize method in v5.0.
  assert.equal(typeof ch.tts, 'undefined');
  assert.equal(typeof ch.synthesize, 'undefined');
});

test('voice: missing transcribe fn at ingest time -> TRANSCRIBE_NOT_CONFIGURED', async () => {
  const mod = await import(entry);
  const ch = new mod.VoiceChannel({});
  await ch.start(async () => 'ok');
  await assert.rejects(
    ch.ingestVoiceMemo({ threadId: 't', audio: Buffer.from('x'), mime: 'audio/ogg' }),
    /TRANSCRIBE_NOT_CONFIGURED/);
});
