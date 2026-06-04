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
    try { results.push(await startServer(s)); }
    catch (e) { results.push({ ok: false, name: s.name, error: e.message }); }
  }
  return results;
}

export async function stopAll() {
  for (const { name } of listServers()) {
    try { await stopServer(name); } catch { /* best-effort */ }
  }
}
