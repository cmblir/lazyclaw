// tests/f-workflow-automation.test.mjs
//
// Roadmap C — Hermes-style automation. A stored named workflow runs by name
// from the CLI or a cron job and posts its reply to the bound Slack channel.
// runNamedAndReport (in-process, injected sender) + attachWorkflowCron (cron
// wiring, skip real install) are tested directly; the CLI add/list/run/remove
// round-trip is tested via spawnSync.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runNamedAndReport } from '../commands/workflow_named.mjs';
import { attachWorkflowCron } from '../workflow/named_cron.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-wfauto-'));
// LAZYCLAW_SKIP_CRON_INSTALL is forced so a `--cron` add never touches the real
// launchd/crontab during tests (config is still written).
const runCli = (args, dir) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, LAZYCLAW_CONFIG_DIR: dir, LAZYCLAW_SKIP_CRON_INSTALL: '1' }, encoding: 'utf8' });

test('runNamedAndReport runs a named workflow and posts the reply to the bound channel', async () => {
  const sent = [];
  const sender = { send: async (ch, text) => { sent.push({ ch, text }); return { ts: '1.2' }; }, stop: async () => {} };
  const cfg = { workflows: { hello: { def: { nodes: [{ id: 'reply', type: 'template', config: { text: 'hi there' } }] }, channel: 'slack:#general', replyNode: 'reply' } } };
  const { reply, post } = await runNamedAndReport('hello', cfg, { makeSender: async () => sender });
  assert.equal(reply, 'hi there');
  assert.equal(post.posted, true);
  assert.equal(post.ts, '1.2');
  assert.deepEqual(sent, [{ ch: '#general', text: 'hi there' }]);
});

test('runNamedAndReport does not post when the workflow has no bound channel', async () => {
  const cfg = { workflows: { x: { def: { nodes: [{ id: 'm', type: 'template', config: { text: 'q' } }] } } } };
  const { reply, post } = await runNamedAndReport('x', cfg, { makeSender: async () => { throw new Error('should not build a sender'); } });
  assert.equal(reply, 'q');
  assert.equal(post.posted, false);
});

test('attachWorkflowCron installs a wf-<name> job that runs the workflow', () => {
  let written = null;
  const cron = {
    parseCronSpec: () => {}, pickBackend: () => 'crontab',
    upsertJob: (cfg, jobName, schedule, cmd) => { cfg.cron = cfg.cron || {}; cfg.cron[jobName] = { schedule, command: cmd }; },
    installCrontabJob: () => {}, installLaunchdJob: () => {},
  };
  const r = attachWorkflowCron('daily', '0 9 * * *', { cron, readConfig: () => ({}), writeConfig: (c) => { written = c; } });
  assert.equal(r.jobName, 'wf-daily');
  assert.deepEqual(written.cron['wf-daily'], { schedule: '0 9 * * *', command: ['pompos', 'workflow', 'run', 'daily'] });
});

test('CLI: workflow add → list → run (no channel) → remove', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  fs.writeFileSync(path.join(dir, 'wf.json'), JSON.stringify({ nodes: [{ id: 'msg', type: 'template', config: { text: 'hello cron' } }] }));

  const add = runCli(['workflow', 'add', 'greet', path.join(dir, 'wf.json')], dir);
  assert.equal(add.status, 0, `add stderr=${add.stderr}`);
  assert.equal(JSON.parse(add.stdout).added, 'greet');

  const list = JSON.parse(runCli(['workflow', 'list'], dir).stdout);
  assert.ok(list.workflows.find((w) => w.name === 'greet'), 'list shows the workflow');

  const run = JSON.parse(runCli(['workflow', 'run', 'greet'], dir).stdout);
  assert.equal(run.success, true);
  assert.equal(run.reply, 'hello cron');
  assert.equal(run.post.posted, false, 'no channel bound → no post');

  const rm = runCli(['workflow', 'remove', 'greet'], dir);
  assert.equal(rm.status, 0);
  assert.ok(!JSON.parse(runCli(['workflow', 'list'], dir).stdout).workflows.find((w) => w.name === 'greet'), 'removed');
});

test('CLI: workflow add with --cron installs a cron job (skip real install)', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  fs.writeFileSync(path.join(dir, 'wf.json'), JSON.stringify({ nodes: [{ id: 'm', type: 'template', config: { text: 'tick' } }] }));
  const add = runCli(['workflow', 'add', 'sched', path.join(dir, 'wf.json'), '--cron', '0 9 * * *'], dir);
  assert.equal(add.status, 0, `add stderr=${add.stderr}`);
  assert.equal(JSON.parse(add.stdout).schedule, '0 9 * * *');
  // The cron job was registered in config.
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.cron['wf-sched'].command, ['pompos', 'workflow', 'run', 'sched']);
});
