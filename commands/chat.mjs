// commands/chat.mjs — interactive chat REPL (cmdChat), extracted from cli.mjs (D7).
// Verbatim move: the Ink/React path, the readline loop, and in-chat slash
// handling are unchanged. Only dynamic-import paths were rebased ./ -> ../,
// and the single cmdSetup call now lazy-imports ./setup.mjs so the
// chat <-> setup cycle is broken at the dynamic-import boundary.
import path from 'node:path';
import {
  configPath, readConfig, writeConfig,
  persistActiveModel, persistActiveProvider,
  _resolveAuthKey, _resolveBaseUrl, readVersionFromRepo,
} from '../lib/config.mjs';
import { ensureRegistry, requireRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { SUBCOMMANDS, parseArgs, AGENT_REG_SUBS } from '../lib/args.mjs';
import { LAZYCLAW_META_GUARD } from '../lib/nl_config_command.mjs';
import {
  _attachGhostAutocomplete, _fetchModelsForProvider,
  _pickProviderInteractive, _printChatBanner,
  _quickPrompt, _renderBanner, _renderV5Banner,
} from '../tui/pickers.mjs';
import { firstRunMode as _firstRunMode, hasConfiguredProvider } from '../first_run.mjs';
import { applyChatWindow as _applyChatWindow, estimateMessagesTokens, CHAT_WINDOW_TURNS, CHAT_WINDOW_TOKEN_BUDGET } from '../chat_window.mjs';
import { makeRunTurn as _chatRunTurnFactory } from '../tui/run_turn.mjs';
import { hudStatus as _hudStatus } from '../tui/hud.mjs';
import { dispatchSlash as _dispatchSlash, parseSlashLine as _parseSlashLine, _makeInkApprove } from '../tui/slash_dispatcher.mjs';
import { wrapInteractiveProv, makeLegacyApprove } from './chat_hardening.mjs';
import { makeLegacySlashHandler } from './chat_legacy_slash.mjs';
// Re-export so tests that import legacySlashRoute from ./chat.mjs keep working
// after the legacy slash router was extracted to ./chat_legacy_slash.mjs.
export { legacySlashRoute } from './chat_legacy_slash.mjs';

// /new, /reset and /clear must signal the Ink REPL to wipe the screen +
// scrollback via the 'NEW' sentinel (handled in tui/repl.mjs). _newReset itself
// returns a human string for the string-rendering consumers, so the Ink handler
// translates these commands here. Exported so the contract is unit-testable.
export function _isInkResetCmd(cmd) {
  return /^\/(new|reset|clear)$/i.test(String(cmd || ''));
}

// The legacy (non-Ink) readline slash router (legacySlashRoute,
// LEGACY_DELEGATED_SLASHES, and the ~650-line hand-written switch) lives in
// ./chat_legacy_slash.mjs now. cmdChat builds it via makeLegacySlashHandler
// (imported above) and legacySlashRoute is re-exported above for tests.

export async function cmdChat(flags = {}) {
  await ensureRegistry();
  const sessionsMod = await import('../sessions.mjs');
  const skillsMod = await import('../skills.mjs');
  let cfg = readConfig();
  // Mutable in-REPL state: /provider and /model edit these without
  // touching config.json on disk. The CLI flag form (`chat --provider X`)
  // would normally seed these via cfg, but we leave that to a future
  // iteration; today the slash commands work against the on-disk default.
  let activeProvName = cfg.provider || '';
  let activeModel = cfg.model || null;
  const lookupProv = (name) => getRegistry().PROVIDERS[name];
  // First-run routing: a genuine fresh install (no provider, interactive)
  // gets the full 5-step guided setup (provider+model, workspace, skills) —
  // not just the provider picker. `chat --pick` stays a lightweight re-pick.
  const _mode = _firstRunMode({
    hasProvider: hasConfiguredProvider(activeProvName),
    flagPick: !!flags.pick,
    isTTY: !!process.stdin.isTTY,
  });
  if (_mode === 'setup') {
    try { await (await import('./setup.mjs')).cmdSetup(undefined, [], {}); }
    catch (e) { if (process.env.LAZYCLAW_DEBUG) console.error('[setup] fell through:', e?.message); }
    // Re-read the config the wizard just wrote so this session uses it.
    cfg = readConfig();
    activeProvName = cfg.provider || activeProvName;
    activeModel = cfg.model || activeModel;
  } else if (_mode === 'pick') {
    const picked = await _pickProviderInteractive();
    if (picked && picked.provider) {
      activeProvName = picked.provider;
      if (picked.model) activeModel = picked.model;
    }
  }
  // Last-resort safety net. v5.3.2 stopped falling through to 'mock' (which
  // silently degraded a wiped config into garbage replies); default to the
  // keyless claude-cli, but say so instead of switching silently.
  if (!activeProvName) {
    if (process.stdout.isTTY) {
      process.stdout.write('  setup not completed — defaulting to claude-cli (keyless subscription). Run `lazyclaw setup` to configure a provider/model, workspace, and skills.\n');
    }
    activeProvName = 'claude-cli';
  }
  let prov = wrapInteractiveProv(lookupProv(activeProvName));  // transient-retry the chat hot path
  if (!prov) { console.error(`unknown provider: ${activeProvName}`); process.exit(2); }

  // First-turn key preflight: warn up front when the active provider needs an
  // API key but none resolves, instead of letting the first turn fail opaquely.
  // Cheap (no network); TTY-only so pipelines aren't spammed.
  if (process.stdout.isTTY) {
    const _meta = (getRegistry().PROVIDER_INFO || {})[activeProvName] || {};
    if (_meta.requiresApiKey && !_resolveAuthKey(cfg, activeProvName)) {
      process.stdout.write(`  ⚠ no API key found for ${activeProvName} — the first message will fail until you set one.\n`);
      process.stdout.write(`    fix: /provider (pick + paste a key) · or  lazyclaw auth add ${activeProvName}\n`);
    }
  }

  // Top-of-session banner so the user can see at a glance what they're
  // talking to. Cheap (no provider call) and TTY-only.
  // v5 ink splash + REPL when stdin is a real TTY and the user has not
  // opted out via LAZYCLAW_NO_INK=1. Non-TTY pipelines and the opt-out
  // env var fall through to the v4 figlet + readline path unchanged.
  const __useInkSplash = process.stdout.isTTY && !process.env.LAZYCLAW_NO_INK;
  if (__useInkSplash) {
    try {
      const React = (await import('react')).default;
      const { render } = await import('ink');
      const { ReplApp } = await import('../tui/repl.mjs');
      const { renderSplashToString } = await import('../tui/splash.mjs');
      // narrow-terminal fallback: <60 cols falls back to v4
      if ((process.stdout.columns || 80) < 60) throw new Error('narrow-terminal');

      // Tool + skill groups for the splash panel — shared with the setup wizard.
      const { gatherToolAndSkillGroups } = await import('../tui/splash_props.mjs');
      const { tools: toolGroups, skills: skillGroups } =
        await gatherToolAndSkillGroups(path.dirname(configPath()));

      const splashProps = {
        provider: activeProvName, model: activeModel,
        trainer: {}, sessionId: flags.session || '',
        cwd: process.cwd(),
        version: readVersionFromRepo(),
        tools: toolGroups,
        skills: skillGroups,
      };
      void renderSplashToString; // surfaced for tests; runtime uses <Splash/>

      // C7 — minimal chat-session state for the ink path so runTurn can talk to
      // the provider. The legacy readline path below sets up the same shape
      // (kept duplicated so each branch stays self-contained).
      let _inkSandboxSpec = null;
      if (flags.sandbox) {
        const sb = await import('../sandbox.mjs');
        try { _inkSandboxSpec = sb.parseSandboxSpec(flags.sandbox, flags); }
        catch (err) { console.error(`error: ${err.message}`); process.exit(2); }
      }
      let _inkSessionId = flags.session || null;
      const _inkCfgDir = path.dirname(configPath());
      let _inkMessages = _inkSessionId
        ? sessionsMod.loadTurns(_inkSessionId, _inkCfgDir).map((t) => ({ role: t.role, content: t.content }))
        : [];
      if (_inkMessages.length > 0) {
        const cfgChat = cfg.chat || {};
        const winTurns = Number(cfgChat.windowTurns) || CHAT_WINDOW_TURNS;
        const winTokens = Number(cfgChat.windowTokens) || CHAT_WINDOW_TOKEN_BUDGET;
        const { messages: trimmed } = _applyChatWindow(_inkMessages, { turns: winTurns, tokens: winTokens });
        _inkMessages = trimmed;
      }
      // System prompt composition — mirrors the legacy path's sysParts logic.
      const _inkSkillNames = (flags.skill ? String(flags.skill) : (Array.isArray(cfg.skills) ? cfg.skills.join(',') : ''))
        .split(',').map((s) => s.trim()).filter(Boolean);
      const _inkWorkspaceName = flags.workspace || cfg.workspace || '';
      const _inkSysParts = [];
      try {
        const { composePromptStack } = await import('../mas/prompt_stack.mjs');
        const stacked = composePromptStack({
          cfgDir: _inkCfgDir,
          agent: { name: 'chat', role: '' },
          workspace: _inkWorkspaceName,
        });
        if (stacked && stacked.trim()) _inkSysParts.push(stacked);
      } catch { /* never block chat start on stack composition */ }
      if (_inkWorkspaceName && !_inkMessages.some((m) => m.role === 'system')) {
        try {
          const ws = await import('../workspace.mjs');
          const wsPrompt = ws.composeWorkspacePrompt(_inkCfgDir, _inkWorkspaceName);
          if (wsPrompt) _inkSysParts.push(wsPrompt);
        } catch (err) { console.error(`workspace error: ${err.message}`); process.exit(2); }
      }
      if (_inkSkillNames.length > 0 && !_inkMessages.some((m) => m.role === 'system')) {
        try {
          const sys = skillsMod.composeSystemPrompt(_inkSkillNames, _inkCfgDir);
          if (sys) _inkSysParts.push(sys);
        } catch (err) { console.error(`skill error: ${err.message}`); process.exit(2); }
      }
      if (_inkSysParts.length && !_inkMessages.some((m) => m.role === 'system')) {
        const merged = [..._inkSysParts, LAZYCLAW_META_GUARD].join('\n\n---\n\n');
        _inkMessages.unshift({ role: 'system', content: merged });
        if (_inkSessionId) sessionsMod.appendTurn(_inkSessionId, 'system', merged, _inkCfgDir);
      }
      let _inkRunningUsage = null;
      const _inkAccumulateUsage = (u) => {
        if (!u) return;
        if (!_inkRunningUsage) _inkRunningUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, turnsWithUsage: 0 };
        _inkRunningUsage.inputTokens  += Number(u.inputTokens) || 0;
        _inkRunningUsage.outputTokens += Number(u.outputTokens) || 0;
        _inkRunningUsage.totalTokens  += Number(u.totalTokens) || ((Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0));
        _inkRunningUsage.turnsWithUsage += 1;
      };
      const _inkChatStartedAt = Date.now();
      const _inkSyntheticChatSessionId = `chat-${process.pid}-${_inkChatStartedAt}`;
      const _inkPersistTurn = (role, content) => {
        if (_inkSessionId) {
          sessionsMod.appendTurn(_inkSessionId, role, content, _inkCfgDir);
          return;
        }
        try {
          import('../memory.mjs').then((m) => {
            try { m.appendRecent(_inkSyntheticChatSessionId, role, content, _inkCfgDir); }
            catch { /* swallow */ }
          }).catch(() => {});
        } catch { /* swallow */ }
      };
      // v5.4: chars-sent counter for the Ink path (mirrors legacy `charsSent`).
      let _inkCharsSent = 0;
      const _inkCtx = {
        cfg,
        cfgDir: _inkCfgDir,
        sandboxSpec: _inkSandboxSpec,
        syntheticChatSessionId: _inkSyntheticChatSessionId,
        version: readVersionFromRepo(),
        registryMod: getRegistry(),
        sessionsMod,
        // Pre-imported so dispatcher avoids a dynamic import per /skill call.
        skillsMod,
        getMessages: () => _inkMessages,
        setMessages: (next) => { _inkMessages = Array.isArray(next) ? next : []; },
        getProv: () => prov,
        setProv: (next) => { prov = wrapInteractiveProv(next); },
        lookupProv,
        getActiveProvName: () => activeProvName,
        // Persist provider/model picks so they survive a restart (was
        // in-memory only — a model chosen via /model reverted to cfg.model on
        // the next launch). persistActiveProvider leaves orchestrator routing
        // to /orchestrator on|off.
        setActiveProvName: (name) => { activeProvName = name; persistActiveProvider(cfg, name); },
        getActiveModel: () => activeModel,
        setActiveModel: (name) => { activeModel = name; persistActiveModel(cfg, name); },
        getSessionId: () => _inkSessionId,
        setSessionId: (id) => { _inkSessionId = id; },
        getCharsSent: () => _inkCharsSent,
        setCharsSent: (n) => { _inkCharsSent = Number(n) || 0; },
        getRunningUsage: () => _inkRunningUsage,
        setRunningUsage: (u) => { _inkRunningUsage = u; },
        persistTurn: _inkPersistTurn,
        accumulateUsage: _inkAccumulateUsage,
        resolveAuthKey: (providerName) => _resolveAuthKey(cfg, providerName),
        resolveBaseUrl: (providerName) => _resolveBaseUrl(providerName),
        onCharsSent: (n) => { _inkCharsSent += Number(n) || 0; },
        // P2 — /provider add read-merge-writes config.json from the Ink session.
        readConfig: () => readConfig(),
        writeConfig: (next) => writeConfig(next),
      };
      // v5.4.3 — ReplApp exposes an openPicker(opts) → Promise<id|null>
      // via this ref. The slash dispatcher reads it through ctx.openPicker
      // to drive /provider, /model, /personality without forking off raw
      // stdin from Ink. When ReplApp hasn't populated the ref yet (early
      // mount / non-Ink path) the dispatcher falls back to its hint
      // string so users aren't stranded.
      const _inkPickerRef = { current: null };
      _inkCtx.openPicker = (opts) => {
        const api = _inkPickerRef.current;
        return api && typeof api.openPicker === 'function'
          ? api.openPicker(opts)
          : Promise.resolve(null);
      };
      _inkCtx.approve = _makeInkApprove(_inkCtx); // agentic sensitive tools → Ink approval modal
      // Route streamed chunks through ReplApp's injected writeFn: chunks
      // land in React state (liveAssistant) → live region → committed to
      // the <Static/> scrollback on turn-complete, so Ink owns all output.
      // Writing straight to process.stdout (the old v5.1 hack) put replies
      // in Ink's live frame, which the next render erased — replies vanished.
      const _inkRunTurnFactory = (writeFn) => _chatRunTurnFactory({
        ctx: _inkCtx,
        writeFn,
      });
      // v5.4: full slash-command dispatch via tui/slash_dispatcher.mjs.
      // Dispatcher returns a string (rendered to scrollback by ReplApp),
      // 'EXIT' (caller unmounts), or void (streamed via write). /exit and
      // /quit are also intercepted earlier inside ReplApp.handleSubmit so
      // either path terminates cleanly.
      const _inkSlashHandler = async (line, signal) => {
        const { cmd, args } = _parseSlashLine(line);
        // Thread the REPL's abort signal so Esc/Ctrl-C can stop a /loop.
        _inkCtx.loopSignal = signal || null;
        const result = await _dispatchSlash(cmd, args, _inkCtx, (chunk) => {
          try { process.stdout.write(chunk); } catch { /* swallow */ }
        });
        // _newReset (/new, /reset, /clear) returns a human string, but repl.mjs
        // only wipes the screen + scrollback on the 'NEW' sentinel. Translate
        // here (mirrors the 'EXIT' sentinel) so the real /new actually clears.
        if (_isInkResetCmd(cmd)) return 'NEW';
        return result;
      };
      // v6.x slash-argument completion (two surfaces, see tui/slash_args.mjs):
      //   onArgList     → inline candidates rendered in the popup (login, hud,
      //                   memory, config, channels, subcommands, names, …).
      //   onArgComplete → Tab opens the drill-in modal for 2-step provider→model
      //                   specs (/model, /trainer set, /orchestrator planner).
      // Both resolve through _inkCtx (its openPicker IS ReplApp's modal; its
      // cfgDir/registry feed the inline lists).
      const { argSpecFor: _argSpecFor, runArgCompleter: _runArgCompleter, listArgCandidates: _listArgCandidates } = await import('../tui/slash_args.mjs');
      const { SLASH_COMMANDS: _ARG_CATALOG } = await import('../tui/slash_commands.mjs');
      const _argRegistry = await import('../providers/registry.mjs');
      const _inkArgComplete = async (buffer) => {
        try {
          const spec = _argSpecFor(buffer, _ARG_CATALOG);
          if (!spec || spec.kind !== 'modal') return null;
          return await _runArgCompleter(spec, _inkCtx, _argRegistry);
        } catch { return null; }
      };
      const _inkArgList = (buffer) => {
        try {
          const spec = _argSpecFor(buffer, _ARG_CATALOG);
          if (!spec || spec.kind !== 'inline') return [];
          return _listArgCandidates(spec, _inkCtx, _argRegistry);
        } catch { return []; }
      };
      // v5.4.1: splash renders INSIDE the alt-buffer (not pre-printed to
      // primary). The v5.4.0 pre-print made the screen go blank during
      // chat because alt-buffer cleared it on enter. Splash lives in the
      // Static scrollback now regardless of alt-buffer state.
      const ink = render(/* @__PURE__ */ React.createElement(ReplApp, {
        splashProps,
        statusInfo: { provider: activeProvName, model: activeModel },
        // P3 — live status: provider/model + history-based ctx gauge (not the
        // provider's self-reported per-call usage) + the HUD field bundle.
        getStatus: () => ({
          provider: activeProvName,
          model: activeModel,
          ctxUsed: estimateMessagesTokens(_inkMessages),
          ctxTotal: Number((cfg.chat || {}).windowTokens) || CHAT_WINDOW_TOKEN_BUDGET,
          hud: _hudStatus(cfg, _inkRunningUsage),
        }),
        runTurnFactory: _inkRunTurnFactory,
        onSlashCommand: _inkSlashHandler,
        onArgComplete: _inkArgComplete,
        onArgList: _inkArgList,
        pickerRef: _inkPickerRef,
      }), { exitOnCtrlC: false, patchConsole: true }); // false → editor 2-stage Ctrl+C
      await ink.waitUntilExit();
      // /setup → full wizard (then shell). /config single step → run JUST
      // that step now that Ink released stdin, then re-enter chat.
      if (_inkCtx.requestSetup) await (await import('./setup.mjs')).cmdSetup(undefined, [], {});
      else if (_inkCtx.requestConfigStep) {
        await (await import('./config_step.mjs')).runConfigStep(_inkCtx.requestConfigStep);
        return cmdChat(flags);
      } else if (_inkCtx.requestLogin) {
        // Connect a keyless CLI provider in the foreground (Ink freed stdin), re-enter.
        await (await import('../providers/cli_login.mjs')).runCliLoginInteractive(_inkCtx.requestLogin);
        return cmdChat(flags);
      }
      return;
    } catch (e) {
      // Fall through to the legacy readline path on any ink failure. ALWAYS
      // say why, in one dim line — the silent downgrade made real-terminal
      // failures (node incompat, <60-col windows) undiagnosable from reports.
      process.stderr.write(`\x1b[2m(ink UI unavailable: ${e?.message || e} — using the legacy reader)\x1b[0m\n`);
    }
  }
  // ─── legacy v4 path (unchanged) ─────────────────────────────────
  await _printChatBanner(activeProvName, activeModel, readVersionFromRepo());

  const readline = await import('node:readline');
  // Use terminal:true when we're attached to a TTY so the prompt shows
  // and ghost-text autocomplete (below) can render. Falls back to the
  // plain non-terminal mode for piped/non-TTY callers.
  const useTerminal = !!process.stdin.isTTY;
  // The readline interface is created *adjacent* to the for-await loop below
  // (after all the async setup), not here. On node 20 a piped (non-TTY)
  // stdin emits its lines + EOF during the `await import(...)` setup that
  // runs before the loop; if the interface already exists, the async
  // iterator hasn't attached yet and those lines are dropped — the chat
  // produced no output on Linux CI (node 20) while passing on macOS (node
  // 22, which tolerates the gap). Declaring rl/_ghost here keeps handleSlash's
  // closures resolvable; the actual createInterface happens just-in-time.
  let rl;
  let _ghost = { dispose: () => {}, suspend: () => {}, resume: () => {} };

  // --sandbox docker:<image> wraps subprocess-providers (claude-cli)
  // in a docker container. Parsed once up front so a slash-command
  // model switch doesn't have to re-parse every turn.
  let sandboxSpec = null;
  if (flags.sandbox) {
    const sb = await import('../sandbox.mjs');
    try { sandboxSpec = sb.parseSandboxSpec(flags.sandbox, flags); }
    catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  }

  // Persistent session ID. When --session is set we hydrate prior turns from
  // <configDir>/sessions/<id>.jsonl and append every new turn back to it.
  // Without --session, chat is in-memory only (matches phase 4 behavior).
  // Mutable so /goal <name> can switch the working context mid-session.
  let sessionId = flags.session || null;
  // Currently-active goal name when the user has switched context via
  // /goal <name>. Tracked so /status can surface it and so future ticks
  // know which goal to attribute new turns to.
  let activeGoalName = null;
  const cfgDir = path.dirname(configPath());
  let messages = sessionId
    ? sessionsMod.loadTurns(sessionId, cfgDir).map(t => ({ role: t.role, content: t.content }))
    : [];

  // M6 — apply sliding window at session start. Long-running sessions
  // (50+ turns) used to ship every prior turn to the provider every
  // request; we now keep at most CHAT_WINDOW_TURNS turns (default 20)
  // plus the system message. Operators can override via env. The
  // per-session log on disk is untouched — only the in-memory prompt
  // window is trimmed. We log to stderr once at session start so the
  // user knows context was dropped.
  if (messages.length > 0) {
    const cfgChat = cfg.chat || {};
    const winTurns = Number(cfgChat.windowTurns) || CHAT_WINDOW_TURNS;
    const winTokens = Number(cfgChat.windowTokens) || CHAT_WINDOW_TOKEN_BUDGET;
    const { messages: trimmed, dropped } = _applyChatWindow(messages, { turns: winTurns, tokens: winTokens });
    if (dropped > 0) {
      process.stderr.write(`[chat] sliding window: dropped ${dropped} older turn(s), ${trimmed.length} kept\n`);
    }
    messages = trimmed;
  }

  // --skill (comma-separated names) composes into a system message at the
  // head of the conversation. Same shape as `agent --skill`. Defaults from
  // config.skills array when --skill not passed. We only inject if no
  // system message is already present (so resuming a session doesn't
  // double-prepend skills that the prior invocation already added).
  const skillNames = (flags.skill ? String(flags.skill) : (Array.isArray(cfg.skills) ? cfg.skills.join(',') : ''))
    .split(',').map(s => s.trim()).filter(Boolean);
  // --workspace <name> sits at the head of the system prompt, then
  // any --skill block. The two compose with the same `\n---\n`
  // separator the agent path uses, so `lazyclaw workspace show` is
  // a faithful preview.
  const workspaceName = flags.workspace || cfg.workspace || '';
  const sysParts = [];
  // v5 (canonical decision C5) — prepend the 8-layer composePromptStack
  // output. Falls back silently to no-op when the configDir has none of
  // the source files present (fresh install) so chat-start stays
  // byte-identical to the v4 shape until a user authors USER.md or a
  // personality. Wrapped in try/catch — chat start must never break on
  // a stack composition error.
  try {
    const { composePromptStack } = await import('../mas/prompt_stack.mjs');
    const stacked = composePromptStack({
      cfgDir,
      agent: { name: 'chat', role: '' },
      workspace: workspaceName,
    });
    if (stacked && stacked.trim()) sysParts.push(stacked);
  } catch { /* never block chat start on stack composition */ }
  if (workspaceName && !messages.some(m => m.role === 'system')) {
    try {
      const ws = await import('../workspace.mjs');
      const wsPrompt = ws.composeWorkspacePrompt(cfgDir, workspaceName);
      if (wsPrompt) sysParts.push(wsPrompt);
    } catch (e) { console.error(`workspace error: ${e.message}`); process.exit(2); }
  }
  if (skillNames.length > 0 && !messages.some(m => m.role === 'system')) {
    try {
      const sys = skillsMod.composeSystemPrompt(skillNames, cfgDir);
      if (sys) sysParts.push(sys);
    } catch (e) {
      console.error(`skill error: ${e.message}`);
      process.exit(2);
    }
  }
  if (sysParts.length && !messages.some(m => m.role === 'system')) {
    const merged = [...sysParts, LAZYCLAW_META_GUARD].join('\n\n---\n\n');
    messages.unshift({ role: 'system', content: merged });
    if (sessionId) sessionsMod.appendTurn(sessionId, 'system', merged, cfgDir);
  }

  let charsSent = messages.reduce((n, m) => n + (m.role === 'user' ? String(m.content || '').length : 0), 0);
  if (sessionId && messages.length > (skillNames.length > 0 ? 1 : 0)) {
    process.stdout.write(`resumed session ${sessionId} with ${messages.length} prior turn(s)\n`);
  }
  // Running usage accumulator. /usage reports both the cheap local
  // estimate (messageCount + charsSent) AND the provider-reported
  // totals when the provider emits them on each turn. Mock provider
  // doesn't emit usage, so usage stays null there — no surprise.
  /** @type {{ inputTokens: number, outputTokens: number, totalTokens: number, turnsWithUsage: number } | null} */
  let runningUsage = null;
  const accumulateUsage = (u) => {
    if (!u) return;
    if (!runningUsage) runningUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, turnsWithUsage: 0 };
    runningUsage.inputTokens  += Number(u.inputTokens) || 0;
    runningUsage.outputTokens += Number(u.outputTokens) || 0;
    runningUsage.totalTokens  += Number(u.totalTokens) || ((Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0));
    runningUsage.turnsWithUsage += 1;
  };
  // v5 Group A (M2): always-on synthetic session id so an unsessioned
  // chat still populates memory/recent.jsonl. Without this, the nudge
  // loop never saw repeated prompts in chat sessions that didn't pass
  // --session, and `nudge.suggest_skill` clusters silently lost ~95%
  // of their evidence. The `chat-<pid>-<startTs>` prefix keeps the
  // synthetic id distinguishable from real session ids on disk.
  const chatStartedAt = Date.now();
  const _syntheticChatSessionId = `chat-${process.pid}-${chatStartedAt}`;
  const persistTurn = (role, content) => {
    if (sessionId) {
      sessionsMod.appendTurn(sessionId, role, content, cfgDir);
      return;
    }
    // No --session: don't touch sessions/<id>.jsonl, but DO append to
    // memory/recent.jsonl directly so the nudge loop can cluster on
    // unsessioned chats. Best-effort — a broken memory module must not
    // break a chat turn.
    try {
      import('../memory.mjs').then((m) => {
        try { m.appendRecent(_syntheticChatSessionId, role, content, cfgDir); }
        catch { /* swallow */ }
      }).catch(() => {});
    } catch { /* swallow */ }
  };

  // C7 — shared runTurn closure for the legacy path. The same factory
  // backs the ink path above; both call sites get one set of bugs.
  // Getters close over the *current* binding of sessionId, prov,
  // activeProvName, activeModel — so a mid-session /provider switch
  // takes effect on the very next turn.
  const _legacyCtx = {
    cfg,
    cfgDir,
    sandboxSpec,
    syntheticChatSessionId: _syntheticChatSessionId,
    getMessages: () => messages,
    getProv: () => prov,
    getActiveProvName: () => activeProvName,
    getActiveModel: () => activeModel,
    getSessionId: () => sessionId,
    persistTurn,
    accumulateUsage,
    resolveAuthKey: (providerName) => _resolveAuthKey(cfg, providerName), onCharsSent: (n) => { charsSent += n; }, approve: makeLegacyApprove(),
  };
  const runTurn = _chatRunTurnFactory({
    ctx: _legacyCtx,
    writeFn: (chunk) => process.stdout.write(chunk),
  });

  // Create the readline interface here — immediately before iterating, with
  // no `await` between — so a non-TTY pipe's buffered lines reach the async
  // iterator (see the note at the rl/_ghost declaration above).
  rl = readline.createInterface({
    input: process.stdin,
    output: useTerminal ? process.stdout : undefined,
    terminal: useTerminal,
    prompt: useTerminal ? '\x1b[38;5;208m›\x1b[0m ' : '',
  });
  if (useTerminal) {
    // Cursor-style ghost autocomplete: when the buffer starts with `/`,
    // render the longest matching command after the cursor in dim grey.
    // Right-arrow at end-of-line accepts. Tab still cycles via the existing
    // handleSlash branch; this only adds the inline preview.
    _ghost = _attachGhostAutocomplete(rl) || _ghost;
    rl.prompt();
  }
  // Build the legacy readline slash router now that rl/_ghost exist (the
  // handler reads them at call time). It lives in ./chat_legacy_slash.mjs to
  // keep this file under its size ceiling; getX/setX accessors keep cmdChat's
  // mutable chat state (provider, model, messages, sessionId, …) live so a
  // mid-session /provider or /goal switch takes effect on the very next turn.
  const _legacyHandleSlash = makeLegacySlashHandler({
    cfg,
    cfgDir,
    lookupProv,
    persistTurn,
    accumulateUsage,
    legacyCtx: _legacyCtx,
    sessionsMod,
    useTerminal,
    sandboxSpec,
    rl,
    ghost: _ghost,
    getActiveProvName: () => activeProvName,
    setActiveProvName: (v) => { activeProvName = v; },
    getActiveModel: () => activeModel,
    setActiveModel: (v) => { activeModel = v; },
    getProv: () => prov,
    setProv: (v) => { prov = v; },
    getMessages: () => messages,
    setMessages: (v) => { messages = v; },
    getCharsSent: () => charsSent,
    setCharsSent: (v) => { charsSent = v; },
    getRunningUsage: () => runningUsage,
    setRunningUsage: (v) => { runningUsage = v; },
    getSessionId: () => sessionId,
    setSessionId: (v) => { sessionId = v; },
    getActiveGoalName: () => activeGoalName,
    setActiveGoalName: (v) => { activeGoalName = v; },
  });

  try { for await (const line of rl) {
    const text = line.trim();
    if (!text) { if (useTerminal) rl.prompt(); continue; }
    if (text.startsWith('/')) {
      const r = await _legacyHandleSlash(text);
      if (r === 'EXIT') break;
      if (useTerminal) rl.prompt();
      continue;
    }
    // Per-turn AbortController. Ctrl+C during a stream aborts THIS turn
    // and returns to the prompt instead of killing the process. Outside
    // a stream, Ctrl+C still terminates (we restore the default handler
    // below, after the try/finally).
    const turnAc = new AbortController();
    const onSigint = () => {
      turnAc.abort();
      process.stdout.write('\n^C interrupted — prompt is back\n');
    };
    process.on('SIGINT', onSigint);
    // Pause the ghost-autocomplete keypress handler while the
    // provider is streaming. Without this, every stale stdin event
    // would trigger `\x1b[s\x1b[K\x1b[u` cursor save/restore writes
    // that interleave with the streamed text and surface as visible
    // gaps between CJK characters (visible in user-reported screen
    // captures of Korean replies).
    if (useTerminal) _ghost.suspend();
    try {
      // C7 — single source of truth for the streaming + persist +
      // post-task learning loop. The factory handles the user-msg push,
      // 30 ms buffered writer (CJK-safe), assistant-msg push,
      // persistTurn for both turns, and the post-task learning hook.
      await runTurn(text, turnAc.signal);
    } finally {
      process.off('SIGINT', onSigint);
      if (useTerminal) _ghost.resume();
    }
    if (useTerminal) rl.prompt();
  } } finally {
    // Clean shutdown — without this, /exit "worked" but the process
    // hung for ~3-5 s while Node waited for stdin's keypress listener
    // and raw mode to release. Tearing them down explicitly drops the
    // exit time to <100 ms.
    try { _ghost.dispose(); } catch (_) {}
    try { rl.close(); } catch (_) {}
    if (useTerminal && process.stdin.isTTY && process.stdin.setRawMode) {
      try { process.stdin.setRawMode(false); } catch (_) {}
    }
    // process.stdin keeps the event loop alive in raw / readline mode.
    // Pause + unref releases the hold so the process can exit cleanly
    // from natural completion (no need for a hard process.exit).
    try { process.stdin.pause(); } catch (_) {}
    try { process.stdin.unref(); } catch (_) {}
  }
  // /config legacy path: re-run the wizard after the readline loop closes.
  // (Inline login is Ink-only — legacy ctx has no openPicker — so no requestLogin.)
  if (_legacyCtx.requestSetup) await (await import('./setup.mjs')).cmdSetup(undefined, [], {});
}

// Light wrapper around the daemon — meant for users who installed
// via npm and don't want to remember `daemon` flags. Boots the
// daemon on a fixed default port (override with --port), then opens
// the dashboard URL in the user's default browser.
//
// Why a separate command: typing `lazyclaw daemon` works too, but
// `dashboard` is the discoverable name and it auto-opens the browser
// (which the bare daemon doesn't, since most daemon callers are
// scripts).
// Best-effort port-occupant kill — macOS / Linux only. Returns true when
// at least one PID was signalled. Used by cmdDashboard so a leftover
// listener from a previous run doesn't crash the launch with EADDRINUSE.
// Mirrors the Python server's auto-kill behaviour described in CLAUDE.md.

// sandbox subcommands — list/test/add/use (Phase D).

// Interactive launcher — fired when the user types `lazyclaw` with
// no subcommand AND we're attached to a TTY. OpenClaw's launcher
// pattern: ASCII banner + provider/model status + arrow-key menu of
// every common action. Selecting a row drops the user into the
// matching subcommand via process.argv mutation + main() re-entry,
// so chat / agent / etc. behave bit-identically to typing them
// directly. Non-TTY (piped, scripted) callers still see the
// classic "Usage: …" line so automation isn't surprised.
// Multi-step setup wizard — OpenClaw-style first-run experience.
// Provider/model/key + optional workspace + optional sample skill
// + reachability ping. Each step can be skipped (Enter on prompt /
// "n" on yes-no). Re-runnable safely: existing state is reused, not
// clobbered, except when the user explicitly opts in.
//
// `lazyclaw setup` exposes this directly so users can re-run the
// wizard any time. The first-run code path also funnels through it
// so a fresh install sees the same flow whether they typed
// `lazyclaw` or `lazyclaw setup`.
