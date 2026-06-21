// tests/f-workflow-named.test.mjs
//
// Roadmap C-1 — the automation spine. A named declarative workflow lives in
// cfg.workflows[<name>] and runs by name (from the CLI, a cron job, or an
// inbound Slack message). Pure: no provider/network needed for a template def.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runNamedWorkflow, getNamedWorkflow, listNamedWorkflows, namedReplyText, validWorkflowName } from '../workflow/named.mjs';

const cfgWith = (workflows) => ({ workflows });

test('runNamedWorkflow runs a stored declarative def', async () => {
  const cfg = cfgWith({ daily: { def: { nodes: [{ id: 'msg', type: 'template', config: { text: 'good morning' } }] } } });
  const r = await runNamedWorkflow('daily', cfg, {});
  assert.equal(r.success, true);
  assert.equal(r.session.msg, 'good morning');
});

test('runNamedWorkflow throws for an unknown name', async () => {
  await assert.rejects(() => runNamedWorkflow('nope', cfgWith({}), {}), /no workflow named "nope"/);
});

test('getNamedWorkflow + listNamedWorkflows reflect the store', () => {
  const cfg = cfgWith({
    a: { def: { nodes: [{ id: 'x', type: 'set', config: { value: 1 } }] }, channel: 'slack:#a', schedule: '0 9 * * *' },
    b: { def: { nodes: [{ id: 'y', type: 'set', config: { value: 2 } }] } },
  });
  assert.ok(getNamedWorkflow(cfg, 'a'));
  assert.equal(getNamedWorkflow(cfg, 'missing'), null);
  const list = listNamedWorkflows(cfg);
  assert.deepEqual(list.map((w) => w.name), ['a', 'b']);
  assert.equal(list[0].channel, 'slack:#a');
  assert.equal(list[0].schedule, '0 9 * * *');
  assert.equal(list[0].nodes, 1);
});

test('namedReplyText picks replyNode, else the last node output', () => {
  const result = { session: { a: 'x', reply: 'the answer', b: 'y' } };
  assert.equal(namedReplyText(result, { replyNode: 'reply' }), 'the answer');
  assert.equal(namedReplyText(result, {}), 'y'); // last node
  assert.equal(namedReplyText({ session: { obj: { k: 1 } } }, {}), '{"k":1}'); // non-string → JSON
});

test('validWorkflowName mirrors the cron name grammar', () => {
  assert.ok(validWorkflowName('daily-report.v2'));
  assert.ok(!validWorkflowName('bad name'));
  assert.ok(!validWorkflowName(''));
  assert.ok(!validWorkflowName('a:b'));
});

import { workflowForChannel } from '../workflow/named.mjs';
import { runWorkflow } from '../workflow/declarative.mjs';

test('workflowForChannel resolves a channel-bound workflow', () => {
  const cfg = cfgWith({
    ops: { def: { nodes: [{ id: 'x', type: 'set', config: { value: 1 } }] }, channel: 'slack:#ops' },
    other: { def: { nodes: [{ id: 'y', type: 'set', config: { value: 2 } }] } },
  });
  assert.equal(workflowForChannel(cfg, '#ops')?.name, 'ops');
  assert.equal(workflowForChannel(cfg, 'ops')?.name, 'ops'); // bare name matches the stripped binding
  assert.equal(workflowForChannel(cfg, 'C999'), null);
  assert.equal(workflowForChannel(cfg, ''), null);
});

test('{{input}} resolves to the run input (the inbound message text)', async () => {
  const def = { nodes: [{ id: 'echo', type: 'template', config: { text: 'you said: {{input}}' } }] };
  const r = await runWorkflow(def, { input: 'deploy now' });
  assert.equal(r.session.echo, 'you said: deploy now');
});
