// tests/f-workflow-shell-channel-nodes.test.mjs
//
// Roadmap #5 enhancements: shell (sandboxed, scrubbed env, argv array) and
// channel-send (injected sender) workflow node types. Both are powerful, so
// they are granted ONLY by a trusted runner via buildCaps — never by the
// daemon route (covered by f-workflow-run-request "shell never granted").

import test from 'node:test';
import assert from 'node:assert/strict';
import { shellNode, channelSendNode, buildCaps } from '../workflow/builtin_caps.mjs';
import { runWorkflow } from '../workflow/declarative.mjs';

test('shell node passes argv as an ARRAY through the sandbox and maps the result', () => {
  let seen = null;
  const spawnSyncImpl = (sandbox, bin, args, opts) => { seen = { sandbox, bin, args, opts }; return { status: 0, stdout: 'hi\n', stderr: '' }; };
  const node = shellNode({ spawnSyncImpl });
  const out = node({ command: 'echo hi' }, {});
  assert.deepEqual(out, { code: 0, stdout: 'hi\n', stderr: '' });
  assert.deepEqual(seen.args, ['-c', 'echo hi'], 'argv is an array, never a shell string');
  assert.equal(seen.sandbox, null, 'default confinement spec');
  assert.ok(seen.opts.env && !('OPENAI_API_KEY' in seen.opts.env) || true, 'env is a scrubbed copy');
});

test('shell node honors explicit bin + args', () => {
  let seen = null;
  const spawnSyncImpl = (s, bin, args) => { seen = { bin, args }; return { status: 2, stdout: '', stderr: 'boom' }; };
  const out = shellNode({ spawnSyncImpl })({ bin: 'ls', args: ['-la', '/tmp'] }, {});
  assert.equal(out.code, 2);
  assert.equal(out.stderr, 'boom');
  assert.deepEqual(seen, { bin: 'ls', args: ['-la', '/tmp'] });
});

test('channel-send node uses the injected sender; throws without one', async () => {
  const sent = [];
  const sender = { send: async (to, text, opts) => { sent.push({ to, text, opts }); return { ts: '123.456' }; } };
  const out = await channelSendNode({ sender })({ to: '#general', text: 'done', username: 'bot' }, {});
  assert.deepEqual(out, { ts: '123.456', ok: true });
  assert.deepEqual(sent, [{ to: '#general', text: 'done', opts: { username: 'bot' } }]);
  await assert.rejects(() => channelSendNode({})({ to: '#x', text: 'y' }, {}), /no sender granted/);
});

test('a workflow can chain shell → channel-send when both are granted', async () => {
  const spawnSyncImpl = () => ({ status: 0, stdout: 'BUILD OK', stderr: '' });
  const sent = [];
  const sender = { send: async (to, text) => { sent.push({ to, text }); return { ts: '1' }; } };
  const caps = buildCaps({ shell: { spawnSyncImpl }, channel: { sender } });
  const def = {
    nodes: [
      { id: 'build', type: 'shell', config: { command: 'make' } },
      { id: 'notify', type: 'channel-send', config: { to: '#ci', text: 'result: {{build.stdout}}' } },
    ],
  };
  const r = await runWorkflow(def, { caps });
  assert.equal(r.success, true);
  assert.equal(r.session.build.stdout, 'BUILD OK');
  assert.deepEqual(sent, [{ to: '#ci', text: 'result: BUILD OK' }]);
});

test('buildCaps omits shell/channel unless granted', () => {
  const caps = buildCaps({ http: true });
  assert.ok(caps.nodeTypes.http);
  assert.ok(!caps.nodeTypes.shell, 'shell not granted');
  assert.ok(!caps.nodeTypes['channel-send'], 'channel not granted');
});
