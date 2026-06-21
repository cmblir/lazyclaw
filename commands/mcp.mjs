// commands/mcp.mjs — `lazyclaw mcp <list|add|remove|call>`.
//
// MCP servers are stored in cfg.mcp.servers[] (stdio transport only; an entry
// is { name, command, args[], env{}, allowGlob }). They are spawned at daemon
// boot by mcp/server_spawn.startConfigured. This command manages that list and
// lets you invoke a single tool from the CLI for a quick check.
//
// Verb dispatch + output convention mirror commands/agents.mjs cmdTeam:
// success → JSON on stdout, usage/validation errors → console.error + exit 2,
// operational failures → exit 1.

import { readConfig, writeConfig } from '../lib/config.mjs';

// The name becomes the tool namespace `mcp:<name>:<tool>`, so it must not carry
// a colon or whitespace — reuse the cron/job name grammar.
const NAME_RE = /^[A-Za-z0-9_.-]+$/;

const emitJson = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

// `--args "-y pkg /tmp"` and `--env "K=V K2=V2"` arrive as one whitespace-
// joined string (parseArgs consumes a single argv token), so split on spaces.
function splitWords(raw) {
  if (raw === undefined || raw === null || raw === true) return [];
  return String(raw).split(/\s+/).filter(Boolean);
}
function parseEnv(raw) {
  const env = {};
  for (const pair of splitWords(raw)) {
    const i = pair.indexOf('=');
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return env;
}

export async function cmdMcp(sub, positional = [], flags = {}) {
  const cfg = readConfig();
  const servers = (cfg.mcp && Array.isArray(cfg.mcp.servers)) ? cfg.mcp.servers : [];

  switch (sub) {
    case undefined:
    case 'list': {
      const configured = servers.map((s) => ({
        name: s.name, command: s.command, args: s.args || [], allowGlob: s.allowGlob || '*',
      }));
      // listServers() reports servers connected in THIS process; the short-lived
      // CLI never boots them, so this is normally empty — surfaced anyway so the
      // same shape works when the command runs inside the daemon.
      let connected = [];
      try { connected = (await import('../mcp/client.mjs')).listServers(); }
      catch { /* mcp client unavailable — report configured only */ }
      emitJson({ ok: true, configured, connected });
      return;
    }

    case 'add': {
      const name = positional[0];
      const command = flags.command;
      if (!name || !command || command === true) {
        console.error('Usage: lazyclaw mcp add <name> --command <cmd> [--args "<a b c>"] [--allow-glob <glob>] [--env "K=V ..."]');
        process.exit(2);
      }
      if (!NAME_RE.test(name)) {
        console.error(`mcp add: invalid name "${name}" — letters/digits/.-_ only (it becomes the tool namespace mcp:${name}:<tool>)`);
        process.exit(2);
      }
      if (servers.find((s) => s.name === name)) {
        console.error(`mcp add: server "${name}" already exists — remove it first or pick another name`);
        process.exit(2);
      }
      const record = {
        name,
        command: String(command),
        args: splitWords(flags.args),
        allowGlob: (flags['allow-glob'] && flags['allow-glob'] !== true) ? String(flags['allow-glob']) : '*',
      };
      const env = parseEnv(flags.env);
      if (Object.keys(env).length) record.env = env;
      cfg.mcp = cfg.mcp || {};
      cfg.mcp.servers = servers.concat([record]);
      writeConfig(cfg);
      emitJson({ ok: true, added: record });
      return;
    }

    case 'remove':
    case 'rm':
    case 'delete': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw mcp remove <name>'); process.exit(2); }
      if (!servers.find((s) => s.name === name)) {
        console.error(`mcp remove: no configured server "${name}"`);
        process.exit(2);
      }
      cfg.mcp = cfg.mcp || {};
      cfg.mcp.servers = servers.filter((s) => s.name !== name);
      writeConfig(cfg);
      emitJson({ ok: true, removed: name });
      return;
    }

    case 'call': {
      const server = positional[0];
      const toolName = positional[1];
      if (!server || !toolName) {
        console.error('Usage: lazyclaw mcp call <server> <tool> [--args-json \'{"k":"v"}\']');
        process.exit(2);
      }
      const sconf = servers.find((s) => s.name === server);
      if (!sconf) {
        console.error(`mcp call: no configured server "${server}" — add it with 'lazyclaw mcp add ${server} --command <cmd>'`);
        process.exit(2);
      }
      let args = {};
      if (flags['args-json'] !== undefined && flags['args-json'] !== true) {
        try { args = JSON.parse(String(flags['args-json'])); }
        catch (e) { console.error(`mcp call: --args-json is not valid JSON: ${e.message}`); process.exit(2); }
      }
      const mcpClient = await import('../mcp/client.mjs');
      const registry = await import('../mas/tools/registry.mjs');
      let started = false;
      try {
        // sensitive:true — the same approval-gate invariant the daemon boot
        // enforces (server_spawn). A CLI call can never downgrade an MCP tool.
        await mcpClient.startServer({
          name: sconf.name, command: sconf.command, args: sconf.args || [],
          env: sconf.env || {}, allowGlob: sconf.allowGlob || '*', sensitive: true,
        });
        started = true;
        const full = `mcp:${server}:${toolName}`;
        const tool = registry.lookup(full);
        if (!tool) {
          const available = registry.listNames().filter((n) => n.startsWith(`mcp:${server}:`));
          console.error(`mcp call: tool "${full}" not found. Available: ${available.join(', ') || '(none)'}`);
          process.exit(1);
        }
        emitJson(await tool.exec(args));
      } catch (e) {
        console.error(`mcp call: ${e?.message || e}`);
        process.exit(1);
      } finally {
        if (started) { try { await mcpClient.stopServer(server); } catch { /* best-effort */ } }
      }
      return;
    }

    default:
      console.error('Usage: lazyclaw mcp <list|add|remove|call> ...');
      process.exit(2);
  }
}
