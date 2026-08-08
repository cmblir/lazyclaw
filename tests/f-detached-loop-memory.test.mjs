// tests/f-detached-loop-memory.test.mjs — `loop --detach --use-memory` was
// doubly broken: the detach argv builder never forwarded --use-memory/--recall
// (so the worker never saw them), and the worker built no system message and
// sent apiKey: process.env.POMPOS_API_KEY||'' instead of resolving it from
// config. The foreground path honored both. These pin the detached parity.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildDetachArgv } from '../commands/automation.mjs';
import { setCore } from '../memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, '..', 'scripts', 'loop-worker.mjs');

test('buildDetachArgv forwards --use-memory and --recall to the worker', () => {
  const argv = buildDetachArgv('/w.mjs', { loopId: 'L1', prompt: 'p', max: 3, provName: 'mock', cfgDir: '/c', useMemory: true, recall: 'foo bar' });
  assert.ok(argv.includes('--use-memory'), '--use-memory must be forwarded');
  const i = argv.indexOf('--recall');
  assert.ok(i >= 0 && argv[i + 1] === 'foo bar', '--recall <query> must be forwarded');
});

test('buildDetachArgv omits memory flags when not requested', () => {
  const argv = buildDetachArgv('/w.mjs', { loopId: 'L1', prompt: 'p', max: 3, provName: 'mock', cfgDir: '/c' });
  assert.ok(!argv.includes('--use-memory'));
  assert.ok(!argv.includes('--recall'));
});

test('the detached worker honours --use-memory (injects core memory into the turn)', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-detmem-'));
  setCore('DETACHED-CORE-MARKER', cfgDir);
  const loopId = 'detmem1';
  // Run the worker in the foreground (not --detach) so spawnSync waits for it.
  const r = spawnSync(process.execPath, [
    WORKER, '--loop-id', loopId, '--prompt', 'ping', '--max', '1',
    '--provider', 'mock', '--cfg-dir', cfgDir, '--use-memory',
  ], { encoding: 'utf8', env: { ...process.env, POMPOS_CONFIG_DIR: cfgDir } });
  assert.equal(r.status, 0, `worker exited ${r.status}: ${r.stderr}`);
  // The mock provider echoes the system message it received into its reply
  // ([sys:...]) and the worker records a reply preview in iterations.log.
  const iter = fs.readFileSync(path.join(cfgDir, 'loops', loopId, 'iterations.log'), 'utf8');
  assert.match(iter, /DETACHED-CORE-MARKER/, 'core memory must reach the detached worker turn');
});
