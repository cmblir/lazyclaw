import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openThreads } from '../channels/threads.mjs';
import { runHandoff } from '../channels/handoff.mjs';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-handoff-')); }

test('handoff: migrates active thread, posts transition stub on both sides', async () => {
  const dir = tmpDir();
  const threads = openThreads(dir);
  const seed = threads.upsert({ channel: 'slack', externalId: 'C1:1.1', sessionId: 's1' });

  const sent = [];
  const channels = {
    slack: { send: async (to, t) => sent.push(['slack', to, t]) },
    discord: { send: async (to, t) => sent.push(['discord', to, t]) },
  };

  const res = await runHandoff({
    threads, channels,
    threadId: seed.threadId,
    target: 'discord',
    externalId: '999',
  });

  assert.equal(res.threadId, seed.threadId);
  assert.equal(res.sessionId, 's1');
  assert.equal(res.channel, 'discord');
  assert.equal(res.externalId, '999');

  // Both sides notified
  const sources = sent.map(([c]) => c).sort();
  assert.deepEqual(sources, ['discord', 'slack']);
  const slackMsg = sent.find(([c]) => c === 'slack')[2];
  assert.match(slackMsg, /handoff.*discord/i);
  const discordMsg = sent.find(([c]) => c === 'discord')[2];
  assert.match(discordMsg, /resumed from slack/i);

  // Old mapping gone, new mapping present
  assert.equal(threads.findByExternal('slack', 'C1:1.1'), null);
  assert.equal(threads.findByExternal('discord', '999').sessionId, 's1');
});

test('handoff: target channel not available -> CHANNEL_NOT_AVAILABLE', async () => {
  const dir = tmpDir();
  const threads = openThreads(dir);
  const seed = threads.upsert({ channel: 'slack', externalId: 'C1:1.1', sessionId: 's1' });
  await assert.rejects(
    runHandoff({ threads, channels: { slack: { send: async () => {} } },
      threadId: seed.threadId, target: 'discord', externalId: '999' }),
    /CHANNEL_NOT_AVAILABLE/);
});

test('handoff: unknown threadId surfaces THREAD_NOT_FOUND', async () => {
  const dir = tmpDir();
  const threads = openThreads(dir);
  await assert.rejects(
    runHandoff({ threads, channels: { slack: { send: async () => {} } },
      threadId: 'nope', target: 'slack', externalId: 'C9:9.9' }),
    /THREAD_NOT_FOUND/);
});
