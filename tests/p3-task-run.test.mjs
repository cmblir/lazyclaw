// tests/p3-task-run.test.mjs — /task start + /task tick now run in the Ink
// chat (were stubs that told you to use the shell). start registers the task
// + posts the Slack kickoff; tick drives one multi-agent router turn, routing
// the router's logger output through the dispatcher write callback. Deps are
// injected via ctx so this tests without Slack / a real provider.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function makeCtx({ slackChannel = '' } = {}) {
  const store = { tasks: {} };
  let nextId = 1;
  const sent = [];
  const logged = [];
  class FakeSlack {
    constructor() {}
    async start() {}
    async send(ch, text) { sent.push({ ch, text }); return { ts: '1700.99' }; }
    async stop() {}
  }
  return {
    _sent: () => sent,
    _logged: () => logged.join(''),
    _task: (id) => store.tasks[id],
    cfgDir: '/tmp/lc-taskrun',
    SlackChannel: FakeSlack,
    resolveAuthKey: () => 'key-x',
    resolveBaseUrl: () => undefined,
    tasksMod: {
      registerTask: (t) => { const id = `t${nextId++}`; store.tasks[id] = { id, ...t }; return store.tasks[id]; },
      patchTask: (id, patch) => { store.tasks[id] = { ...store.tasks[id], ...patch }; return store.tasks[id]; },
      getTask: (id) => store.tasks[id],
      removeTask: (id) => { delete store.tasks[id]; },
      buildKickoffMessage: ({ title }) => `Kickoff: ${title}`,
      listTasks: () => Object.values(store.tasks),
      formatTranscript: () => '',
    },
    teamsMod: { getTeam: (n) => (n === 'red' ? { name: 'red', lead: 'alice', agents: ['alice', 'bob'], slackChannel } : null) },
    agentsMod: { getAgent: (n) => ({ name: n, displayName: n, provider: 'mock' }) },
    routerMod: {
      runTaskTurn: async ({ logger, task }) => {
        if (logger) logger('agent alice: working...\n');
        return { task: { ...task, status: 'running' }, iterations: 2, stoppedBy: 'max-turns' };
      },
    },
  };
}

test('/task start registers a task (no Slack channel → pending)', async () => {
  const ctx = makeCtx({ slackChannel: '' });
  const out = await dispatchSlash('/task', 'start red --title "Ship it"', ctx, () => {});
  assert.match(out, /started/);
  assert.match(out, /pending/);
  assert.equal(ctx._sent().length, 0);
  const t = ctx._task('t1');
  assert.equal(t.title, 'Ship it');
  assert.equal(t.team, 'red');
});

test('/task start with a Slack channel posts the kickoff + goes running', async () => {
  const ctx = makeCtx({ slackChannel: 'C100' });
  const out = await dispatchSlash('/task', 'start red --title "Ship it" --lead alice', ctx, () => {});
  assert.match(out, /running/);
  assert.equal(ctx._sent().length, 1);
  assert.match(ctx._sent()[0].text, /Kickoff: Ship it/);
  assert.equal(ctx._task('t1').slackThreadTs, '1700.99');
});

test('/task start usage error when missing team/title', async () => {
  const ctx = makeCtx();
  const out = await dispatchSlash('/task', 'start red', ctx, () => {});
  assert.match(out, /usage: \/task start/);
});

test('/task tick runs a router turn and streams the logger to write', async () => {
  const ctx = makeCtx({ slackChannel: 'C100' });
  await dispatchSlash('/task', 'start red --title "Ship it"', ctx, () => {});
  const writes = [];
  const out = await dispatchSlash('/task', 'tick t1 keep going', ctx, (c) => writes.push(c));
  assert.match(out, /running/);
  assert.match(out, /2 agent turn/);
  assert.ok(writes.join('').includes('agent alice'), 'router logger routed to write');
});

test('/task tick on a missing task errors cleanly', async () => {
  const ctx = makeCtx();
  const out = await dispatchSlash('/task', 'tick nope', ctx, () => {});
  assert.match(out, /no task/);
});
