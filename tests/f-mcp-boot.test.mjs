// tests/f-mcp-boot.test.mjs — mcp-boot: MCP support is implemented but never
// booted. Pins three gaps:
//   (a) nothing calls server_spawn.startConfigured at daemon boot;
//   (b) `pompos mcp list` subcommand did not exist;
//   (c) startConfigured actually registers an mcp:<server>:<tool> tool
//       (sensitive=true) into the registry via an injected fake transport.
//
// The daemon boot seam is makeHandler(ctx): it reads config once per process
// and is where startConfigured must fire. We drive makeHandler with a stub
// readConfig carrying cfg.mcp.servers and a fake MCP transport, then assert
// the configured server's tool lands in the registry, prefixed + sensitive.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeHandler } from '../daemon.mjs';
import * as mcpClient from '../mcp/client.mjs';
import * as registry from '../mas/tools/registry.mjs';
import * as toolsets from '../mas/toolsets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli.mjs');

function tmpCfgDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-mcp-'));
}

// makeHandler needs a minimally-viable ctx. The handler fn itself is never
// invoked here — we only exercise the one-shot boot side effect.
function bootCtx(cfg) {
  return {
    readConfig: () => cfg,
    sessionsDirGetter: () => tmpCfgDir(),
    sessionsMod: {},
    version: () => '0.0.0-test',
  };
}

// (a)+(c): makeHandler boot wires startConfigured, which registers the
// configured server's tools as mcp:<name>:<tool>, sensitive=true.
test('daemon boot calls startConfigured and registers mcp:<server>:<tool> (sensitive)', async () => {
  const fakeTools = [
    { name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: {} } },
  ];
  mcpClient.__setTransport({
    connect: async () => ({
      listTools: async () => ({ tools: fakeTools }),
      callTool: async ({ name, arguments: args }) => ({ content: [{ type: 'text', text: `${name}(${JSON.stringify(args)})` }] }),
      close: async () => {},
    }),
  });

  const cfg = { mcp: { servers: [{ name: 'bootfs', command: 'fake', args: [], allowGlob: '*' }] } };
  assert.ok(!registry.listNames().includes('mcp:bootfs:read_file'), 'precondition: not yet registered');

  makeHandler(bootCtx(cfg));

  // startConfigured is async; await one microtask flush + a tick so the
  // best-effort boot promise settles before we inspect the registry.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.ok(registry.listNames().includes('mcp:bootfs:read_file'), 'configured MCP tool registered at boot');
  const t = registry.lookup('mcp:bootfs:read_file');
  assert.equal(t.sensitive, true, 'MCP tool must stay sensitive (approval gate)');
  assert.equal(t.category, 'mcp:bootfs');

  // Clean up so the shared process-global registry/SERVERS map don't leak.
  await mcpClient.stopServer('bootfs');
  mcpClient.__setTransport(null);
});

// §8: a config-supplied sensitive:false must NOT downgrade an MCP tool out of
// the approval gate. startConfigured forces sensitive:true at boot regardless.
test('boot forces MCP tools sensitive even if config says sensitive:false', async () => {
  mcpClient.__setTransport({
    connect: async () => ({
      listTools: async () => ({ tools: [{ name: 'danger', description: 'x', inputSchema: { type: 'object', properties: {} } }] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
    }),
  });
  // Malicious/careless config tries to ungate the tool.
  const cfg = { mcp: { servers: [{ name: 'evil', command: 'fake', sensitive: false, allowGlob: '*' }] } };
  makeHandler(bootCtx(cfg));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const t = registry.lookup('mcp:evil:danger');
  assert.ok(t, 'tool registered');
  assert.equal(t.sensitive, true, 'config sensitive:false must be overridden to true (approval gate)');
  await mcpClient.stopServer('evil');
  mcpClient.__setTransport(null);
});

// A failing MCP server must NOT crash makeHandler — startConfigured catches
// per-server and the boot call is best-effort.
test('daemon boot survives a failing MCP server', async () => {
  mcpClient.__setTransport({
    connect: async () => { throw new Error('boom'); },
  });
  const cfg = { mcp: { servers: [{ name: 'broken', command: 'nope' }] } };
  assert.doesNotThrow(() => makeHandler(bootCtx(cfg)));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.ok(!mcpClient.listServers().some(s => s.name === 'broken'), 'failed server is not tracked');
  mcpClient.__setTransport(null);
});

// (c-toolsets): mcp:* names are accepted by the toolset store (free-string
// keys, no colon-rejecting validation). Guards against a future regression
// that would add a name regex blocking the mcp:<server>:<tool> shape.
test('toolsets accept an mcp:<server>:<tool> name', () => {
  const home = tmpCfgDir();
  toolsets.addToolset({ name: 'with-mcp', tools: ['read', 'mcp:bootfs:read_file'] }, { configDir: home });
  const resolved = toolsets.resolveToolset('with-mcp', { configDir: home });
  assert.ok(resolved.includes('mcp:bootfs:read_file'));
});

// (b): `pompos mcp list` exists, exits 0, and prints the configured servers
// from cfg.mcp.servers. Pre-fix the subcommand did not exist (exit 2).
test('CLI: `mcp list` prints configured servers and exits 0', () => {
  const dir = tmpCfgDir();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ mcp: { servers: [{ name: 'cfgserver', command: 'echo', args: ['hi'] }] } }),
  );
  const r = spawnSync(process.execPath, [CLI, 'mcp', 'list'], {
    env: { ...process.env, POMPOS_CONFIG_DIR: dir },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `mcp list should exit 0, got ${r.status}\n${r.stderr}`);
  assert.match(r.stdout, /cfgserver/, 'configured server name printed');
});

// §isError: MCP tool-level failures arrive as { isError:true } WITHOUT
// throwing. exec() only caught throws, so the agent received { ok:true } and
// reasoned forward on a failed operation. isError must map to a failure.
test('an MCP tool that returns isError surfaces as ok:false, not a silent success', async () => {
  mcpClient.__setTransport({
    connect: async () => ({
      listTools: async () => ({ tools: [{ name: 'do_thing', inputSchema: { type: 'object', properties: {} } }] }),
      callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'permission denied' }] }),
      close: async () => {},
    }),
  });
  await mcpClient.startServer({ name: 'errsrv', command: 'fake' });
  const tool = registry.lookup('mcp:errsrv:do_thing');
  const r = await tool.exec({});
  assert.equal(r.ok, false, 'isError:true must map to ok:false');
  assert.match(r.error, /permission denied/, 'error carries the tool failure text');
  await mcpClient.stopServer('errsrv');
  mcpClient.__setTransport(null);
});
