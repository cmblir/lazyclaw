// commands/setup.mjs — onboarding + setup wizard, extracted from cli.mjs
// (D7). Verbatim move of applyOnboardConfig, cmdOnboard, HELP_SUMMARIES,
// HELP_DETAILS, cmdHelp, cmdSetup. The interactive launcher
// (_runFirstTimeOnboard, _DispatchExit, _dispatchMenuChoice, cmdLauncher)
// was further split out into commands/launcher.mjs to stay under the
// lint:size ratchet; cmdLauncher is re-exported below so cli.mjs's
// external call site is unchanged.
// Dynamic-import paths were rebased ./ -> ../ (so ./commands/X became
// ../commands/X, which resolves to the sibling), and the cmdChat calls
// lazy-import ./chat.mjs to break the setup <-> chat cycle.
import path from 'node:path';
import {
  configPath, readConfig, writeConfig,
  _resolveAuthKey, _resolveBaseUrl, readVersionFromRepo,
} from '../lib/config.mjs';
import { ensureRegistry, requireRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { SUBCOMMANDS, parseArgs } from '../lib/args.mjs';
import { runPermissionStep } from './setup_permission.mjs';
import { runWizardSteps } from '../tui/wizard_back.mjs';
import { promptWithBack } from '../tui/prompt_back.mjs';
import {
  _attachGhostAutocomplete, _fetchModelsForProvider, _pauseChatForSubMenu,
  _pickModelInteractive, _pickProviderInteractive, _printChatBanner,
  _quickPrompt, _quickPromptSecret,
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
    // _arrowMenu unrefs stdin and createInterface only resumes; without ref()
    // the prompts below never resolve. See tests/f-onboard-stdin-ref.
    process.stdin.resume();
    if (process.stdin.ref) process.stdin.ref();
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

export { cmdLauncher } from './launcher.mjs';
