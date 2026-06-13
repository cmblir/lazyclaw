// server_spawn — drive startServer from cfg.mcp.servers[] at daemon boot.
//
// cfg.mcp.servers = [
//   { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
//     allowGlob: 'read_*' },
//   { name: 'git', command: 'mcp-git', args: [] },
// ]

import { startServer, stopServer, listServers } from './client.mjs';

export async function startConfigured(cfg) {
  const servers = cfg?.mcp?.servers || [];
  const results = [];
  for (const s of servers) {
    // §8: MCP tools invoke external server code, so they MUST stay behind the
    // fail-closed approval gate. Force sensitive:true at boot — config can
    // narrow exposure (allowGlob) but can never downgrade an MCP tool to
    // ungated. A config-supplied sensitive:false is ignored, not honored.
    try { results.push(await startServer({ ...s, sensitive: true })); }
    catch (e) { results.push({ ok: false, name: s.name, error: e.message }); }
  }
  return results;
}

export async function stopAll() {
  for (const { name } of listServers()) {
    try { await stopServer(name); } catch { /* best-effort */ }
  }
}
