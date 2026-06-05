import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { Channel } from '../channels/base.mjs';

test('discord plugin: exports register() and a Channel subclass', async () => {
  const entry = pathToFileURL(path.join(process.cwd(), 'channels-discord', 'index.mjs')).href;
  const mod = await import(entry);
  assert.equal(typeof mod.register, 'function');
  assert.equal(typeof mod.DiscordChannel, 'function');
  const ch = new mod.DiscordChannel({ token: 'fake' });
  assert.ok(ch instanceof Channel);
  assert.equal(ch.name, 'discord');
});

test('discord plugin: register() wires factory into addChannel', async () => {
  const entry = pathToFileURL(path.join(process.cwd(), 'channels-discord', 'index.mjs')).href;
  const mod = await import(entry);
  const got = {};
  await mod.register({ Channel, addChannel: (k, f) => { got.kind = k; got.factory = f; } });
  assert.equal(got.kind, 'discord');
  const ch = got.factory({ token: 'fake' });
  assert.equal(ch.name, 'discord');
});

test('discord plugin: send() without a started client throws CLIENT_NOT_READY', async () => {
  const entry = pathToFileURL(path.join(process.cwd(), 'channels-discord', 'index.mjs')).href;
  const mod = await import(entry);
  const ch = new mod.DiscordChannel({ token: 'fake' });
  await assert.rejects(ch.send('chan-1', 'hi'), /CLIENT_NOT_READY/);
});
