// tests/p3-goal-cron.test.mjs — P3 restore: /goal add --cron actually
// attaches a schedule and /goal close detaches it. The Ink _goal stored the
// cron string but never scheduled anything (stub) and never detached on close.
// The attach/detach core is extracted DI'd so it tests with a fake cron.

import test from 'node:test';
import assert from 'node:assert/strict';

import { attachGoalCron, detachGoalCron } from '../goals_cron.mjs';

function fakeCron() {
  const log = [];
  return {
    log,
    parseCronSpec: (s) => { if (!s) throw new Error('empty spec'); return s; },
    upsertJob: (cfg, jobName, schedule, cmd) => {
      cfg.cron = cfg.cron || {};
      cfg.cron[jobName] = { schedule, cmd };
      log.push(['upsert', jobName]);
    },
    removeJob: (cfg, jobName) => { delete (cfg.cron || {})[jobName]; log.push(['remove', jobName]); },
    pickBackend: () => 'crontab',
    installCrontabJob: (jobName) => log.push(['install', jobName]),
    uninstallCrontabJob: (jobName) => log.push(['uninstall', jobName]),
    installLaunchdJob: (jobName) => log.push(['install-launchd', jobName]),
    uninstallLaunchdJob: (jobName) => log.push(['uninstall-launchd', jobName]),
  };
}

function io(initial = {}) {
  let store = JSON.parse(JSON.stringify(initial));
  return {
    readConfig: () => JSON.parse(JSON.stringify(store)),
    writeConfig: (c) => { store = JSON.parse(JSON.stringify(c)); },
    peek: () => store,
  };
}

test('attachGoalCron validates, persists cfg.cron, and installs the backend job', async () => {
  const cron = fakeCron();
  const c = io();
  const r = await attachGoalCron({ readConfig: c.readConfig, writeConfig: c.writeConfig, cron, name: 'sweep', schedule: '0 9 * * *' });
  assert.equal(r.jobName, 'goal-sweep');
  assert.equal(r.skipped, false);
  assert.equal(c.peek().cron['goal-sweep'].schedule, '0 9 * * *');
  assert.deepEqual(cron.log, [['upsert', 'goal-sweep'], ['install', 'goal-sweep']]);
});

test('attachGoalCron rejects an invalid spec before writing', async () => {
  const cron = fakeCron();
  const c = io();
  await assert.rejects(() => attachGoalCron({ readConfig: c.readConfig, writeConfig: c.writeConfig, cron, name: 'x', schedule: '' }), /empty spec/);
  assert.equal(c.peek().cron, undefined);
});

test('detachGoalCron removes the job + uninstalls; no-op when absent', async () => {
  const cron = fakeCron();
  const c = io({ cron: { 'goal-sweep': { schedule: '0 9 * * *' } } });
  const removed = await detachGoalCron({ readConfig: c.readConfig, writeConfig: c.writeConfig, cron, name: 'sweep' });
  assert.equal(removed, true);
  assert.equal(c.peek().cron['goal-sweep'], undefined);
  assert.ok(cron.log.some((e) => e[0] === 'uninstall'));

  const cron2 = fakeCron();
  const absent = await detachGoalCron({ readConfig: c.readConfig, writeConfig: c.writeConfig, cron: cron2, name: 'nope' });
  assert.equal(absent, false);
  assert.equal(cron2.log.length, 0);
});
