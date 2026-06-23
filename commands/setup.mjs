// commands/setup.mjs — onboarding + setup + interactive launcher hub,
// extracted from cli.mjs (D7). Verbatim move of applyOnboardConfig,
// cmdOnboard, HELP_SUMMARIES, HELP_DETAILS, cmdHelp, cmdSetup,
// _runFirstTimeOnboard, _DispatchExit, _dispatchMenuChoice, cmdLauncher.
// Dynamic-import paths were rebased ./ -> ../ (so ./commands/X became
// ../commands/X, which resolves to the sibling), and the cmdChat calls
// lazy-import ./chat.mjs to break the setup <-> chat cycle.
import path from 'node:path';
import {
  configPath, readConfig, writeConfig,
  _resolveAuthKey, _resolveBaseUrl, readVersionFromRepo,
} from '../lib/config.mjs';
import { ensureRegistry, requireRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { SUBCOMMANDS, parseArgs, AGENT_REG_SUBS } from '../lib/args.mjs';
import { runPermissionStep } from './setup_permission.mjs';
import { runWizardSteps } from '../tui/wizard_back.mjs';
import { promptWithBack } from '../tui/prompt_back.mjs';
import {
  _attachGhostAutocomplete, _fetchModelsForProvider, _pauseChatForSubMenu,
  _pickModelInteractive, _pickProviderInteractive, _printChatBanner,
  _quickPrompt, _quickPromptSecret, _renderBanner, _renderV5Banner,
  _pickYesNo,
} from '../tui/pickers.mjs';
import { firstRunMode as _firstRunMode } from '../first_run.mjs';
import { applyChatWindow as _applyChatWindow, CHAT_WINDOW_TURNS, CHAT_WINDOW_TOKEN_BUDGET } from '../chat_window.mjs';
import { makeRunTurn as _chatRunTurnFactory } from '../tui/run_turn.mjs';
import { dispatchSlash as _dispatchSlash, parseSlashLine as _parseSlashLine } from '../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';
import { runChannelStep, runWebhookStep, runOrchestratorStep, runContextStep } from './setup_channels.mjs';
import { splashPropsForSetup, renderSplashToString } from '../tui/splash_props.mjs';
import { HELP_SUMMARIES, HELP_DETAILS } from './help_text.mjs';

function applyOnboardConfig(currentCfg, flags) {
  // Honors the OpenClaw-style unified provider/model string ("anthropic/claude-opus-4-7")
  // by splitting it, but explicit --provider always wins.
  const { parseSlashProviderModel } = requireRegistry();
  const next = { ...currentCfg };
  if (flags.model) {
    const parsed = parseSlashProviderModel(flags.model);
    if (parsed.provider && !flags.provider) next.provider = parsed.provider;
    next.model = parsed.model || flags.model;
  }
  if (flags.provider) next.provider = flags.provider;
  if (flags['api-key']) next['api-key'] = flags['api-key'];
  return next;
}

// Module is ESM but we want a synchronous-looking helper for the CLI flow.
// Cache the import on first use so we don't pay for it on every config call.
export async function cmdOnboard(flags) {
  await ensureRegistry();
  if (!flags['non-interactive']) {
    // Interactive onboarding is a single guided prompt sequence — kept tiny.
    // For automation always use --non-interactive plus the value flags.
    // Skip the prompts entirely when the user passed --pick (or no
    // provider yet AND we're on a TTY) so they get the full picker.
    const wantPicker = !!flags.pick;
    if (wantPicker || (!flags.provider && process.stdin.isTTY)) {
      const picked = await _pickProviderInteractive();
      if (picked) {
        flags.provider = flags.provider || picked.provider;
        if (picked.model && !flags.model) flags.model = picked.model;
      }
    }
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(resolve => rl.question(q, resolve));
    if (!flags.provider) {
      const provs = Object.keys(getRegistry().PROVIDERS).join('|');
      const noKeyHint = '\x1b[38;2;217;179;90mclaude-cli\x1b[0m (subscription, no key) is the default';
      process.stdout.write(`hint: ${noKeyHint}\n`);
      flags.provider = (await ask(`provider [${provs}]: `)).trim() || 'claude-cli';
    }
    if (!flags.model) {
      const meta = (getRegistry().PROVIDER_INFO || {})[flags.provider] || {};
      const sample = (meta.suggestedModels || []).slice(0, 4).join(' · ') || '(any)';
      const dflt = meta.defaultModel || '';
      flags.model = (await ask(`model (e.g. ${sample}) [${dflt}]: `)).trim() || dflt;
    }
    // Only ask for api-key when the picked provider actually needs one.
    // claude-cli / ollama / mock all skip this — that's the whole point
    // of supporting them.
    const meta = (getRegistry().PROVIDER_INFO || {})[flags.provider] || {};
    if (meta.requiresApiKey && !flags['api-key']) {
      const prefix = meta.keyPrefix ? ` (starts with "${meta.keyPrefix}")` : '';
      // Close the line-mode reader before the masked raw-mode read so they
      // don't both consume stdin. The key is masked (•) — never echoed.
      rl.close();
      flags['api-key'] = await _quickPromptSecret(`api-key${prefix}: `);
    } else {
      rl.close();
    }
  }
  const next = applyOnboardConfig(readConfig(), flags);
  if (!next.provider) { console.error('onboard: provider is required'); process.exit(2); }
  writeConfig(next);
  console.log(JSON.stringify({ ok: true, written: configPath(), provider: next.provider, model: next.model || null, hasApiKey: !!next['api-key'] }));
}

export function cmdHelp(name) {
  if (!name) {
    process.stdout.write('lazyclaw — terminal AI assistant + workflow engine\n\n');
    process.stdout.write('Subcommands:\n');
    for (const sub of SUBCOMMANDS) {
      const summary = HELP_SUMMARIES[sub] || '';
      process.stdout.write(`  ${sub.padEnd(12)}${summary}\n`);
    }
    process.stdout.write('\nlazyclaw help <subcommand>   detailed usage\n');
    return;
  }
  const detail = HELP_DETAILS[name];
  if (!detail) {
    process.stderr.write(`unknown subcommand: ${name}\n`);
    process.stderr.write(`run \`lazyclaw help\` to see the list\n`);
    process.exit(2);
  }
  process.stdout.write(detail + '\n');
}

export async function cmdSetup(_sub, _positional, flags = {}) {
  await ensureRegistry();
  const accent = (s) => `\x1b[38;2;217;179;90m${s}\x1b[0m`;
  const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
  const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
  const ok     = (s) => `\x1b[32m${s}\x1b[0m`;
  const warn   = (s) => `\x1b[33m${s}\x1b[0m`;

  // Header.
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(renderSplashToString(await splashPropsForSetup({ version: readVersionFromRepo() })) + '\n');
  process.stdout.write('\n');
  process.stdout.write(`  ${bold('🔧 Setup wizard')}\n`);
  process.stdout.write(`  ${dim('Get one clean chat working first, then optionally add a channel, workspace, or skills. Press Enter to accept the default; type "skip" or "n" to bypass an optional step.')}\n\n`);

  const cfg = readConfig();
  const cfgDir = path.dirname(configPath());
  const colors = { accent, bold, dim, ok, warn };

  // Per-step gating: `--only a,b` runs ONLY those; `--skip a,b` runs all but
  // those. Steps: provider verify channel workspace skill webhook orchestrator.
  // e.g. `lazyclaw setup --only channel` re-runs just the channel step.
  const onlySet = flags.only ? new Set(String(flags.only).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const skipSet = new Set(String(flags.skip || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
  const want = (step) => (onlySet ? onlySet.has(step) : !skipSet.has(step));
  let cfgAfterOnboard = cfg;

  // ── Step 1/7: Provider + model (mandatory) ──────────────────
  if (want('provider')) {
  process.stdout.write(`  ${accent('Step 1/7 ·')} ${bold('Pick a provider + model')}\n`);
  process.stdout.write(`  ${dim('Opens the arrow-key picker. Tip: pick a model with ≥64k context — small windows can\'t hold multi-step tool-calling state.')}\n\n`);
  await _quickPrompt('  ▶ press Enter to open the picker ');
  try {
    await cmdOnboard({ pick: true });
  } catch (e) {
    // Don't kill the process — the setup wizard is often called
    // from inside cmdLauncher's loop, and a process.exit there
    // would close the launcher entirely (the surface bug the
    // user reported as "Setup 누르고 엔터 누르니까 바로 꺼져").
    // Surface the error and let the caller decide.
    process.stderr.write(`onboard error: ${e?.message || e}\n`);
    return;
  }
  // Re-read config after onboard wrote it. If the user aborted with
  // no provider set, bail out early — the rest of the wizard depends
  // on a provider being configured. `return` (not process.exit) so a
  // launcher caller can re-prompt or fall back gracefully.
  cfgAfterOnboard = readConfig();
  if (!cfgAfterOnboard.provider) {
    process.stdout.write(`\n  ${warn('Setup not completed — provider was not configured.')}\n`);
    process.stdout.write(`  ${dim('Run `lazyclaw setup` again when ready, or pick "Onboard" from the menu for a single-step picker.')}\n\n`);
    return;
  }
  process.stdout.write(`\n  ${ok('✓ provider:')} ${cfgAfterOnboard.provider}  ${dim('model:')} ${cfgAfterOnboard.model || '(default)'}\n\n`);

  // Context window + tool-permission mode — core chat setup, looped so Esc on
  // permission goes back one step to the context window (and Esc on the custom
  // entries goes back too). Part of the model setup, not numbered steps.
  const _backPrompt = (label) => promptWithBack(label);
  await runWizardSteps(['context', 'permission'], (id) => (id === 'context'
    ? runContextStep({ prompt: _quickPrompt, backPrompt: _backPrompt, colors })
    : runPermissionStep({ prompt: _quickPrompt, backPrompt: _backPrompt, colors, cfg: cfgAfterOnboard })));
  }

  // ── Step 2/7: Verify one clean chat works ───────────────────
  // Hermes rule: get a clean reply before layering on channels/skills.
  if (want('verify') && cfgAfterOnboard.provider) {
  process.stdout.write(`  ${accent('Step 2/7 ·')} ${bold('Verify the provider responds')}\n`);
  process.stdout.write(`  ${dim('Sends a 1-token "ping" via `lazyclaw providers test`. Confirm a clean reply before layering on channels/skills.')}\n\n`);
  const wantPing = !flags['skip-test'] && await _pickYesNo('Test the provider now?', { subtitle: 'sends a 1-token ping to confirm a clean reply', yesLabel: 'Test now', noLabel: 'Skip', defaultYes: true });
  if (wantPing) {
    try {
      // No-exit probe (providers/probe.mjs) — the CLI `providers test` calls
      // process.exit, which would kill the rest of this wizard. Render one
      // concise line instead of the full JSON dump and keep going.
      const { probeProvider } = await import('../providers/probe.mjs');
      const r = await probeProvider({ name: cfgAfterOnboard.provider, model: cfgAfterOnboard.model || undefined });
      if (r.ok) process.stdout.write(`  ${ok('✓ ' + (r.reply || 'ok'))}  ${dim(`· ${r.model || cfgAfterOnboard.provider} · ${r.durationMs}ms`)}\n`);
      else process.stdout.write(`  ${warn('✗ ' + (r.error || 'no reply'))}  ${dim(`· retry: lazyclaw providers test ${cfgAfterOnboard.provider}`)}\n`);
    } catch (e) {
      process.stdout.write(`  ${warn('test errored:')} ${e?.message || e}\n`);
    }
    process.stdout.write('\n');
  } else {
    process.stdout.write(`  ${dim('— skipped —')}\n\n`);
  }
  }

  // ── Step 3/7: Channel / gateway (optional) ──────────────────
  if (want('channel')) {
  process.stdout.write(`  ${accent('Step 3/7 ·')} ${bold('Where will you run it?')} ${dim('(optional)')}\n`);
  await runChannelStep({ cfgDir, prompt: _quickPrompt, colors });
  }

  // ── Step 4/7: Optional workspace ────────────────────────────
  if (want('workspace')) {
  process.stdout.write(`  ${accent('Step 4/7 ·')} ${bold('Initialise a workspace?')} ${dim('(optional)')}\n`);
  process.stdout.write(`  ${dim('A workspace is a folder of AGENTS.md / SOUL.md / TOOLS.md prompt files that auto-inject into chat / agent. Skip if you don\'t need project-specific personas yet.')}\n\n`);
  const wantWs = await _pickYesNo('Initialise a workspace?', { yesLabel: 'Create one', noLabel: 'Skip', defaultYes: false });
  const wsName = wantWs ? (await _quickPrompt('  workspace name: ')).trim() : '';
  if (wsName && /^[A-Za-z0-9_.-]+$/.test(wsName)) {
    try {
      const ws = await import('../workspace.mjs');
      const dir = ws.initWorkspace(cfgDir, wsName);
      process.stdout.write(`  ${ok('✓ workspace created:')} ${dir}\n`);
      process.stdout.write(`  ${dim('Edit AGENTS.md / SOUL.md / TOOLS.md any time. Use with: lazyclaw chat --workspace ' + wsName)}\n\n`);
    } catch (e) {
      process.stdout.write(`  ${warn('skipped:')} ${e?.message || e}\n\n`);
    }
  } else if (wsName) {
    process.stdout.write(`  ${warn('skipped:')} workspace name must match [A-Za-z0-9_.-]+\n\n`);
  } else {
    process.stdout.write(`  ${dim('— skipped —')}\n\n`);
  }
  }

  // ── Step 5/7: Optional skill bundle install ─────────────────
  if (want('skill')) {
  process.stdout.write(`  ${accent('Step 5/7 ·')} ${bold('Install a skill bundle from GitHub?')} ${dim('(optional)')}\n`);
  process.stdout.write(`  ${dim('Format: <user>/<repo>[@<ref>]. Skills are .md prompt fragments that compose into the system prompt via --skill.')}\n\n`);
  const wantSkill = await _pickYesNo('Install a skill bundle from GitHub?', { yesLabel: 'Install one', noLabel: 'Skip', defaultYes: false });
  const skillSpec = wantSkill ? (await _quickPrompt('  github spec (<user>/<repo>[@<ref>]): ')).trim() : '';
  if (skillSpec) {
    try {
      const inst = await import('../skills_install.mjs');
      const r = await inst.installFromGithub(skillSpec, cfgDir, { force: false });
      process.stdout.write(`  ${ok('✓ installed')} ${r.installed.length} ${dim('skill(s) from')} ${skillSpec}\n`);
      r.installed.forEach((s) => process.stdout.write(`    · ${s.name} ${dim(`(${s.bytes} bytes)`)}\n`));
      if (r.skipped.length) {
        process.stdout.write(`  ${dim('skipped (already installed):')} ${r.skipped.map((s) => s.name).join(', ')}\n`);
      }
      process.stdout.write('\n');
    } catch (e) {
      process.stdout.write(`  ${warn('skipped:')} ${e?.message || e}\n\n`);
    }
  } else {
    process.stdout.write(`  ${dim('— skipped —')}\n\n`);
  }
  }

  // ── Step 6/7: Optional outbound webhook ─────────────────────
  if (want('webhook')) {
  process.stdout.write(`  ${accent('Step 6/7 ·')} ${bold('Add an outbound webhook?')} ${dim('(optional)')}\n`);
  await runWebhookStep({ prompt: _quickPrompt, colors });
  }

  // ── Step 7/7: Optional multi-agent orchestration ────────────
  if (want('orchestrator')) {
  process.stdout.write(`  ${accent('Step 7/7 ·')} ${bold('Enable multi-agent orchestration?')} ${dim('(optional)')}\n`);
  await runOrchestratorStep({ prompt: _quickPrompt, colors });
  }

  // ── Wrap up ─────────────────────────────────────────────────
  process.stdout.write('\n');
  process.stdout.write(`  ${ok(bold('🎉 Setup complete.'))}\n`);
  process.stdout.write(`  ${dim('Run')} ${bold('lazyclaw')} ${dim('any time to open the menu, or jump in directly:')}\n`);
  process.stdout.write(`    ${dim('•')} lazyclaw chat                ${dim('— REPL with the configured provider')}\n`);
  process.stdout.write(`    ${dim('•')} lazyclaw agent "..."          ${dim('— one-shot prompt')}\n`);
  process.stdout.write(`    ${dim('•')} lazyclaw doctor              ${dim('— diagnostic JSON')}\n`);
  process.stdout.write(`    ${dim('•')} lazyclaw setup               ${dim('— re-run this wizard any time')}\n\n`);

  // Release stdin so `lazyclaw setup` returns to the shell instead of hanging
  // at "Setup complete". The interactive prompts (_arrowMenu / _quickPrompt)
  // resume()+ref() stdin to read input; without an unref the ref'd handle keeps
  // the event loop alive after the last step. When setup is invoked from the
  // launcher, the next menu resume()+ref()s stdin again, so this is safe there.
  try { if (process.stdin.unref) process.stdin.unref(); } catch { /* best-effort */ }
}

// First-run welcome panel + delegated onboard. Drawn once before the
// main launcher menu when the config has no provider yet. Walks the
// user through the same arrow-key picker that `lazyclaw onboard`
// uses; on success the launcher continues, on cancel the launcher
// exits politely instead of dropping into a menu where every option
// would error.
async function _runFirstTimeOnboard() {
  const accent = (s) => `\x1b[38;2;217;179;90m${s}\x1b[0m`;
  const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
  const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(renderSplashToString(await splashPropsForSetup({ version: readVersionFromRepo() })) + '\n');
  process.stdout.write('\n');
  process.stdout.write(`  ${bold('👋 Welcome — first-time setup')}\n\n`);
  process.stdout.write(`  ${dim('No provider configured yet at')} ${configPath()}\n`);
  process.stdout.write(`  ${dim('Pick a provider + model below; LazyClaw stores it in ~/.lazyclaw/config.json.')}\n\n`);
  process.stdout.write(`  ${dim('Quick rule of thumb:')}\n`);
  process.stdout.write(`  ${dim('  · gemini / openai / anthropic — need an API key (sk-... / paste during setup)')}\n`);
  process.stdout.write(`  ${dim('  · claude-cli / ollama          — keyless (use your existing Claude Code login or local Ollama)')}\n`);
  process.stdout.write(`  ${dim('  · mock                         — offline echo, only useful for testing')}\n\n`);
  process.stdout.write(`  ${dim('Press Enter to open the picker · Ctrl+C to abort.')}\n`);
  await _quickPrompt('  ▶ ');
  // Delegate to the real onboard flow with --pick so the picker UI
  // fires regardless of how this entry point was reached. cmdOnboard
  // owns config writing.
  try {
    await cmdOnboard({ pick: true });
  } catch (e) {
    process.stderr.write(`onboard error: ${e?.message || e}\n`);
  }
  process.stdout.write('\n');
}

// Marker exception used by the launcher's process.exit guard. See
// _dispatchMenuChoice below for why intercepting process.exit is
// the cleanest way to keep the menu loop alive.
class _DispatchExit extends Error {
  constructor(code) {
    super(`subcommand requested exit ${code}`);
    this.name = 'DispatchExit';
    this.exitCode = Number.isFinite(code) ? code : 0;
  }
}

// Direct dispatch from a launcher pick. Replaces the previous
// `process.argv = [...]; await main()` round-trip so we can reuse
// the launcher across multiple iterations without compounding
// state.
//
// Subcommand functions across this CLI freely call `process.exit()`
// to signal their result — perfectly fine for one-shot CLI use,
// fatal to a launcher loop because the first exit kills the whole
// process before we can redraw the menu. Intercept process.exit for
// the duration of the dispatch and turn it into a thrown exception
// the loop can catch + log + continue from. This mirrors how Python
// CLI frameworks handle SystemExit when running inside a REPL.
async function _dispatchMenuChoice(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const realExit = process.exit.bind(process);
  process.exit = (code) => { throw new _DispatchExit(code); };
  try {
    switch (sub) {
      case 'chat':         return await (await import('./chat.mjs')).cmdChat({});
      case 'agent':        {
        if (AGENT_REG_SUBS.has(rest[0])) return await (await import('../commands/agents.mjs')).cmdAgentRegistry(rest[0], rest.slice(1), {});
        return await (await import('../commands/agents.mjs')).cmdAgent(rest[0] || '-', {});
      }
      case 'onboard':      return await cmdOnboard({});
      case 'setup':        return await cmdSetup(undefined, rest, {});
      case 'workspace':    return await (await import('../commands/auth_nodes.mjs')).cmdWorkspace(rest[0], rest.slice(1), {});
      case 'browse':       return await (await import('../commands/misc.mjs')).cmdBrowse(rest[0], {});
      case 'skills':       return await (await import('../commands/skills.mjs')).cmdSkills(rest[0], rest.slice(1), {});
      case 'sessions':     return await (await import('../commands/sessions.mjs')).cmdSessions(rest[0], rest.slice(1), {});
      case 'providers':    return await (await import('../commands/providers.mjs')).cmdProviders(rest[0], rest.slice(1), {});
      case 'cron':         return await (await import('../commands/automation.mjs')).cmdCron(rest[0], rest.slice(1), {});
      case 'loop':         return await (await import('../commands/automation.mjs')).cmdLoop(rest[0] || '', {});
      case 'loops':        return await (await import('../commands/automation.mjs')).cmdLoops(rest[0], rest.slice(1), {});
      case 'goal':         return await (await import('../commands/automation.mjs')).cmdGoal(rest[0], rest.slice(1), {});
      case 'memory':       return await (await import('../commands/sessions.mjs')).cmdMemory(rest[0], rest.slice(1), {});
      case 'slack':        return await (await import('../commands/channels.mjs')).cmdSlack(rest[0], rest.slice(1), {});
      case 'telegram':     return await (await import('../commands/channels.mjs')).cmdTelegram(rest[0], rest.slice(1), {});
      case 'matrix':       return await (await import('../commands/channels.mjs')).cmdMatrix(rest[0], rest.slice(1), {});
      case 'team':         return await (await import('../commands/agents.mjs')).cmdTeam(rest[0], rest.slice(1), {});
      case 'task':         return await (await import('../commands/agents.mjs')).cmdTask(rest[0], rest.slice(1), {});
      case 'auth':         return await (await import('../commands/auth_nodes.mjs')).cmdAuth(rest[0], rest.slice(1), {});
      case 'pairing':      return await (await import('../commands/auth_nodes.mjs')).cmdPairing(rest[0], rest.slice(1), {});
      case 'nodes':        return await (await import('../commands/auth_nodes.mjs')).cmdNodes(rest[0], rest.slice(1), {});
      case 'message':      return await (await import('../commands/auth_nodes.mjs')).cmdMessage(rest[0], rest.slice(1), {});
      case 'doctor':       return await (await import('../commands/config.mjs')).cmdDoctor();
      case 'status':       return await (await import('../commands/config.mjs')).cmdStatus();
      // v3.99.27 — fill the rest of the lazyclaw <subcommand> surface
      // so the no-arg launcher mirrors every entry in SUBCOMMANDS.
      case 'orchestrator': return await (await import('../commands/providers.mjs')).cmdOrchestrator(rest[0], rest.slice(1), {});
      case 'rates':        return await (await import('../commands/providers.mjs')).cmdRates(rest[0], rest.slice(1), {});
      case 'config':       {
        // Mirror the main switch's tiny dispatcher.
        const csub = rest[0];
        if (csub === 'list' || csub === undefined) return (await import('../commands/config.mjs')).cmdConfigGet(undefined);
        if (csub === 'get')   return (await import('../commands/config.mjs')).cmdConfigGet(rest[1]);
        if (csub === 'set')   return (await import('../commands/config.mjs')).cmdConfigSet(rest[1], rest.slice(2).join(' '));
        if (csub === 'path')  { process.stdout.write(configPath() + '\n'); return; }
        if (csub === 'edit')  return await (await import('../commands/config.mjs')).cmdConfigEdit();
        if (csub === 'validate') return await (await import('../commands/config.mjs')).cmdConfigValidate();
        process.stderr.write('Usage: lazyclaw config <get|set|list|delete|path|edit|validate>\n');
        return;
      }
      case 'inspect':      return await (await import('../commands/workflow.mjs')).dispatch('inspect', { positional: [rest[0]], flags: {} });
      case 'export':       return await (await import('../commands/sessions.mjs')).cmdExport({});
      case 'version':      return await (await import('../commands/config.mjs')).cmdVersion();
      // Phase G — persona compose subcommand (spec §9, decision C7).
      case 'personality':  return await (await import('../commands/config.mjs')).cmdPersonality(rest[0], rest[1], rest[2]);
      // help <cmd> is the safe fallback for commands that need real
      // arguments (run / resume / clear / validate / graph / daemon /
      // import / completion). Print the usage so the user can re-launch
      // with proper flags — the menu stays alive.
      case 'help':         return cmdHelp(rest[0]);
      case 'dashboard':    return await (await import('../commands/daemon.mjs')).cmdDashboard({});
      default:             throw new Error(`unknown menu choice: ${sub}`);
    }
  } catch (e) {
    if (e instanceof _DispatchExit) {
      // Subcommand wanted to exit. Surface a non-zero code so the
      // user knows something flagged, but DON'T propagate — we want
      // the launcher loop to continue.
      if (e.exitCode !== 0) {
        process.stderr.write(`  \x1b[2m(subcommand returned exit code ${e.exitCode})\x1b[0m\n`);
      }
      return;
    }
    throw e;
  } finally {
    process.exit = realExit;
  }
}

export async function cmdLauncher() {
  await ensureRegistry();
  // Item table is fixed across iterations — only the dispatcher and
  // the per-iteration draw redraw on each loop tick.
  // Mirror every top-level `lazyclaw <subcommand>` here so the no-arg
  // launcher is a complete discovery surface. Commands that need
  // arguments (workflow runner, daemon, completion, import) route
  // through `help <cmd>` so the menu pick prints copy-pasteable usage
  // instead of erroring or blocking. Commands with a sensible default
  // ('list' / 'status') get dispatched directly.
  const items = [
    // Core interaction
    { id: 'chat',         label: 'Chat',         desc: 'interactive REPL with the configured provider', argv: ['chat'] },
    { id: 'agent',        label: 'Agent',        desc: 'one-shot prompt — read text and exit',          argv: ['agent'], promptForBody: true },
    { id: 'orchestrator', label: 'Orchestrator', desc: 'multi-agent dispatch — planner + workers',      argv: ['orchestrator', 'status'] },
    // UI & onboarding
    { id: 'dashboard',    label: 'Dashboard',    desc: 'open the lazyclaw web UI in your browser',      argv: ['dashboard'] },
    { id: 'setup',        label: 'Setup',        desc: 'multi-step provider / workspace / skill wizard',argv: ['setup'] },
    { id: 'onboard',      label: 'Onboard',      desc: 'pick provider / model / api-key',               argv: ['onboard'] },
    // Auth & config
    { id: 'providers',    label: 'Providers',    desc: 'registered providers + reachability',           argv: ['providers', 'list'] },
    { id: 'auth',         label: 'Auth',         desc: 'multi-key rotation per provider',               argv: ['help', 'auth'] },
    { id: 'config',       label: 'Config',       desc: 'cfg.json get/set/list/delete/path/edit',        argv: ['config', 'list'] },
    { id: 'rates',        label: 'Rates',        desc: 'per-model input/output pricing cards',          argv: ['rates', 'list'] },
    // Workspaces & assets
    { id: 'workspace',    label: 'Workspace',    desc: 'AGENTS.md / SOUL.md / TOOLS.md prompt bundles', argv: ['workspace', 'list'] },
    { id: 'skills',       label: 'Skills',       desc: 'installed skill bundles',                       argv: ['skills', 'list'] },
    { id: 'sessions',     label: 'Sessions',     desc: 'persisted chat sessions',                       argv: ['sessions', 'list'] },
    // Outbound & schedule
    { id: 'browse',       label: 'Browse',       desc: 'fetch a URL → markdown',                        argv: ['browse'], promptForUrl: true },
    { id: 'message',      label: 'Message',      desc: 'outbound webhook (Slack / Discord / generic)',  argv: ['message', 'list'] },
    { id: 'cron',         label: 'Cron',         desc: 'recurring agent runs (launchd / crontab)',      argv: ['cron', 'list'] },
    // Workflow runner (.mjs)
    { id: 'run',          label: 'Run',          desc: '.mjs workflow runner (needs session + file)',   argv: ['help', 'run'] },
    { id: 'resume',       label: 'Resume',       desc: 're-enter a persisted workflow run',             argv: ['help', 'resume'] },
    { id: 'inspect',      label: 'Inspect',      desc: 'list / drill into persisted workflow sessions', argv: ['inspect'] },
    { id: 'clear',        label: 'Clear',        desc: 'delete the state file for a session',           argv: ['help', 'clear'] },
    { id: 'validate',     label: 'Validate',     desc: 'static-check a workflow.mjs (shape + deps)',    argv: ['help', 'validate'] },
    { id: 'graph',        label: 'Graph',        desc: 'emit Mermaid graph TD / LR from a workflow',    argv: ['help', 'graph'] },
    // Devices & process
    { id: 'pairing',      label: 'Pairing',      desc: 'sender allowlist for the messaging surface',    argv: ['pairing', 'list'] },
    { id: 'nodes',        label: 'Nodes',        desc: 'companion device registry',                     argv: ['nodes', 'list'] },
    { id: 'daemon',       label: 'Daemon',       desc: 'localhost HTTP daemon (blocking — see usage)',  argv: ['help', 'daemon'] },
    // Bundle
    { id: 'export',       label: 'Export',       desc: 'redacted config bundle → stdout',               argv: ['export'] },
    { id: 'import',       label: 'Import',       desc: 'restore from a bundle on stdin',                argv: ['help', 'import'] },
    // Tools
    { id: 'completion',   label: 'Completion',   desc: 'shell completion (bash | zsh)',                 argv: ['help', 'completion'] },
    { id: 'version',      label: 'Version',      desc: 'lazyclaw version + Node + platform',            argv: ['version'] },
    // Diagnostics
    { id: 'doctor',       label: 'Doctor',       desc: 'diagnostic — config, providers, workflows',    argv: ['doctor'] },
    { id: 'status',       label: 'Status',       desc: 'current provider / model / masked key',         argv: ['status'] },
    // Meta
    { id: 'help',         label: 'Help',         desc: 'one-line summary of every subcommand',          argv: ['help'] },
    { id: 'quit',         label: 'Quit',         desc: 'exit lazyclaw',                                 argv: null },
  ];

  const accent = (s) => `\x1b[38;2;217;179;90m${s}\x1b[0m`;
  const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
  const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
  const ok     = (s) => `\x1b[32m${s}\x1b[0m`;
  const warn   = (s) => `\x1b[33m${s}\x1b[0m`;

  let idx = 0;
  // Outer loop — each iteration is one menu render → pick →
  // dispatch round. Subcommand return drops back here and the menu
  // is redrawn. Quit / Esc / Ctrl-C breaks the loop and returns,
  // which lets the calling main() exit naturally.
  //
  // try/finally below is load-bearing: the loop body keeps stdin
  // ref'd so the picker's keypress events fire. If we just `return`
  // on Quit, stdin stays ref'd and Node's event loop never empties
  // → the `lazyclaw` process hangs forever after the user picked
  // Quit. The finally explicitly pauses + unrefs stdin so the
  // process exits cleanly the moment the user picks Quit.
  try {
  while (true) {
    // First-run / config-missing guard: a fresh install has no
    // `provider` set, so any menu pick that calls a provider would
    // error halfway through. Funnel through cmdSetup before
    // rendering the menu the first time around.
    let cfg = readConfig();
    if (!cfg.provider) {
      try { await cmdSetup(undefined, [], {}); }
      catch (e) {
        process.stderr.write(`setup error: ${e?.message || e}\n`);
      }
      cfg = readConfig();
      if (!cfg.provider) {
        process.stdout.write('\n  Setup not completed — exiting.\n  Run `lazyclaw setup` when ready, then try `lazyclaw` again.\n\n');
        return;
      }
    }
    const provider = cfg.provider;
    const model = cfg.model || '(default)';

    // Re-establish stdin in raw / ref'd mode. A previous iteration
    // (e.g. `chat`) deliberately paused + unref'd stdin in its
    // exit-cleanup path so the process could end on /exit; now that
    // we want to keep going, re-attach.
    const readline = await import('node:readline');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.ref();

    const useLegacyBanner = !!process.env.LAZYCLAW_LEGACY_MENU;
    const bannerRowsCached = useLegacyBanner
      ? _renderBanner(readVersionFromRepo())
      : await _renderV5Banner(readVersionFromRepo());
    const draw = () => {
      process.stdout.write('\x1b[?25l\x1b[2J\x1b[H'); // hide cursor + clear
      bannerRowsCached.forEach((l) => process.stdout.write(l + '\n'));
      process.stdout.write('\n');
      process.stdout.write(`  ${dim('provider ·')} ${ok(provider)}\n`);
      process.stdout.write(`  ${dim('model    ·')} ${ok(model)}\n`);
      process.stdout.write(`  ${dim('config   ·')} ${dim(configPath())}\n`);
      process.stdout.write('\n');
      process.stdout.write(`  ${dim('↑/↓ to move · Enter to select · / for slash command (e.g. /exit) · q or Esc to quit')}\n\n`);
      const rowsAvail = Math.max(items.length, (process.stdout.rows || 30) - 14);
      const fromIdx = Math.max(0, Math.min(items.length - rowsAvail, idx - Math.floor(rowsAvail / 2)));
      const toIdx = Math.min(items.length, fromIdx + rowsAvail);
      for (let i = fromIdx; i < toIdx; i++) {
        const it = items[i];
        const marker = i === idx ? accent('❯ ') : '  ';
        const lbl = i === idx ? bold(it.label.padEnd(11)) : it.label.padEnd(11);
        process.stdout.write(`${marker}${lbl}  ${dim(it.desc)}\n`);
      }
      process.stdout.write('\n');
    };

    // Slash-command mini prompt rendered just below the menu. Lets users
    // type `/exit` / `/quit` / `/help` to leave (or get a list of slash
    // commands) without hunting for the right special key. The menu is
    // raw-mode and never sees a newline-terminated line, so we accumulate
    // keystrokes locally instead of round-tripping through readline.
    let slashBuffer = null; // null = menu mode; string = slash mode (always starts with '/')
    let slashNotice = '';   // one-line hint shown after the buffer (e.g. "unknown command")
    const LAUNCHER_SLASH_HELP = [
      { cmd: '/exit',    help: 'leave lazyclaw' },
      { cmd: '/quit',    help: 'alias for /exit' },
      { cmd: '/help',    help: 'list slash commands' },
      { cmd: '/version', help: 'print version + node + platform' },
    ];
    const drawWithSlash = () => {
      draw();
      process.stdout.write(`  ${dim('slash ›')} ${slashBuffer}`);
      if (slashNotice) process.stdout.write(`   ${slashNotice}`);
      process.stdout.write('\x1b[?25h'); // show cursor while typing
    };

    draw();
    const picked = await new Promise((resolve) => {
      const onKey = (str, key) => {
        if (!key) return;

        // ── Slash-command input mode ─────────────────────────────────
        if (slashBuffer !== null) {
          if (key.ctrl && key.name === 'c') { cleanup(); resolve({ id: 'quit', argv: null }); return; }
          if (key.name === 'escape') { slashBuffer = null; slashNotice = ''; draw(); return; }
          if (key.name === 'return') {
            const cmd = slashBuffer.trim().toLowerCase();
            if (cmd === '/exit' || cmd === '/quit') { cleanup(); resolve({ id: 'quit', argv: null }); return; }
            if (cmd === '/help') {
              slashBuffer = '/';
              slashNotice = dim(LAUNCHER_SLASH_HELP.map(c => `${c.cmd} (${c.help})`).join(' · '));
              drawWithSlash();
              return;
            }
            if (cmd === '/version') {
              const v = readVersionFromRepo();
              slashNotice = ok(`v${v} · node ${process.version} · ${process.platform}-${process.arch}`);
              drawWithSlash();
              return;
            }
            // Unknown command — keep the buffer so the user can edit it
            // rather than retyping from scratch. Esc / Backspace bails.
            slashNotice = warn(`unknown — try ${LAUNCHER_SLASH_HELP.map(c => c.cmd).join(' · ')}`);
            drawWithSlash();
            return;
          }
          if (key.name === 'backspace') {
            slashNotice = '';
            if (slashBuffer.length > 1) slashBuffer = slashBuffer.slice(0, -1);
            else slashBuffer = null;
            slashBuffer === null ? draw() : drawWithSlash();
            return;
          }
          // Append printable characters. Filter control / meta chords so
          // Ctrl+L etc. don't pollute the buffer.
          if (str && str.length === 1 && !key.ctrl && !key.meta && str >= ' ') {
            slashBuffer += str;
            slashNotice = '';
            drawWithSlash();
          }
          return;
        }

        // ── Menu navigation mode ─────────────────────────────────────
        if (key.name === 'up')        { idx = (idx - 1 + items.length) % items.length; draw(); }
        else if (key.name === 'down') { idx = (idx + 1) % items.length; draw(); }
        else if (key.name === 'home') { idx = 0; draw(); }
        else if (key.name === 'end')  { idx = items.length - 1; draw(); }
        else if (key.name === 'pageup')   { idx = Math.max(0, idx - 5); draw(); }
        else if (key.name === 'pagedown') { idx = Math.min(items.length - 1, idx + 5); draw(); }
        else if (key.name === 'return')   { cleanup(); resolve(items[idx]); }
        else if (key.ctrl && key.name === 'c') { cleanup(); resolve({ id: 'quit', argv: null }); }
        else if (key.name === 'escape' || key.name === 'q') { cleanup(); resolve({ id: 'quit', argv: null }); }
        else if (str === '/') { slashBuffer = '/'; slashNotice = ''; drawWithSlash(); }
        function cleanup() {
          process.stdin.off('keypress', onKey);
          if (process.stdin.setRawMode) process.stdin.setRawMode(false);
          process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
        }
      };
      process.stdin.on('keypress', onKey);
    });

    if (!picked || picked.id === 'quit' || !picked.argv) {
      // v3.99.28 — break out of the while loop, fall through the
      // finally (stdin cleanup), then hit the explicit process.exit(0)
      // at the function tail. Previously this was `return`, which
      // jumped over the explicit exit and left dangling timers /
      // sockets (ollama probe, registry retry, etc.) keeping the
      // event loop alive — visible to the user as "Quit didn't quit."
      break;
    }

    // Two menu items need a follow-up question before they can run:
    // agent (prompt body), browse (URL). Ask once, then dispatch.
    let argv = picked.argv;
    if (picked.promptForBody) {
      const body = await _quickPrompt('prompt: ');
      if (!body) continue; // back to menu
      argv = ['agent', body];
    } else if (picked.promptForUrl) {
      const url = await _quickPrompt('url: ');
      if (!url) continue; // back to menu
      argv = ['browse', url];
    }

    // Dispatch. Errors don't terminate the launcher — they're
    // surfaced as a stderr line and the menu redraws. Lets the
    // user recover from a transient API hiccup without a relaunch.
    try {
      await _dispatchMenuChoice(argv);
    } catch (e) {
      process.stderr.write(`\n  ${accent('✗')} ${e?.message || String(e)}\n`);
    }

    // Pause before re-drawing so the user can read the subcommand's
    // output. `chat` is the special case: its REPL has already kept
    // the user oriented for a long session, and they typed /exit
    // explicitly, so jumping straight back to the menu reads as
    // "ok, done with that conversation, back to the dashboard."
    if (picked.id !== 'chat') {
      process.stdout.write('\n');
      await _quickPrompt(`  ${dim('Press Enter to return to the menu… ')}`);
    }
  }
  } finally {
    // Drop the stdin holds we kept open while the menu was active.
    // Without this, the Node event loop never empties on Quit and
    // the `lazyclaw` process hangs at the shell prompt. Mirrors the
    // cleanup path cmdChat installed in v3.92 for the same reason.
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try { process.stdin.setRawMode(false); } catch (_) {}
    }
    try { process.stdout.write('\x1b[?25h'); } catch (_) {} // restore cursor
    try { process.stdin.pause(); } catch (_) {}
    try { process.stdin.unref(); } catch (_) {}
  }
  // User reached the end of the launcher session — Quit / Esc / q /
  // /exit / /quit / Ctrl-C, or a failed first-run setup. Skip the
  // natural-exit wait and terminate now: a previously imported
  // subcommand (ollama auto-start probe, registry caches, retry timers,
  // etc.) may have registered an interval or socket that keeps the
  // event loop alive for several seconds. Ctrl-C exits immediately;
  // /exit and Quit should feel the same.
  process.exit(0);
}

