// P0 security — sensitive tools are fail-closed.
//
// A sensitive tool (here: write) must NOT run unless an approval hook
// grants it, or the operator has explicitly set
// security.allowUnattendedSensitive. A missing hook denies by default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { runTool } from '../mas/tool_runner.mjs';
import { makeReadlineApprove } from '../tui/terminal_approve.mjs';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`)); }
const agent = { name: 't', tools: ['write', 'read'] };

test('sensitive tool with no approve hook and no opt-in is denied (fail-closed)', async () => {
  const cwd = tmp('p0-deny'); const cfg = tmp('p0-deny-cfg');
  const r = await runTool({ agent, tool: 'write', args: { path: 'x.txt', content: 'A' }, cwd, configDir: cfg });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TOOL_DENIED_NO_APPROVER');
  assert.equal(fs.existsSync(path.join(cwd, 'x.txt')), false, 'file must not be written when denied');
});

test('security.allowUnattendedSensitive=true lets a sensitive tool run unattended', async () => {
  const cwd = tmp('p0-unattended'); const cfg = tmp('p0-unattended-cfg');
  const r = await runTool({ agent, tool: 'write', args: { path: 'x.txt', content: 'A' }, cwd, configDir: cfg, security: { allowUnattendedSensitive: true } });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'x.txt'), 'utf8'), 'A');
});

test('an approve hook that denies blocks the tool (TOOL_DENIED_APPROVAL)', async () => {
  const cwd = tmp('p0-approve-no'); const cfg = tmp('p0-approve-no-cfg');
  const r = await runTool({ agent, tool: 'write', args: { path: 'x.txt', content: 'A' }, cwd, configDir: cfg, approve: async () => ({ approved: false, reason: 'nope' }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TOOL_DENIED_APPROVAL');
  assert.equal(fs.existsSync(path.join(cwd, 'x.txt')), false);
});

test('an approve hook that grants lets the tool run', async () => {
  const cwd = tmp('p0-approve-yes'); const cfg = tmp('p0-approve-yes-cfg');
  const r = await runTool({ agent, tool: 'write', args: { path: 'x.txt', content: 'A' }, cwd, configDir: cfg, approve: async () => ({ approved: true }) });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'x.txt'), 'utf8'), 'A');
});

test('a read-only tool is never gated, even with no approve hook', async () => {
  const cwd = tmp('p0-read'); const cfg = tmp('p0-read-cfg');
  fs.writeFileSync(path.join(cwd, 'y.txt'), 'hello');
  const r = await runTool({ agent, tool: 'read', args: { path: 'y.txt' }, cwd, configDir: cfg });
  assert.equal(r.ok, true);
  assert.equal(r.content, 'hello');
});

test('makeReadlineApprove: y approves, blank denies, non-TTY denies', async () => {
  // non-TTY → immediate deny
  const noTty = new PassThrough();
  const denyHook = makeReadlineApprove({ input: noTty, output: new PassThrough(), timeoutMs: 1000 });
  assert.equal((await denyHook({ tool: 'bash', args: {}, agent: 'a' })).approved, false);

  // TTY + "y" → approve
  const yIn = new PassThrough(); yIn.isTTY = true;
  const yHook = makeReadlineApprove({ input: yIn, output: new PassThrough(), timeoutMs: 2000 });
  const yP = yHook({ tool: 'bash', args: { command: 'ls' }, agent: 'a' });
  yIn.write('y\n');
  assert.equal((await yP).approved, true);

  // TTY + blank line → deny (default)
  const nIn = new PassThrough(); nIn.isTTY = true;
  const nHook = makeReadlineApprove({ input: nIn, output: new PassThrough(), timeoutMs: 2000 });
  const nP = nHook({ tool: 'bash', args: { command: 'ls' }, agent: 'a' });
  nIn.write('\n');
  assert.equal((await nP).approved, false);
});
