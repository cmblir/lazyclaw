import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../mas/tools/registry.mjs';
import { runTool } from '../mas/tool_runner.mjs';
import * as toolsets from '../mas/toolsets.mjs';
import * as mcp from '../mcp/client.mjs';

test('45+ tools registered (built-in)', () => {
  const builtin = registry.listAll().filter(t => !t.name.startsWith('mcp:'));
  assert.ok(builtin.length >= 45, `expected >= 45 built-in tools, got ${builtin.length}: ${builtin.map(t=>t.name).join(', ')}`);
});

test('all required v5 names present', () => {
  const names = new Set(registry.listNames());
  const required = [
    // bash group
    'bash','read','write','edit','patch','grep',
    // recall + learning
    'recall','skill_view','skill_create','skill_edit','memory_write','memory_read','user_view','user_update',
    // web
    'web_fetch','web_search','url_extract',
    // os
    'clipboard_read','clipboard_write','screenshot','notify','open_url','file_dialog',
    // coding
    'python_exec','node_exec','sql_query','http_request','regex_match',
    // git
    'git_status','git_diff','git_log','git_blame','git_branch','git_commit','git_push',
    // scheduling
    'cron_add','cron_remove','cron_list',
    // delegation + clarify
    'task_spawn','delegate','clarify',
    // media + ha
    'image_describe','image_generate','tts_speak','transcribe','ha_call_service','ha_get_state',
    // browser
    'browser_navigate','browser_click','browser_back','browser_screenshot',
  ];
  for (const n of required) assert.ok(names.has(n), `missing tool: ${n}`);
});

test('every sensitive tool is approve-gated by tool_runner', async () => {
  const agent = { name: 'tester', tools: ['bash', 'edit', 'web_fetch', 'git_commit'] };
  const calls = [];
  const approve = async (info) => { calls.push(info); return { approved: false, reason: 'test denial' }; };
  for (const tool of agent.tools) {
    const r = await runTool({ agent, tool, args: { command: 'echo', path: 'x', url: 'https://example.com', message: 'm' }, approve });
    assert.equal(r.ok, false, `${tool} should be denied`);
    assert.match(r.error, /denied/i);
  }
  assert.equal(calls.length, 4);
});

test('toolset assignment yields valid agent.tools', () => {
  const tools = toolsets.resolveToolset('coding-min');
  for (const t of tools) assert.ok(registry.lookup(t), `coding-min toolset names unknown tool: ${t}`);
});

test('MCP server spawn + register round-trip', async () => {
  mcp.__setTransport({
    connect: async () => ({
      listTools: async () => ({ tools: [{ name: 'fs_read', inputSchema: { type: 'object' } }] }),
      callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      close: async () => {},
    }),
  });
  await mcp.startServer({ name: 'acceptance-fs', command: 'fake' });
  assert.ok(registry.lookup('mcp:acceptance-fs:fs_read'));
  await mcp.stopServer('acceptance-fs');
  mcp.__setTransport(null);
});
