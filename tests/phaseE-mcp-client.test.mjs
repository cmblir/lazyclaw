import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mcp from '../mcp/client.mjs';
import * as registry from '../mas/tools/registry.mjs';

test('exports startServer / stopServer / listServers', () => {
  assert.equal(typeof mcp.startServer, 'function');
  assert.equal(typeof mcp.stopServer, 'function');
  assert.equal(typeof mcp.listServers, 'function');
});

test('startServer registers a prefixed tool via injected transport', async () => {
  const fakeTools = [
    { name: 'read_file',  description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'write_file', description: 'Write', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  ];
  mcp.__setTransport({
    connect: async () => ({
      listTools: async () => ({ tools: fakeTools }),
      callTool: async ({ name, arguments: args }) => ({ content: [{ type: 'text', text: `${name}(${JSON.stringify(args)})` }] }),
      close: async () => {},
    }),
  });

  await mcp.startServer({ name: 'fs', command: 'fake', args: [], allowGlob: '*' });

  const all = registry.listNames();
  assert.ok(all.includes('mcp:fs:read_file'));
  assert.ok(all.includes('mcp:fs:write_file'));

  const t = registry.lookup('mcp:fs:read_file');
  assert.equal(t.sensitive, true);                  // MCP tools default sensitive
  assert.equal(t.category, 'mcp:fs');

  const r = await t.exec({ path: 'x' });
  assert.equal(r.ok, true);
  assert.match(r.text, /read_file/);

  await mcp.stopServer('fs');
  assert.ok(!registry.listNames().includes('mcp:fs:read_file'));
  mcp.__setTransport(null);
});

test('allowGlob filters which tools register', async () => {
  mcp.__setTransport({
    connect: async () => ({
      listTools: async () => ({ tools: [{ name: 'read_file' }, { name: 'shell_exec' }] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    }),
  });
  await mcp.startServer({ name: 'safe', command: 'x', allowGlob: 'read_*' });
  const names = registry.listNames();
  assert.ok(names.includes('mcp:safe:read_file'));
  assert.ok(!names.includes('mcp:safe:shell_exec'));
  await mcp.stopServer('safe');
  mcp.__setTransport(null);
});
