// Phase H1 — Trajectory exporter (spec §2.7).
// Exporter is read-only: it never spawns trainer, never touches weights.
// Four formats: atropos, axolotl, openai-ft, jsonl. Filters: --since, --outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { put } from '../mas/trajectory_store.mjs';
import { exportTrajectories } from '../mas/trajectory_export.mjs';

const CLI = path.join(process.cwd(), 'cli.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-traj-export-'));
}

function baseRec(overrides = {}) {
  return {
    taskId: 't_x',
    agentName: 'worker-0',
    workerProvider: 'claude-cli',
    workerModel: 'claude-opus-4-7',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    systemPrompt: 'You are helpful.',
    userMessages: ['hello'],
    turns: [
      { turnIdx: 0, role: 'user', content: 'hello', toolCalls: [] },
      { turnIdx: 1, role: 'assistant', content: 'hi there', toolCalls: [] },
    ],
    finalAnswer: 'hi there',
    outcome: 'done',
    ...overrides,
  };
}

test('exportTrajectories(jsonl) writes one record per line as raw transcript', async () => {
  const dir = tmpDir();
  const a = await put(baseRec({ taskId: 't1' }), { configDir: dir });
  const b = await put(baseRec({ taskId: 't2' }), { configDir: dir });
  const outDir = path.join(dir, 'out');
  const r = await exportTrajectories({
    format: 'jsonl', configDir: dir, outDir,
  });
  assert.equal(r.count, 2);
  assert.ok(fs.existsSync(r.outFile));
  const lines = fs.readFileSync(r.outFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const ids = lines.map(l => JSON.parse(l).id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
});

test('exportTrajectories(atropos) emits {messages, reward, metadata} per line', async () => {
  const dir = tmpDir();
  await put(baseRec(), { configDir: dir });
  const outDir = path.join(dir, 'out');
  const r = await exportTrajectories({
    format: 'atropos', configDir: dir, outDir,
  });
  const line = fs.readFileSync(r.outFile, 'utf8').trim().split('\n')[0];
  const obj = JSON.parse(line);
  assert.ok(Array.isArray(obj.messages));
  // system prompt + user + assistant turn
  assert.ok(obj.messages.length >= 2);
  assert.equal(obj.messages[0].role, 'system');
  assert.ok('reward' in obj);
  assert.equal(obj.reward, null, 'B.6 #22: --reward none default');
  assert.ok(obj.metadata);
  assert.equal(obj.metadata.outcome, 'done');
  assert.equal(obj.metadata.workerProvider, 'claude-cli');
});

test('exportTrajectories(axolotl) emits ShareGPT-style {conversations:[{from,value}]}', async () => {
  const dir = tmpDir();
  await put(baseRec(), { configDir: dir });
  const outDir = path.join(dir, 'out');
  const r = await exportTrajectories({
    format: 'axolotl', configDir: dir, outDir,
  });
  const line = fs.readFileSync(r.outFile, 'utf8').trim().split('\n')[0];
  const obj = JSON.parse(line);
  assert.ok(Array.isArray(obj.conversations));
  // role mapping: system→system, user→human, assistant→gpt
  const fromValues = obj.conversations.map(c => c.from);
  assert.ok(fromValues.includes('system'));
  assert.ok(fromValues.includes('human'));
  assert.ok(fromValues.includes('gpt'));
});

test('exportTrajectories(openai-ft) emits {messages:[{role,content}]} per line', async () => {
  const dir = tmpDir();
  await put(baseRec(), { configDir: dir });
  const outDir = path.join(dir, 'out');
  const r = await exportTrajectories({
    format: 'openai-ft', configDir: dir, outDir,
  });
  const line = fs.readFileSync(r.outFile, 'utf8').trim().split('\n')[0];
  const obj = JSON.parse(line);
  assert.ok(Array.isArray(obj.messages));
  for (const m of obj.messages) {
    assert.ok(['system', 'user', 'assistant', 'tool'].includes(m.role));
    assert.equal(typeof m.content, 'string');
  }
});

test('filter outcome=done excludes failed/abandoned', async () => {
  const dir = tmpDir();
  await put(baseRec({ taskId: 'a', outcome: 'done' }), { configDir: dir });
  await put(baseRec({ taskId: 'b', outcome: 'failed' }), { configDir: dir });
  await put(baseRec({ taskId: 'c', outcome: 'abandoned' }), { configDir: dir });
  const r = await exportTrajectories({
    format: 'jsonl', configDir: dir, outDir: path.join(dir, 'out'),
    filter: { outcome: 'done' },
  });
  assert.equal(r.count, 1);
});

test('filter since=Nd excludes older records', async () => {
  const dir = tmpDir();
  const tenDaysAgo = Date.now() - 10 * 86400_000;
  await put(baseRec({ taskId: 'old', startedAt: tenDaysAgo, endedAt: tenDaysAgo + 100 }), { configDir: dir });
  await put(baseRec({ taskId: 'new' }), { configDir: dir });
  const r = await exportTrajectories({
    format: 'jsonl', configDir: dir, outDir: path.join(dir, 'out'),
    since: '7d',
  });
  assert.equal(r.count, 1);
});

test('rejects unknown format', async () => {
  const dir = tmpDir();
  await assert.rejects(
    exportTrajectories({ format: 'bogus', configDir: dir, outDir: dir }),
    /unknown format/,
  );
});

test('CLI: pompos trajectories export --format jsonl writes file', () => {
  const dir = tmpDir();
  // seed with one record using the same module via a tiny inline script
  const seedScript = `
    import { put } from '${path.join(process.cwd(), 'mas', 'trajectory_store.mjs')}';
    await put({ taskId: 't_cli', agentName: 'a', workerProvider: 'anthropic',
      workerModel: 'm', startedAt: 1, endedAt: 2, systemPrompt: 's',
      userMessages: ['u'], turns: [{turnIdx:0,role:'assistant',content:'x',toolCalls:[]}],
      finalAnswer: 'x', outcome: 'done' }, { configDir: '${dir}' });
  `;
  const seedFile = path.join(dir, 'seed.mjs');
  fs.writeFileSync(seedFile, seedScript);
  const seed = spawnSync(process.execPath, [seedFile], { encoding: 'utf8' });
  assert.equal(seed.status, 0, `seed stderr: ${seed.stderr}`);

  const outDir = path.join(dir, 'out');
  const r = spawnSync(
    process.execPath,
    [CLI, 'trajectories', 'export', '--format', 'jsonl', '--out', outDir],
    { env: { ...process.env, LAZYCLAW_CONFIG_DIR: dir, LAZYCLAW_NO_INK: '1' }, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.ok(fs.existsSync(outDir), 'out dir created');
  const files = fs.readdirSync(outDir).filter(f => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, `expected exactly one jsonl file; got ${files.join(',')}`);
});
