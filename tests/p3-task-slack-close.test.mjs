// tests/p3-task-slack-close.test.mjs — /task abandon|done in the Ink chat only
// flipped status; it dropped the Slack closing post the CLI's cmdTask sends,
// so collaborators watching the thread never saw the resolution. Restore it
// (best-effort, never rolls back the status change). SlackChannel is injected
// via ctx so the post path tests without a real workspace.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function makeCtx(task) {
  let current = { ...task };
  const sent = [];
  class FakeSlack {
    constructor() {}
    async start() {}
    async send(threadId, msg) { sent.push({ threadId, msg }); }
    async stop() {}
  }
  return {
    _sent: () => sent,
    cfgDir: '/tmp/lc-task-test',
    SlackChannel: FakeSlack,
    tasksMod: {
      patchTask: (id, patch) => { current = { ...current, ...patch }; return current; },
      getTask: () => current,
      listTasks: () => [current],
      removeTask: () => current,
      formatTranscript: () => '',
    },
  };
}

test('/task done posts a closing message to the bound Slack thread', async () => {
  const ctx = makeCtx({ id: 't1', title: 'Ship it', slackChannel: 'C123', slackThreadTs: '1700000000.1' });
  const out = await dispatchSlash('/task', 'done t1', ctx);
  assert.match(out, /t1 → done/);
  const sent = ctx._sent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, 'C123:1700000000.1');
  assert.match(sent[0].msg, /done/i);
});

test('/task abandon posts an abandoned message', async () => {
  const ctx = makeCtx({ id: 't2', title: 'Spike', slackChannel: 'C9', slackThreadTs: '1700000001.2' });
  const out = await dispatchSlash('/task', 'abandon t2', ctx);
  assert.match(out, /t2 → abandoned/);
  assert.match(ctx._sent()[0].msg, /abandon/i);
});

test('/task done on a non-Slack task changes status without posting', async () => {
  const ctx = makeCtx({ id: 't3', title: 'Local only' });
  const out = await dispatchSlash('/task', 'done t3', ctx);
  assert.match(out, /t3 → done/);
  assert.equal(ctx._sent().length, 0);
});
