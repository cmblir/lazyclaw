#!/usr/bin/env node
// LazyClaw CLI — workflow + config commands.
import path from 'node:path';
// Phase D2 — config IO + key/url resolution + version lookup, extracted to
// lib/ so the per-domain command modules can share them.
import {
  configPath, readConfig, writeConfig,
  _resolveAuthKey, _resolveBaseUrl, readVersionFromRepo,
} from './lib/config.mjs';
// Phase D2 — provider-registry bootstrap (lazy load + per-call re-register).
import { ensureRegistry, requireRegistry, getRegistry } from './lib/registry_boot.mjs';
// Phase D2 — argument parsing + subcommand inventory + agent-registry classifier.
import { SUBCOMMANDS, parseArgs, AGENT_REG_SUBS } from './lib/args.mjs';
// Phase D4 — interactive TUI pickers/banner helpers. Still imported here for the
// onboard / setup / launcher / chat paths that remain inline in this entrypoint.
import {
  _attachGhostAutocomplete, _fetchModelsForProvider, _pauseChatForSubMenu,
  _pickModelInteractive, _pickProviderInteractive, _printChatBanner,
  _quickPrompt, _renderBanner, _renderV5Banner,
} from './tui/pickers.mjs';
// First-run onboarding routing (fresh install → full setup vs --pick).
import { firstRunMode as _firstRunMode } from './first_run.mjs';
// Group B / M6 — chat sliding window. Lives in its own module so
// tests can import the helper without invoking cli.mjs::main().
import { applyChatWindow as _applyChatWindow, CHAT_WINDOW_TURNS, CHAT_WINDOW_TOKEN_BUDGET } from './chat_window.mjs';
// v5 Group C (C7) — shared chat-turn streaming closure. Single source
// of truth for both the ink REPL path and the legacy readline path.
import { makeRunTurn as _chatRunTurnFactory } from './tui/run_turn.mjs';
// v5.4: full slash-command dispatcher (24 commands) for the Ink branch.
import { dispatchSlash as _dispatchSlash, parseSlashLine as _parseSlashLine } from './tui/slash_dispatcher.mjs';
// D6: single canonical slash catalog. The /help dump in the legacy readline
// loop reads this same list the Ink path (_help) and the popup use.
import { SLASH_COMMANDS } from './tui/slash_commands.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = parseArgs(argv.slice(1));
  // No subcommand at all: drop into chat REPL (v5.0.6 default). The
  // arrow-key launcher menu is still available via `lazyclaw menu`.
  // Non-TTY callers (pipes, scripts) get the historical usage line.
  if (cmd === undefined) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      process.argv.splice(2, 0, 'chat');
      return main();
    }
    console.error('Usage: lazyclaw <' + SUBCOMMANDS.join('|') + '> ...');
    console.error('Run `lazyclaw help` for a one-line summary of each subcommand.');
    console.error('Tip: launch in an interactive terminal to drop into chat.');
    process.exit(2);
  }
  switch (cmd) {
    case 'run':
    case 'resume':
    case 'inspect':
    case 'clear':
    case 'validate':
    case 'graph': {
      // Workflow lifecycle commands live in commands/workflow.mjs; lazy-import
      // so the cold-start path (chat/agent) never loads the engine module.
      await (await import('./commands/workflow.mjs')).dispatch(cmd, rest);
      break;
    }
    case 'config': {
      const sub = rest.positional[0];
      if (sub === 'set') {
        const [, key, ...valueParts] = rest.positional;
        (await import('./commands/config.mjs')).cmdConfigSet(key, valueParts.join(' '));
      } else if (sub === 'get') {
        (await import('./commands/config.mjs')).cmdConfigGet(rest.positional[1]);
      } else if (sub === 'list') {
        (await import('./commands/config.mjs')).cmdConfigGet(undefined);
      } else if (sub === 'delete' || sub === 'unset') {
        const key = rest.positional[1];
        if (!key) { console.error('Usage: lazyclaw config delete <key>'); process.exit(2); }
        const cfg = readConfig();
        const had = Object.prototype.hasOwnProperty.call(cfg, key);
        delete cfg[key];
        writeConfig(cfg);
        console.log(JSON.stringify({ ok: true, key, removed: had }));
      } else if (sub === 'path') {
        // Useful for shell pipelines: `cat $(lazyclaw config path)`.
        console.log(configPath());
      } else if (sub === 'edit') {
        await (await import('./commands/config.mjs')).cmdConfigEdit();
      } else if (sub === 'validate') {
        await (await import('./commands/config.mjs')).cmdConfigValidate();
      } else {
        console.error('Usage: lazyclaw config set|get|list|delete|path|edit|validate <key> [value]'); process.exit(2);
      }
      break;
    }
    case 'personality': {
      // Phase G: persona compose subcommand (spec §9, decision C7).
      process.exit(await (await import('./commands/config.mjs')).cmdPersonality(rest.positional[0], rest.positional[1], rest.positional[2]));
      break;
    }
    case 'migrate': {
      // Phase A baseline accepts `lazyclaw migrate v5`; Phase G adds the
      // bare `lazyclaw migrate` and `lazyclaw migrate rollback` forms.
      const target = rest.positional[0];
      if (target === 'rollback') {
        const mod = await import('./scripts/migrate-v5.mjs');
        try {
          const { restoredFrom } = mod.rollback();
          console.log(`rolled back from ${restoredFrom}`);
          process.exit(0);
        } catch (e) {
          console.error(`migrate failed: ${e.message}`);
          process.exit(1);
        }
        break;
      }
      const mod = await import('./scripts/migrate-v5.mjs');
      // `migrate v5` keeps the Phase-A behaviour (verbose JSON); the
      // bare `migrate` form uses the Phase-G human summary.
      if (target === 'v5') {
        const r = await mod.migrateV5();
        console.log(JSON.stringify(r, null, 2));
        process.exit(r.ok ? 0 : 1);
      }
      try {
        const { backupDir } = mod.migrate();
        console.log(`migrated; backup at ${backupDir}`);
        process.exit(0);
      } catch (e) {
        console.error(`migrate failed: ${e.message}`);
        process.exit(1);
      }
      break;
    }
    case 'hermes': {
      // Phase G: import a Hermes Agent install (spec §10).
      if (rest.positional[0] !== 'import') {
        console.error('Usage: lazyclaw hermes import [--from <dir>]');
        process.exit(2);
      }
      const from = rest.flags.from;
      const mod = await import('./scripts/hermes-import.mjs');
      try {
        const { src, dst, counts } = mod.importHermes({ from });
        console.log(`hermes import: ${src} → ${dst}`);
        console.log(`  skills: ${counts.skills}  skins: ${counts.skins}`);
        process.exit(0);
      } catch (e) { console.error(`hermes import failed: ${e.message}`); process.exit(1); }
      break;
    }
    case 'openclaw': {
      // Phase G: import an OpenClaw install (spec §10).
      if (rest.positional[0] !== 'import') {
        console.error('Usage: lazyclaw openclaw import [--from <dir>]');
        process.exit(2);
      }
      const from = rest.flags.from;
      const mod = await import('./scripts/openclaw-import.mjs');
      try {
        const { src, dst, counts } = mod.importOpenclaw({ from });
        console.log(`openclaw import: ${src} → ${dst}  skills:${counts.skills}`);
        process.exit(0);
      } catch (e) { console.error(`openclaw import failed: ${e.message}`); process.exit(1); }
      break;
    }
    case 'trajectories': {
      // Phase H1: read-only trajectory exporter (spec §2.7).
      // Usage: lazyclaw trajectories export --format <atropos|axolotl|openai-ft|jsonl>
      //          [--since 7d] [--filter "outcome=done"] [--out ./dir]
      if (rest.positional[0] !== 'export') {
        console.error('Usage: lazyclaw trajectories export --format <atropos|axolotl|openai-ft|jsonl> [--since 7d] [--filter "outcome=done"] [--out <dir>]');
        process.exit(2);
      }
      const mod = await import('./mas/trajectory_export.mjs');
      const format = rest.flags.format || 'jsonl';
      if (!mod.FORMATS.includes(format)) {
        console.error(`trajectories export: unknown format "${format}" — choose ${mod.FORMATS.join('|')}`);
        process.exit(2);
      }
      try {
        const r = await mod.exportTrajectories({
          format,
          since: rest.flags.since,
          filter: mod.parseFilterArg(rest.flags.filter),
          outDir: rest.flags.out,
        });
        console.log(`exported ${r.count} trajectories (${r.format}) → ${r.outFile}`);
        process.exit(0);
      } catch (e) {
        console.error(`trajectories export failed: ${e.message}`);
        process.exit(1);
      }
      break;
    }
    case 'chat': {
      await (await import('./commands/chat.mjs')).cmdChat(rest.flags);
      break;
    }
    case 'sessions': {
      const sub = rest.positional[0];
      await (await import('./commands/sessions.mjs')).cmdSessions(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'providers': {
      const sub = rest.positional[0];
      await (await import('./commands/providers.mjs')).cmdProviders(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'orchestrator': {
      const sub = rest.positional[0];
      await (await import('./commands/providers.mjs')).cmdOrchestrator(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'skills': {
      const sub = rest.positional[0];
      await (await import('./commands/skills.mjs')).cmdSkills(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'rates': {
      const sub = rest.positional[0];
      await (await import('./commands/providers.mjs')).cmdRates(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'sandbox': {
      process.exit(await (await import('./commands/misc.mjs')).cmdSandbox(rest.positional, rest.flags));
      break;
    }
    case 'auth': {
      const sub = rest.positional[0];
      await (await import('./commands/auth_nodes.mjs')).cmdAuth(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'pairing': {
      const sub = rest.positional[0];
      await (await import('./commands/auth_nodes.mjs')).cmdPairing(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'nodes': {
      const sub = rest.positional[0];
      await (await import('./commands/auth_nodes.mjs')).cmdNodes(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'message': {
      const sub = rest.positional[0];
      await (await import('./commands/auth_nodes.mjs')).cmdMessage(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'workspace': {
      const sub = rest.positional[0];
      await (await import('./commands/auth_nodes.mjs')).cmdWorkspace(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'browse': {
      await (await import('./commands/misc.mjs')).cmdBrowse(rest.positional[0], rest.flags);
      break;
    }
    case 'cron': {
      const sub = rest.positional[0];
      await (await import('./commands/automation.mjs')).cmdCron(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'loop': {
      const prompt = rest.positional[0];
      await (await import('./commands/automation.mjs')).cmdLoop(prompt, rest.flags);
      break;
    }
    case 'loops': {
      const sub = rest.positional[0];
      await (await import('./commands/automation.mjs')).cmdLoops(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'goal': {
      const sub = rest.positional[0];
      await (await import('./commands/automation.mjs')).cmdGoal(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'memory': {
      const sub = rest.positional[0];
      await (await import('./commands/sessions.mjs')).cmdMemory(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'slack': {
      const sub = rest.positional[0];
      await (await import('./commands/channels.mjs')).cmdSlack(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'telegram': {
      const sub = rest.positional[0];
      await (await import('./commands/channels.mjs')).cmdTelegram(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'matrix': {
      const sub = rest.positional[0];
      await (await import('./commands/channels.mjs')).cmdMatrix(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'team': {
      const sub = rest.positional[0];
      await (await import('./commands/agents.mjs')).cmdTeam(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'task': {
      const sub = rest.positional[0];
      await (await import('./commands/agents.mjs')).cmdTask(sub, rest.positional.slice(1), rest.flags);
      break;
    }
    case 'setup': {
      await (await import('./commands/setup.mjs')).cmdSetup(undefined, rest.positional, rest.flags);
      break;
    }
    case 'dashboard': {
      await (await import('./commands/daemon.mjs')).cmdDashboard(rest.flags);
      break;
    }
    case 'channels': {
      const sub = (rest.positional[0] || 'list').toLowerCase();
      const { createLoader, listInstalled } = await import('./channels/loader.mjs');
      const cfgDir = path.dirname(configPath());
      const loader = createLoader({ configDir: cfgDir });
      if (sub === 'install') {
        const name = rest.positional[1];
        if (!name) { process.stderr.write('usage: lazyclaw channels install <@lazyclaw/channel-name>\n'); process.exit(2); }
        const info = await loader.install(name);
        process.stdout.write(`installed ${info.name}@${info.version}\n`);
        break;
      }
      if (sub === 'remove' || sub === 'uninstall') {
        const name = rest.positional[1];
        if (!name) { process.stderr.write('usage: lazyclaw channels remove <@lazyclaw/channel-name>\n'); process.exit(2); }
        await loader.remove(name);
        process.stdout.write(`removed ${name}\n`);
        break;
      }
      // list
      const rows = listInstalled(cfgDir);
      if (!rows.length) { process.stdout.write('no channel plugins installed\n'); break; }
      for (const r of rows) process.stdout.write(`${r.name}\t${r.version}\n`);
      break;
    }
    case 'daemon': {
      await (await import('./commands/daemon.mjs')).cmdDaemon(rest.flags);
      break;
    }
    case 'agent': {
      const first = rest.positional[0];
      if (AGENT_REG_SUBS.has(first)) {
        await (await import('./commands/agents.mjs')).cmdAgentRegistry(first, rest.positional.slice(1), rest.flags);
      } else {
        await (await import('./commands/agents.mjs')).cmdAgent(first, rest.flags);
      }
      break;
    }
    case 'doctor': {
      await (await import('./commands/config.mjs')).cmdDoctor();
      break;
    }
    case 'status': {
      await (await import('./commands/config.mjs')).cmdStatus();
      break;
    }
    case 'onboard': {
      await (await import('./commands/setup.mjs')).cmdOnboard(rest.flags);
      break;
    }
    case 'version':
    case '--version':
    case '-v': {
      await (await import('./commands/config.mjs')).cmdVersion();
      break;
    }
    case 'completion': {
      await (await import('./commands/config.mjs')).cmdCompletion(rest.positional[0]);
      break;
    }
    case 'export': {
      await (await import('./commands/sessions.mjs')).cmdExport(rest.flags);
      break;
    }
    case 'import': {
      await (await import('./commands/sessions.mjs')).cmdImport(rest.flags);
      break;
    }
    case 'help':
    case '--help':
    case '-h': {
      await (await import('./commands/setup.mjs')).cmdHelp(rest.positional[0]);
      break;
    }
    case 'menu': {
      // v5.0.6 — explicit arrow-key launcher (was the no-arg default in v5.0.5-).
      await (await import('./commands/setup.mjs')).cmdLauncher();
      break;
    }
    default:
      console.error('Usage: lazyclaw <' + SUBCOMMANDS.join('|') + '> ...');
      console.error('Run `lazyclaw help` for a one-line summary of each subcommand.');
      process.exit(2);
  }
}

main().catch(e => { console.error(e?.stack || e?.message || String(e)); process.exit(1); });
