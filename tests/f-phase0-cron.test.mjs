// tests/f-phase0-cron.test.mjs — Phase 0 cron hardening.
//
// BUG 1: mas/tools/scheduling.mjs::getBackend() called cron.add/list/remove,
// which cron.mjs never exported, so every tool call hit the "cron.add missing"
// fallback. This exercises the tools against the REAL cron.mjs backend (no
// injected fake) and asserts a job round-trips: add -> list shows it -> remove
// drops it. LAZYCLAW_CONFIG_DIR isolates config.json to a temp dir and
// LAZYCLAW_SKIP_CRON_INSTALL keeps the test off the real launchd/crontab.
//
// BUG 2: scheduled goal ticks stored command=["pompos",...], but launchd /
// crontab run with a minimal PATH and no shell, so the bare "pompos" token
// never resolves. The command must be baked to an absolute node + CLI entry.
//
// BUG 3: FIELD_RANGES capped day-of-week at 6, so "0 9 * * 7" (Sunday) threw
// CRON_OUT_OF_RANGE even though real crontab accepts 7. dow=7 must normalize to
// Sunday (0 for launchd Weekday).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCronSpec, buildPlist, resolveCommand } from '../cron.mjs';
import { attachGoalCron } from '../goals_cron.mjs';

function intervalsOf(xml) {
  const m = xml.match(/<key>StartCalendarInterval<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!m) return [];
  return [...m[1].matchAll(/<dict>([\s\S]*?)<\/dict>/g)].map((d) => {
    const obj = {};
    for (const kv of d[1].matchAll(/<key>(\w+)<\/key>\s*<integer>(-?\d+)<\/integer>/g)) obj[kv[1]] = Number(kv[2]);
    return obj;
  });
}

// ── BUG 1: tools hit the real cron.mjs backend ──────────────────────────────

test('cron tools round-trip against the REAL cron.mjs backend (add -> list -> remove)', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-f0cron-'));
  const prevDir = process.env.LAZYCLAW_CONFIG_DIR;
  const prevSkip = process.env.LAZYCLAW_SKIP_CRON_INSTALL;
  process.env.LAZYCLAW_CONFIG_DIR = cfgDir;
  process.env.LAZYCLAW_SKIP_CRON_INSTALL = '1';
  try {
    // Fresh import so the module is not carrying an injected fake backend.
    const sched = await import(`../mas/tools/scheduling.mjs?real=${Date.now()}`);
    const add = sched.TOOLS.find((t) => t.name === 'cron_add');
    const list = sched.TOOLS.find((t) => t.name === 'cron_list');
    const remove = sched.TOOLS.find((t) => t.name === 'cron_remove');

    const addRes = await add.exec({ name: 'morning', spec: '0 9 * * *', command: 'echo hi' });
    assert.equal(addRes.ok, true, `add should succeed, got ${JSON.stringify(addRes)}`);

    const listRes = await list.exec({});
    assert.equal(listRes.ok, true);
    assert.ok(listRes.jobs.some((j) => j.name === 'morning'), 'listed jobs must include the added one');

    // Persisted to the real config.json under the temp dir.
    const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
    assert.equal(cfg.cron.morning.schedule, '0 9 * * *');

    const rmRes = await remove.exec({ name: 'morning' });
    assert.equal(rmRes.ok, true, `remove should succeed, got ${JSON.stringify(rmRes)}`);

    const listAfter = await list.exec({});
    assert.ok(!listAfter.jobs.some((j) => j.name === 'morning'), 'removed job must be gone');
  } finally {
    if (prevDir === undefined) delete process.env.LAZYCLAW_CONFIG_DIR; else process.env.LAZYCLAW_CONFIG_DIR = prevDir;
    if (prevSkip === undefined) delete process.env.LAZYCLAW_SKIP_CRON_INSTALL; else process.env.LAZYCLAW_SKIP_CRON_INSTALL = prevSkip;
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

// ── BUG 2: absolute node + CLI entry baked into the scheduled command ────────

test('resolveCommand rewrites a bare "pompos" token to absolute node + CLI entry', () => {
  const out = resolveCommand(['pompos', 'goal', 'tick', 'sweep']);
  assert.equal(out[0], process.execPath, 'argv[0] must be the absolute node binary');
  assert.ok(path.isAbsolute(out[1]), 'argv[1] must be an absolute CLI entry path');
  assert.ok(out[1].endsWith('cli.mjs'), `CLI entry should be cli.mjs, got ${out[1]}`);
  assert.deepEqual(out.slice(2), ['goal', 'tick', 'sweep'], 'trailing args preserved');
});

test('resolveCommand leaves an already-absolute command untouched', () => {
  const cmd = ['/usr/bin/env', 'echo', 'hi'];
  assert.deepEqual(resolveCommand(cmd), cmd);
});

test('attachGoalCron persists the LOGICAL command; resolution to absolute happens at install time', async () => {
  const prevSkip = process.env.LAZYCLAW_SKIP_CRON_INSTALL;
  process.env.LAZYCLAW_SKIP_CRON_INSTALL = '1';
  let store = {};
  const readConfig = () => JSON.parse(JSON.stringify(store));
  const writeConfig = (c) => { store = JSON.parse(JSON.stringify(c)); };
  const cronReal = await import(`../cron.mjs?attach=${Date.now()}`);
  try {
    await attachGoalCron({ readConfig, writeConfig, cron: cronReal, name: 'sweep', schedule: '0 9 * * *' });
    const cmd = store.cron['goal-sweep'].command;
    // config.json stays portable/machine-independent: the logical token, not
    // a host-specific absolute path.
    assert.deepEqual(cmd, ['pompos', 'goal', 'tick', 'sweep']);
    // The absolute node + CLI entry is applied only where the OS scheduler
    // consumes it — resolveCommand, called inside buildPlist / buildCrontabLine
    // / runJob — so the bare-token PATH bug is fixed at the consumption boundary.
    const resolved = cronReal.resolveCommand(cmd);
    assert.equal(resolved[0], process.execPath, 'resolved command must start with the node binary');
    assert.ok(resolved[1].endsWith('cli.mjs'), 'resolved command must carry the CLI entry');
    assert.ok(!resolved.includes('pompos'), 'bare "pompos" token gone after resolution');
  } finally {
    if (prevSkip === undefined) delete process.env.LAZYCLAW_SKIP_CRON_INSTALL; else process.env.LAZYCLAW_SKIP_CRON_INSTALL = prevSkip;
  }
});

// ── BUG 3: dow=7 (Sunday) accepted and normalized to 0 ───────────────────────

test('parseCronSpec accepts dow=7 (Sunday) instead of throwing CRON_OUT_OF_RANGE', () => {
  assert.doesNotThrow(() => parseCronSpec('0 9 * * 7'));
  const parsed = parseCronSpec('0 9 * * 7');
  assert.equal(parsed.dow.kind, 'value');
  assert.equal(parsed.dow.value, 0, 'dow=7 must normalize to 0 (Sunday)');
});

test('buildPlist for "0 9 * * 7" emits Weekday=0 (Sunday)', () => {
  const ivs = intervalsOf(buildPlist('sun', '0 9 * * 7', ['x']));
  assert.deepEqual(ivs, [{ Minute: 0, Hour: 9, Weekday: 0 }]);
});

test('dow=7 still rejected when out of the 0-7 band (dow=8 throws)', () => {
  assert.throws(() => parseCronSpec('0 9 * * 8'), /out of range/);
});
