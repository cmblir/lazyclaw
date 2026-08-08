// tests/f-mcp-cli.test.mjs
//
// `pompos mcp` shipped read-only (`list` only); add/remove were "config JSON
// by hand" and there was no way to invoke a tool from the CLI. These pin the
// follow-up: `mcp add/remove/list/call`. add/remove mutate cfg.mcp.servers
// (atomic 0600 writeConfig); list shows configured + connected; call spawns the
// server in-process, runs one tool through the registry, and tears it down.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cmdMcp } from '../commands/mcp.mjs';
import * as mcpClient from '../mcp/client.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const tmpCfgDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-mcpcli-'));
const runCli = (args, dir) => spawnSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, POMPOS_CONFIG_DIR: dir }, encoding: 'utf8',
});
const seed = (dir, cfg) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));

test('mcp add persists a server and list shows it under configured', () => {
  const dir = tmpCfgDir();
  const add = runCli(['mcp', 'add', 'fsx', '--command', 'npx', '--args', '-y server-fs /tmp', '--allow-glob', 'read_*'], dir);
  assert.equal(add.status, 0, `add should exit 0; stderr=${add.stderr}`);
  const list = runCli(['mcp', 'list'], dir);
  assert.equal(list.status, 0);
  const out = JSON.parse(list.stdout);
  const found = out.configured.find((s) => s.name === 'fsx');
  assert.ok(found, `list must show the added server; got ${list.stdout}`);
  assert.equal(found.command, 'npx');
  assert.deepEqual(found.args, ['-y', 'server-fs', '/tmp']);
  assert.equal(found.allowGlob, 'read_*');
});

test('mcp add rejects a duplicate name', () => {
  const dir = tmpCfgDir();
  seed(dir, { mcp: { servers: [{ name: 'dup', command: 'echo' }] } });
  const r = runCli(['mcp', 'add', 'dup', '--command', 'echo'], dir);
  assert.notEqual(r.status, 0, 'adding a duplicate name must fail');
  assert.match(r.stderr, /already exists|duplicate/i);
});

test('mcp add rejects a missing command and a bad name', () => {
  const dir = tmpCfgDir();
  const noCmd = runCli(['mcp', 'add', 'srv'], dir);
  assert.equal(noCmd.status, 2, 'missing --command is a usage error (exit 2)');
  const badName = runCli(['mcp', 'add', 'bad:name', '--command', 'echo'], dir);
  assert.equal(badName.status, 2, 'a colon in the name (tool namespace separator) is rejected');
});

test('mcp remove deletes a configured server', () => {
  const dir = tmpCfgDir();
  seed(dir, { mcp: { servers: [{ name: 'gone', command: 'echo' }, { name: 'keep', command: 'echo' }] } });
  const rm = runCli(['mcp', 'remove', 'gone'], dir);
  assert.equal(rm.status, 0, `remove should exit 0; stderr=${rm.stderr}`);
  const list = JSON.parse(runCli(['mcp', 'list'], dir).stdout);
  assert.ok(!list.configured.find((s) => s.name === 'gone'), 'removed server must be gone');
  assert.ok(list.configured.find((s) => s.name === 'keep'), 'other servers untouched');
});

test('mcp remove of an unknown server fails', () => {
  const dir = tmpCfgDir();
  seed(dir, { mcp: { servers: [] } });
  const r = runCli(['mcp', 'remove', 'ghost'], dir);
  assert.notEqual(r.status, 0, 'removing a non-existent server must fail');
});

test('mcp call spawns the server, runs the tool, and returns its result', async () => {
  const dir = tmpCfgDir();
  seed(dir, { mcp: { servers: [{ name: 'fs', command: 'fake', args: [], allowGlob: '*' }] } });
  const prevDir = process.env.POMPOS_CONFIG_DIR;
  process.env.POMPOS_CONFIG_DIR = dir;
  mcpClient.__setTransport({
    connect: async () => ({
      listTools: async () => ({ tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] }),
      callTool: async ({ name, arguments: a }) => ({ content: [{ type: 'text', text: `${name}(${JSON.stringify(a)})` }] }),
      close: async () => {},
    }),
  });
  const origWrite = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (s) => { out += s; return true; };
  try {
    await cmdMcp('call', ['fs', 'read_file'], { 'args-json': '{"path":"/x"}' });
  } finally {
    process.stdout.write = origWrite;
    mcpClient.__setTransport(null);
    if (prevDir === undefined) delete process.env.POMPOS_CONFIG_DIR; else process.env.POMPOS_CONFIG_DIR = prevDir;
  }
  const res = JSON.parse(out);
  assert.equal(res.ok, true, `call should succeed; got ${out}`);
  assert.match(res.text, /read_file\(\{"path":"\/x"\}\)/, 'tool result text returned');
  assert.equal(mcpClient.listServers().length, 0, 'call must stop the server it spawned (no leak)');
});

test('mcp call of an unknown server fails cleanly', () => {
  const dir = tmpCfgDir();
  seed(dir, { mcp: { servers: [] } });
  const r = runCli(['mcp', 'call', 'nope', 'sometool'], dir);
  assert.notEqual(r.status, 0, 'calling a tool on an unconfigured server must fail');
});
