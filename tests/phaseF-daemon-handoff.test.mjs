// Phase F (F5/F6) — cross-channel handoff wired through the daemon.
//
// F5: POST /inbound, given {channel, externalId}, binds a persistent
//     thread/session (channels/threads.mjs) and hydrates prior turns, so a
//     conversation survives across calls and channels.
// F6: POST /handoff re-points a thread to a new channel; the next inbound on
//     the target resumes the SAME session ("context follows"). The rollback
//     helper restores the binding if a target notify fails.
//
// All assertions run in-process against startDaemon({port:0}) with the mock
// provider — zero live network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startDaemon } from '../daemon.mjs';
import * as sessionsMod from '../sessions.mjs';
import { openThreads } from '../channels/threads.mjs';
import { handoffWithRollback } from '../channels/handoff.mjs';

function tmpCfg(prefix = 'lc-handoff-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withDaemon(cfgDir, fn) {
  const cfg = { provider: 'mock', model: 'mock-model' };
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(cfg));
  const prevEnv = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = cfgDir;
  const d = await startDaemon({
    readConfig: () => cfg,
    writeConfig: () => {},
    sessionsDirGetter: () => cfgDir,
    sessionsMod,
    version: () => 'test',
    port: 0,
  });
  const base = `http://127.0.0.1:${d.port}`;
  try {
    await fn({ base, cfgDir });
  } finally {
    await d.close();
    if (prevEnv === undefined) delete process.env.POMPOS_CONFIG_DIR;
    else process.env.POMPOS_CONFIG_DIR = prevEnv;
  }
}

function postJson(base, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('F5 — POST /inbound binds a thread+session on first message and persists turns', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await postJson(base, '/inbound', { channel: 'slack', externalId: 'C1:1', text: 'remember 42' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.sessionId, 'response carries a sessionId');
    assert.ok(String(body.threadId).startsWith('th_'), `threadId looks like a thread (got ${body.threadId})`);

    // The binding is persisted and points at the same session.
    const t = openThreads(cfgDir);
    const bound = t.findByExternal('slack', 'C1:1');
    assert.ok(bound, 'thread bound for slack:C1:1');
    assert.equal(bound.sessionId, body.sessionId);

    // User + assistant turns persisted under that session.
    const turns = sessionsMod.loadTurns(body.sessionId, cfgDir);
    assert.equal(turns.length, 2, `expected user+assistant turn, got ${turns.length}`);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].content, 'remember 42');
    assert.equal(turns[1].role, 'assistant');
  });
});

test('F5 — a second inbound on the same channel resumes the same session (multi-turn)', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const first = await (await postJson(base, '/inbound', { channel: 'slack', externalId: 'C1:1', text: 'first' })).json();
    const second = await (await postJson(base, '/inbound', { channel: 'slack', externalId: 'C1:1', text: 'second' })).json();
    assert.equal(second.sessionId, first.sessionId, 'same session across calls');
    assert.equal(second.threadId, first.threadId, 'same thread across calls');
    const turns = sessionsMod.loadTurns(first.sessionId, cfgDir);
    assert.equal(turns.length, 4, `two turns each call → 4, got ${turns.length}`);
    assert.deepEqual(turns.map((t) => t.content).filter((_, i) => i % 2 === 0), ['first', 'second']);
  });
});

test('F5 — inbound WITHOUT channel/externalId stays stateless (byte-compatible)', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await postJson(base, '/inbound', { text: 'hi' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(Object.keys(body).sort(), ['reply', 'threadId']);
    assert.equal(body.threadId, null);
    // No thread store created for the stateless path.
    const t = openThreads(cfgDir);
    assert.equal(t.list().length, 0, 'stateless inbound creates no thread binding');
  });
});

test('F6 — context follows across a handoff: slack → discord resumes the same session', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const seed = await (await postJson(base, '/inbound', { channel: 'slack', externalId: 'C1:1', text: 'the password is hunter2' })).json();
    const threadId = seed.threadId;
    const sessionId = seed.sessionId;

    const ho = await postJson(base, '/handoff', { threadId, target: 'discord', externalId: 'D9:9' });
    assert.equal(ho.status, 200);
    const hoBody = await ho.json();
    assert.equal(hoBody.channel, 'discord');
    assert.equal(hoBody.externalId, 'D9:9');
    assert.equal(hoBody.sessionId, sessionId, 'sessionId preserved across handoff');

    // Binding moved: slack no longer resolves, discord does (same session).
    const t = openThreads(cfgDir);
    assert.equal(t.findByExternal('slack', 'C1:1'), null, 'source binding removed');
    assert.equal(t.findByExternal('discord', 'D9:9').sessionId, sessionId, 'target bound to same session');

    // Next inbound on discord resumes the SAME session and sees prior context.
    const cont = await (await postJson(base, '/inbound', { channel: 'discord', externalId: 'D9:9', text: 'what was the password?' })).json();
    assert.equal(cont.sessionId, sessionId, 'discord inbound resumes the handed-off session');
    const turns = sessionsMod.loadTurns(sessionId, cfgDir);
    assert.ok(turns.some((t) => t.content === 'the password is hunter2'), 'original slack turn carried across the channel boundary');
    assert.ok(turns.some((t) => t.content === 'what was the password?'), 'discord turn appended to the same session');
  });
});

test('F6 — POST /handoff on an unknown thread returns 404 THREAD_NOT_FOUND', async () => {
  const cfgDir = tmpCfg();
  await withDaemon(cfgDir, async ({ base }) => {
    const r = await postJson(base, '/handoff', { threadId: 'th_nope', target: 'discord', externalId: 'x' });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.equal(body.code, 'THREAD_NOT_FOUND');
  });
});

test('F6 — handoffWithRollback restores the source binding when the target notify fails', async () => {
  const cfgDir = tmpCfg();
  const threads = openThreads(cfgDir);
  const bound = threads.upsert({ channel: 'slack', externalId: 'C1:1', sessionId: 's-roll' });

  // A notifier that throws must trigger a rollback to the source binding.
  await assert.rejects(
    () => handoffWithRollback({
      threads, threadId: bound.threadId, target: 'discord', externalId: 'D9:9',
      send: async () => { throw new Error('discord unreachable'); },
    }),
    (err) => err.code === 'HANDOFF_SEND_FAILED',
  );

  // Binding rolled back: slack still resolves, discord does not.
  assert.equal(threads.findByExternal('discord', 'D9:9'), null, 'failed target binding rolled back');
  const back = threads.findByExternal('slack', 'C1:1');
  assert.ok(back, 'source binding restored');
  assert.equal(back.sessionId, 's-roll');
});

test('F6 — handoffWithRollback with no notifier just migrates (context follows on next inbound)', async () => {
  const cfgDir = tmpCfg();
  const threads = openThreads(cfgDir);
  const bound = threads.upsert({ channel: 'slack', externalId: 'C1:1', sessionId: 's-nosend' });
  const next = await handoffWithRollback({ threads, threadId: bound.threadId, target: 'discord', externalId: 'D9:9' });
  assert.equal(next.sessionId, 's-nosend');
  assert.equal(threads.findByExternal('slack', 'C1:1'), null);
  assert.equal(threads.findByExternal('discord', 'D9:9').sessionId, 's-nosend');
});
