// tests/f-inbound-idempotent-e2e.test.mjs — Phase 4 end-to-end against a real
// spawned daemon (mock provider, temp config dir):
//   1. same messageId twice -> second response replays {duplicate:true} with
//      the SAME reply, and the session holds exactly one user+assistant pair;
//   2. a session-bound turn fires the post-task learning loop -> a trajectory
//      file appears on disk (mock trainer records the trajectory; synthesis
//      is skipped — provider 'mock' has no text-completion adapter).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDaemon(cfgDir) {
  const child = spawn(process.execPath, [CLI, 'daemon', '--port', '0'], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  for (let i = 0; i < 100; i++) {
    const m = /"port":(\d+)/.exec(out);
    if (m) return { child, port: Number(m[1]) };
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`daemon did not start: ${out}`);
}

async function post(port, body) {
  const r = await fetch(`http://127.0.0.1:${port}/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

test('e2e: /inbound dedups by messageId and fires the learning loop', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lz-p4-'));
  fs.writeFileSync(path.join(cfgDir, 'config.json'),
    JSON.stringify({ provider: 'mock', trainer: { provider: 'mock' } }), { mode: 0o600 });
  const { child, port } = await startDaemon(cfgDir);
  try {
    const m1 = { channel: 'slack', externalId: 'C1:100.1', senderId: 'U1', messageId: 'C1:100.1', text: 'first message' };

    const r1 = await post(port, m1);
    assert.equal(r1.status, 200);
    assert.ok(r1.json.reply.includes('first message'), 'mock echoes the text');
    assert.ok(r1.json.sessionId, 'session bound');
    assert.equal(r1.json.duplicate, undefined);

    // Exact duplicate (Slack redelivery / second listener) — replayed, not re-run.
    const r2 = await post(port, m1);
    assert.equal(r2.status, 200);
    assert.equal(r2.json.duplicate, true);
    assert.equal(r2.json.reply, r1.json.reply);
    assert.equal(r2.json.sessionId, r1.json.sessionId);

    // A NEW message in the same thread continues the SAME session.
    const r3 = await post(port, { ...m1, messageId: 'C1:100.2', text: 'second message' });
    assert.equal(r3.json.duplicate, undefined);
    assert.equal(r3.json.sessionId, r1.json.sessionId);

    // The session holds exactly 2 user+2 assistant turns (duplicate appended nothing).
    const sessFile = path.join(cfgDir, 'sessions', `${r1.json.sessionId}.jsonl`);
    const turns = fs.readFileSync(sessFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const users = turns.filter((t) => t.role === 'user').length;
    const assistants = turns.filter((t) => t.role === 'assistant').length;
    assert.equal(users, 2, `expected 2 user turns, got ${users}`);
    assert.equal(assistants, 2, `expected 2 assistant turns, got ${assistants}`);

    // Learning loop (fire-and-forget) recorded a trajectory on disk.
    const trajRoot = path.join(cfgDir, 'trajectories');
    let trajFiles = [];
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(trajRoot)) {
        trajFiles = fs.readdirSync(trajRoot, { recursive: true }).filter((f) => String(f).endsWith('.jsonl'));
        if (trajFiles.length >= 1) break;
      }
      await sleep(100);
    }
    assert.ok(trajFiles.length >= 1, 'post-task learning recorded a trajectory for the channel turn');

    // Dedup survives a daemon RESTART (persisted jsonl).
    child.kill('SIGTERM');
    await sleep(300);
    const second = await startDaemon(cfgDir);
    try {
      const r4 = await post(second.port, m1);
      assert.equal(r4.json.duplicate, true, 'duplicate detected across restart');
      assert.equal(r4.json.reply, r1.json.reply);
    } finally {
      second.child.kill('SIGKILL');
    }
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});
