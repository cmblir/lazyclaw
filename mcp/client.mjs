// MCP client — spawn external MCP servers over stdio, list their tools,
// and register each one in mas/tools/registry.mjs with a stable prefix
// ("mcp:<server>:<tool>"). Defaults: sensitive=true (so the approve hook
// gates every external call), category="mcp:<server>". Per-server
// allowGlob narrows which tools are exposed.
//
// The real transport uses @modelcontextprotocol/sdk's StdioClientTransport;
// tests inject a fake transport via __setTransport so the spec can run
// without the binary.

import * as registry from '../mas/tools/registry.mjs';

let _transport = null;
export function __setTransport(t) { _transport = t; }

const SERVERS = new Map();  // name -> { client, tools }

function matchGlob(name, glob) {
  if (!glob || glob === '*') return true;
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(name);
}

async function realTransport({ command, args, env }) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command, args: args || [], env });
  const client = new Client({ name: 'lazyclaw', version: '5.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    listTools: () => client.listTools(),
    callTool: (req) => client.callTool(req),
    close:    () => client.close(),
  };
}

export async function startServer({ name, command, args = [], env = {}, allowGlob = '*', sensitive = true } = {}) {
  if (!name || !command) throw new Error('startServer: name + command required');
  if (SERVERS.has(name)) throw new Error(`startServer: server "${name}" already running`);

  const transport = _transport || { connect: realTransport };
  const client = await transport.connect({ command, args, env });
  const { tools = [] } = await client.listTools();

  const registered = [];
  for (const t of tools) {
    if (!matchGlob(t.name, allowGlob)) continue;
    const toolName = `mcp:${name}:${t.name}`;
    const rec = {
      name: toolName,
      category: `mcp:${name}`,
      sensitive,
      description: t.description || `MCP tool ${t.name} on server ${name}`,
      parameters: t.inputSchema || { type: 'object', properties: {} },
      async exec(callArgs) {
        try {
          const res = await client.callTool({ name: t.name, arguments: callArgs || {} });
          const text = (res?.content || [])
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
          return { ok: true, text, raw: res };
        } catch (e) {
          return { ok: false, error: `${toolName}: ${e.message}` };
        }
      },
    };
    registry.register(rec);
    registered.push(toolName);
  }

  SERVERS.set(name, { client, tools: registered });
  return { ok: true, name, tools: registered };
}

export async function stopServer(name) {
  const entry = SERVERS.get(name);
  if (!entry) return { ok: false, error: `stopServer: ${name} not running` };
  for (const toolName of entry.tools) registry.unregister(toolName);
  try { await entry.client.close(); } catch { /* best-effort */ }
  SERVERS.delete(name);
  return { ok: true, name };
}

export function listServers() {
  return [...SERVERS.entries()].map(([name, e]) => ({ name, toolCount: e.tools.length }));
}
