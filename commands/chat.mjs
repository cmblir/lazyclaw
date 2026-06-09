// commands/chat.mjs — interactive chat REPL (cmdChat), extracted from cli.mjs (D7).
// Verbatim move: the Ink/React path, the readline loop, and in-chat slash
// handling are unchanged. Only dynamic-import paths were rebased ./ -> ../,
// and the single cmdSetup call now lazy-imports ./setup.mjs so the
// chat <-> setup cycle is broken at the dynamic-import boundary.
import path from 'node:path';
import {
  configPath, readConfig, writeConfig,
  _resolveAuthKey, _resolveBaseUrl, readVersionFromRepo,
} from '../lib/config.mjs';
import { ensureRegistry, requireRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { SUBCOMMANDS, parseArgs, AGENT_REG_SUBS } from '../lib/args.mjs';
import {
  _attachGhostAutocomplete, _fetchModelsForProvider, _pauseChatForSubMenu,
  _pickModelInteractive, _pickProviderInteractive, _printChatBanner,
  _quickPrompt, _renderBanner, _renderV5Banner,
} from '../tui/pickers.mjs';
import { firstRunMode as _firstRunMode, hasConfiguredProvider } from '../first_run.mjs';
import { applyChatWindow as _applyChatWindow, CHAT_WINDOW_TURNS, CHAT_WINDOW_TOKEN_BUDGET } from '../chat_window.mjs';
import { makeRunTurn as _chatRunTurnFactory } from '../tui/run_turn.mjs';
import { dispatchSlash as _dispatchSlash, parseSlashLine as _parseSlashLine } from '../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';

// Legacy (non-Ink) slash routing for dispatcher-style, ctx-only commands.
// The Ink REPL routes every slash through _dispatchSlash/SLASH_HANDLERS, but
// the legacy readline path uses a hand-written switch (in cmdChat). Commands
// like /config only mutate ctx and return a sentinel, so we keep that wiring
// in one exported helper that BOTH the legacy switch and the regression test
// drive — this is the seam that proves /config reaches setup on the legacy
// path (the post-loop guard re-runs cmdSetup when ctx.requestSetup is set).
// Returns 'EXIT' when the loop must break, or undefined when the command is
// not one this helper owns (caller falls through to its own handling).
export function legacySlashRoute(cmd, ctx) {
  switch (cmd) {
    case '/config':
      // Mirror tui/slash_dispatcher.mjs '/config': signal the host, unmount.
      ctx.requestSetup = true;
      return 'EXIT';
    default:
      return undefined;
  }
}

// Dispatcher commands the legacy readline path's default branch may delegate to
// _dispatchSlash. Kept to ctx-safe handlers only (no _inkCtx-only setters /
// openPicker / version), so legacy doesn't silently degrade. /channels has a
// lib/config fallback so it's safe; add others only after confirming ctx-safety.
const LEGACY_DELEGATED_SLASHES = new Set(['/channels']);

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
  let prov = lookupProv(activeProvName);
  if (!prov) { console.error(`unknown provider: ${activeProvName}`); process.exit(2); }

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

      // Tool + skill groups for the splash panel — shared with the setup
      // wizard via tui/splash_props.mjs so both surfaces render the same panel.
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

      // C7 — minimal chat-session state for the ink path so runTurn can
      // talk to the provider (the legacy readline path below sets up the
      // same shape — kept duplicated here intentionally so the ink branch
      // remains self-contained and the legacy path stays byte-identical).
      // Slash commands aren't wired into the ink REPL yet (v5.1 follow-up);
      // until then, system-prompt composition / --session resume happen
      // identically to the legacy path.
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
        const merged = _inkSysParts.join('\n\n---\n\n');
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
      // v5.4: chars-sent counter for the Ink chat path. Mirrors the legacy
      // path's `charsSent` so /usage in Ink reports the same number.
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
        setProv: (next) => { prov = next; },
        getActiveProvName: () => activeProvName,
        setActiveProvName: (name) => { activeProvName = name; },
        getActiveModel: () => activeModel,
        setActiveModel: (name) => { activeModel = name; },
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
        // P2 — let /provider add register a custom OpenAI-compatible endpoint
        // by read-merge-writing config.json from inside the Ink session.
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
        return _dispatchSlash(cmd, args, _inkCtx, (chunk) => {
          try { process.stdout.write(chunk); } catch { /* swallow */ }
        });
      };
      // v5.4.1: splash renders INSIDE the alt-buffer (not pre-printed to
      // primary). The v5.4.0 pre-print made the screen go blank during
      // chat because alt-buffer cleared it on enter. Splash lives in the
      // Static scrollback now regardless of alt-buffer state.
      const ink = render(/* @__PURE__ */ React.createElement(ReplApp, {
        splashProps,
        statusInfo: { provider: activeProvName, model: activeModel },
        // P3 — live status: read the current provider/model + token gauge so
        // the StatusBar refreshes after a /provider or /model switch and each
        // turn, instead of showing the values captured at mount.
        getStatus: () => ({
          provider: activeProvName,
          model: activeModel,
          ctxUsed: _inkRunningUsage ? _inkRunningUsage.totalTokens : undefined,
          ctxTotal: CHAT_WINDOW_TOKEN_BUDGET,
        }),
        runTurnFactory: _inkRunTurnFactory,
        onSlashCommand: _inkSlashHandler,
        pickerRef: _inkPickerRef,
      }), { exitOnCtrlC: true, patchConsole: true });
      await ink.waitUntilExit();
      // /config asks to (re)run the wizard: now that Ink has released stdin,
      // run setup, then return to the shell (re-launch `lazyclaw` to chat).
      if (_inkCtx.requestSetup) await (await import('./setup.mjs')).cmdSetup(undefined, [], {});
      return;
    } catch (e) {
      // Fall through to legacy path on any ink failure (missing import,
      // narrow terminal, sandboxed stdout).
      if (process.env.LAZYCLAW_DEBUG) console.error('[ink] fallback:', e.message);
    }
  }
  // ─── legacy v4 path (unchanged) ─────────────────────────────────
  _printChatBanner(activeProvName, activeModel, readVersionFromRepo());

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
    const merged = sysParts.join('\n\n---\n\n');
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
    resolveAuthKey: (providerName) => _resolveAuthKey(cfg, providerName),
    onCharsSent: (n) => { charsSent += n; },
  };
  const runTurn = _chatRunTurnFactory({
    ctx: _legacyCtx,
    writeFn: (chunk) => process.stdout.write(chunk),
  });

  const handleSlash = async (line) => {
    const cmd = line.split(/\s+/)[0];
    switch (cmd) {
      case '/help': {
        process.stdout.write('slash commands:\n');
        for (const c of SLASH_COMMANDS) process.stdout.write(`  ${c.cmd.padEnd(8)} — ${c.help}\n`);
        return true;
      }
      case '/status': {
        const out = {
          provider: activeProvName,
          model: activeModel,
          keyMasked: getRegistry().maskApiKey(cfg['api-key']),
          messageCount: messages.length,
        };
        process.stdout.write(JSON.stringify(out) + '\n');
        return true;
      }
      case '/provider': {
        // `/provider <name>` switches the active provider for subsequent
        // turns. The conversation history stays put — the next user
        // message goes to the new provider with the existing context.
        // `/provider` (no arg) opens the family/provider/model picker so
        // the user can switch with arrow keys instead of memorising names.
        const arg = line.slice('/provider'.length).trim();
        if (!arg) {
          if (!useTerminal) {
            process.stdout.write(`provider: ${activeProvName}\n`);
            return true;
          }
          await _pauseChatForSubMenu(rl, _ghost, async () => {
            const picked = await _pickProviderInteractive();
            if (picked && picked.provider) {
              const next = lookupProv(picked.provider);
              if (!next) {
                process.stdout.write(`unknown provider: ${picked.provider}\n`);
                return;
              }
              activeProvName = picked.provider;
              prov = next;
              if (picked.model) activeModel = picked.model;
              process.stdout.write(`provider → ${activeProvName}${picked.model ? ` · model → ${picked.model}` : ''}\n`);
            }
          });
          return true;
        }
        const next = lookupProv(arg);
        if (!next) {
          process.stdout.write(`unknown provider: ${arg} (known: ${Object.keys(getRegistry().PROVIDERS).join(', ')})\n`);
          return true;
        }
        activeProvName = arg;
        prov = next;
        process.stdout.write(`provider → ${arg}\n`);
        return true;
      }
      case '/model': {
        // `/model <name>` updates the active model without touching the
        // provider. `/model` (no arg) opens the per-provider model picker
        // — same UX as setup step 3, scoped to the active provider.
        const arg = line.slice('/model'.length).trim();
        if (!arg) {
          if (!useTerminal) {
            process.stdout.write(`model: ${activeModel || '(default)'}\n`);
            return true;
          }
          await _pauseChatForSubMenu(rl, _ghost, async () => {
            const chosen = await _pickModelInteractive(activeProvName, { titlePrefix: 'LazyClaw chat —' });
            if (chosen === 'CANCEL' || chosen === 'BACK' || !chosen) return;
            activeModel = chosen;
            process.stdout.write(`model → ${activeModel}\n`);
          });
          return true;
        }
        // Honor unified provider/model: `/model anthropic/claude-opus-4-7`
        // splits and switches both.
        const { parseSlashProviderModel } = getRegistry();
        const parsed = parseSlashProviderModel(arg);
        if (parsed.provider) {
          const next = lookupProv(parsed.provider);
          if (!next) {
            process.stdout.write(`unknown provider: ${parsed.provider}\n`);
            return true;
          }
          activeProvName = parsed.provider;
          prov = next;
        }
        activeModel = parsed.model || arg;
        process.stdout.write(`model → ${activeModel}${parsed.provider ? ` (provider → ${parsed.provider})` : ''}\n`);
        return true;
      }
      case '/new':
      case '/reset':
      case '/clear': {
        // /clear is dispatcher-only (no explicit legacy case before this),
        // so without it /clear fell through to `default:` → _dispatchSlash →
        // _newReset, which clears via ctx.set* setters that _legacyCtx does
        // NOT expose — returning 'cleared' while the closure's messages/
        // charsSent/runningUsage stayed intact (a lying no-op). Alias /clear
        // to the /new+/reset direct-mutation body, matching the dispatcher's
        // /clear → /new/reset session-reset aliasing.
        messages = [];
        charsSent = 0;
        runningUsage = null;
        if (sessionId) {
          const sm = await import('../sessions.mjs');
          sm.resetSession(sessionId, cfgDir);
        }
        process.stdout.write('cleared — new conversation\n');
        return true;
      }
      case '/usage': {
        const out = { messageCount: messages.length, charsSent };
        if (runningUsage) out.tokens = runningUsage;
        // When cfg.rates has a card for the active provider/model AND
        // we accumulated real usage, surface the running cost too. The
        // computation is local (pure arithmetic), no extra network.
        if (runningUsage && cfg.rates && typeof cfg.rates === 'object') {
          try {
            const { costFromUsage } = await import('../providers/rates.mjs');
            const r = costFromUsage(
              { provider: activeProvName, model: activeModel, usage: runningUsage },
              cfg.rates,
            );
            if (r) out.cost = r;
          } catch { /* never let cost-card lookup fail the slash */ }
        }
        process.stdout.write(JSON.stringify(out) + '\n');
        return true;
      }
      case '/skill': {
        // `/skill name1,name2` — replace the active system message with a
        // composition of the named skills. `/skill` (no arg) clears the
        // system message. The replacement happens in-place on the
        // messages array; the prior system turn (if any) is dropped so
        // we don't end up with two stacked system messages talking past
        // each other. When --session is set we persist the new system
        // message so the next invocation resumes with the same context.
        const arg = line.slice('/skill'.length).trim();
        const names = arg.split(',').map(s => s.trim()).filter(Boolean);
        const sysIdx = messages.findIndex(m => m.role === 'system');
        if (names.length === 0) {
          if (sysIdx >= 0) messages.splice(sysIdx, 1);
          if (sessionId) {
            // Persistent session: rewrite the file from scratch so the
            // dropped system turn doesn't linger as a stale entry.
            const sm = await import('../sessions.mjs');
            sm.resetSession(sessionId, cfgDir);
            for (const m of messages) sm.appendTurn(sessionId, m.role, m.content, cfgDir);
          }
          process.stdout.write('cleared system prompt (no active skills)\n');
          return true;
        }
        try {
          const sys = await (async () => {
            const mod = await import('../skills.mjs');
            return mod.composeSystemPrompt(names, cfgDir);
          })();
          if (!sys) {
            process.stdout.write('no skill content composed (empty input?)\n');
            return true;
          }
          if (sysIdx >= 0) messages[sysIdx] = { role: 'system', content: sys };
          else messages.unshift({ role: 'system', content: sys });
          if (sessionId) {
            const sm = await import('../sessions.mjs');
            sm.resetSession(sessionId, cfgDir);
            for (const m of messages) sm.appendTurn(sessionId, m.role, m.content, cfgDir);
          }
          process.stdout.write(`active skills: ${names.join(', ')}\n`);
        } catch (e) {
          process.stdout.write(`skill error: ${e?.message || e}\n`);
        }
        return true;
      }
      case '/loop': {
        // `/loop <prompt> [--max N] [--until "<regex>"]` — repeats one
        // user prompt against the active provider in the current session.
        // Default --max 3, hard cap 50. --until short-circuits when its
        // regex matches the latest assistant turn. Ctrl+C aborts the
        // current stream AND the whole loop (not just the in-flight
        // turn). Implementation lives in loop-engine.mjs; here we wire
        // it to the same provider streaming + buffered-writer used by a
        // normal user turn.
        const arg = line.slice('/loop'.length).trim();
        const loopMod = await import('../loop-engine.mjs');
        if (!arg) {
          process.stdout.write(`usage: /loop <prompt> [--max N] [--until "<regex>"]\n`);
          process.stdout.write(`  default --max ${loopMod.LOOP_MAX_DEFAULT}, ceiling ${loopMod.LOOP_MAX_CEILING}\n`);
          process.stdout.write(`  session: ${sessionId || '(none — turns will not be persisted)'}\n`);
          return true;
        }
        let parsed;
        try { parsed = loopMod.parseLoopArgs(arg); }
        catch (e) { process.stdout.write(`loop error: ${e?.message || e}\n`); return true; }
        let untilRe = null;
        try { untilRe = loopMod.compileUntil(parsed.until); }
        catch (e) { process.stdout.write(`loop error: ${e?.message || e}\n`); return true; }

        // Per-loop AbortController. Ctrl+C aborts the current provider
        // call (via signal) AND prevents the next iteration (the engine
        // sees signal.aborted on its loop check). Same handler shape as
        // the normal-turn path; symmetry keeps `/exit` clean afterwards.
        const loopAc = new AbortController();
        const onSigint = () => {
          loopAc.abort();
          process.stdout.write('\n^C interrupted — loop aborted\n');
        };
        process.on('SIGINT', onSigint);

        const sendOnce = async (msgs, signal) => {
          let acc = '';
          let _writeBuf = '';
          let _writeTimer = null;
          const _flush = () => {
            if (_writeBuf) { process.stdout.write(_writeBuf); _writeBuf = ''; }
            _writeTimer = null;
          };
          const _writeChunk = (s) => {
            _writeBuf += s;
            if (!_writeTimer) _writeTimer = setTimeout(_flush, 30);
          };
          try {
            for await (const chunk of prov.sendMessage(msgs, {
              apiKey: _resolveAuthKey(cfg, activeProvName),
              model: activeModel,
              sandbox: sandboxSpec,
              signal,
              onUsage: accumulateUsage,
            })) {
              _writeChunk(chunk);
              acc += chunk;
            }
            if (_writeTimer) clearTimeout(_writeTimer);
            _flush();
            process.stdout.write('\n');
            return acc;
          } catch (err) {
            if (_writeTimer) clearTimeout(_writeTimer);
            _flush();
            throw err;
          }
        };

        if (useTerminal) _ghost.suspend();
        // Capture the chat's existing system message (workspace / skill
        // composition) before we let the engine touch it; we restore it
        // after the loop so the chat continues with the same system.
        const _sysBefore = messages.find(m => m.role === 'system')?.content ?? null;
        const memMod = (parsed.useMemory || parsed.recall) ? await import('../memory.mjs') : null;
        const buildSystem = memMod ? (() => {
          // Called per iteration: memory.loadCore + recall re-read from
          // disk every call so a parallel writer mutating core.md /
          // episodic/* between iterations is reflected immediately.
          const parts = [];
          if (parsed.useMemory) {
            const core = memMod.loadCore(cfgDir);
            if (core && core.trim()) parts.push(core);
          }
          if (parsed.recall) {
            const text = memMod.recall(parsed.recall, { topN: 3 }, cfgDir);
            if (text && text.trim()) parts.push(text);
          }
          if (_sysBefore) parts.push(_sysBefore);
          return parts.join('\n\n---\n\n');
        }) : null;
        try {
          const result = await loopMod.runLoop({
            prompt: parsed.prompt,
            max: parsed.max,
            until: untilRe,
            messages,
            sendOnce,
            persist: (role, content) => persistTurn(role, content),
            onIteration: ({ i, max }) => {
              process.stderr.write(`\x1b[2m  ↻ loop iteration ${i}/${max}\x1b[22m\n`);
            },
            signal: loopAc.signal,
            buildSystem,
          });
          charsSent += parsed.prompt.length * result.iterations;
          if (result.stoppedBy === 'until') {
            process.stderr.write(`\x1b[2m  ✓ loop stopped by --until\x1b[22m\n`);
          } else if (result.stoppedBy === 'abort') {
            process.stderr.write(`\x1b[2m  ⊘ loop aborted after ${result.iterations}/${parsed.max} iteration(s)\x1b[22m\n`);
          }
        } catch (err) {
          process.stdout.write(`loop error: ${err?.message || String(err)}\n`);
        } finally {
          process.off('SIGINT', onSigint);
          if (useTerminal) _ghost.resume();
          // Restore the chat's prior system message. The engine may have
          // overwritten messages[0] with the per-iter memory composition;
          // we put the original (workspace / skill) back so the
          // subsequent free-form chat turn sees the same system the user
          // configured before /loop ran.
          if (buildSystem) {
            const sysIdx = messages.findIndex(m => m.role === 'system');
            if (_sysBefore) {
              if (sysIdx >= 0) messages[sysIdx] = { role: 'system', content: _sysBefore };
              else messages.unshift({ role: 'system', content: _sysBefore });
            } else if (sysIdx >= 0) {
              messages.splice(sysIdx, 1);
            }
          }
        }
        return true;
      }
      case '/goal': {
        // /goal                 → list active goals
        // /goal <name>          → switch chat context to goal:<name>
        // /goal add <name> [--desc "..."] [--cron "<spec>"]
        // /goal list            → JSON of all goals
        // /goal show <name>     → JSON of one
        // /goal close <name> [done|abandoned]
        const rawArg = line.slice('/goal'.length).trim();
        const goalsMod = await import('../goals.mjs');
        const loopMod = await import('../loop-engine.mjs');
        if (!rawArg) {
          const items = goalsMod.listGoals(cfgDir).filter(g => g.status === 'active');
          if (!items.length) { process.stdout.write('no active goals\n'); }
          else {
            for (const g of items) {
              process.stdout.write(`  ${g.name}${g.description ? ' — ' + g.description : ''}${g.schedule ? ' (cron: ' + g.schedule + ')' : ''}\n`);
            }
          }
          return true;
        }
        let tokens;
        try { tokens = loopMod.splitArgs(rawArg); }
        catch (e) { process.stdout.write(`goal error: ${e?.message || e}\n`); return true; }
        const sub = tokens[0];
        const rest = tokens.slice(1);
        if (sub === 'add') {
          let name = null, desc = '', cron = null;
          for (let i = 0; i < rest.length; i++) {
            const t = rest[i];
            if (t === '--desc') desc = rest[++i] || '';
            else if (t === '--cron') cron = rest[++i] || null;
            else if (t.startsWith('--')) { process.stdout.write(`goal error: unknown flag ${t}\n`); return true; }
            else if (!name) name = t;
            else { process.stdout.write(`goal error: unexpected arg "${t}"\n`); return true; }
          }
          if (!name) { process.stdout.write('usage: /goal add <name> [--desc "..."] [--cron "<spec>"]\n'); return true; }
          try {
            const g = goalsMod.registerGoal({ name, description: desc, schedule: cron }, cfgDir);
            if (cron) {
              try { await (await import('../commands/automation.mjs'))._attachGoalCron(name, cron); }
              catch (e) { process.stdout.write(`goal warning: cron attach failed (${e?.message || e})\n`); }
            }
            process.stdout.write(`✓ goal ${g.name} added (status: active${cron ? `, cron: ${cron}` : ''})\n`);
          } catch (e) { process.stdout.write(`goal error: ${e?.message || e}\n`); }
          return true;
        }
        if (sub === 'list') {
          process.stdout.write(JSON.stringify(goalsMod.listGoals(cfgDir), null, 2) + '\n');
          return true;
        }
        if (sub === 'show') {
          const name = rest[0];
          if (!name) { process.stdout.write('usage: /goal show <name>\n'); return true; }
          const g = goalsMod.getGoal(name, cfgDir);
          if (!g) { process.stdout.write(`no goal "${name}"\n`); return true; }
          process.stdout.write(JSON.stringify(g, null, 2) + '\n');
          return true;
        }
        if (sub === 'close') {
          const name = rest[0];
          const outcome = rest[1] || 'done';
          if (!name) { process.stdout.write('usage: /goal close <name> [done|abandoned]\n'); return true; }
          try {
            const g = goalsMod.closeGoal(name, outcome, cfgDir);
            try { await (await import('../commands/automation.mjs'))._detachGoalCron(name); }
            catch (e) { process.stdout.write(`goal warning: cron detach failed (${e?.message || e})\n`); }
            process.stdout.write(`✓ goal ${g.name} closed (status: ${g.status})\n`);
          } catch (e) { process.stdout.write(`goal error: ${e?.message || e}\n`); }
          return true;
        }
        // Single-arg branch: switch context to goal:<name>.
        const goalName = sub;
        const g = goalsMod.getGoal(goalName, cfgDir);
        if (!g) {
          process.stdout.write(`no goal "${goalName}" — try: /goal add ${goalName} --desc "..."\n`);
          return true;
        }
        if (g.status !== 'active') {
          process.stdout.write(`goal "${goalName}" is ${g.status}; cannot switch\n`);
          return true;
        }
        // Switch: replace the chat's active session id and reload turns
        // from the goal's session. The provider, model, workspace, and
        // skill state stay put — only the conversation surface changes.
        sessionId = g.sessionId;
        activeGoalName = g.name;
        const prior = sessionsMod.loadTurns(sessionId, cfgDir);
        messages = prior.map(t => ({ role: t.role, content: t.content }));
        // Prepend a one-line goal note to the system message so the
        // model sees the current objective without us having to mutate
        // any persistent record on every switch.
        const sysIdx = messages.findIndex(m => m.role === 'system');
        const goalNote = `## Goal: ${g.description || g.name}`;
        if (sysIdx >= 0) {
          messages[sysIdx] = { role: 'system', content: `${goalNote}\n\n${messages[sysIdx].content}` };
        } else {
          messages.unshift({ role: 'system', content: goalNote });
        }
        process.stdout.write(`✓ switched to goal: ${g.name} (session: ${sessionId}, ${prior.length} prior turn(s))\n`);
        return true;
      }
      case '/memory': {
        const arg = line.slice('/memory'.length).trim();
        const memMod = await import('../memory.mjs');
        const tokens = arg.split(/\s+/).filter(Boolean);
        const which = tokens[0] || 'core';
        if (which === 'core') {
          const body = memMod.loadCore(cfgDir);
          process.stdout.write(body || '(empty core memory)\n');
          return true;
        }
        if (which === 'recent') {
          const items = memMod.loadRecent(20, cfgDir);
          process.stdout.write(JSON.stringify(items, null, 2) + '\n');
          return true;
        }
        if (which === 'episodic') {
          const topic = tokens[1];
          if (topic) {
            const body = memMod.loadEpisodic(topic, cfgDir);
            process.stdout.write(body || `(no episodic file "${topic}")\n`);
          } else {
            process.stdout.write(JSON.stringify(memMod.listEpisodic(cfgDir), null, 2) + '\n');
          }
          return true;
        }
        process.stdout.write('usage: /memory [core|recent|episodic [topic]]\n');
        return true;
      }
      case '/dream': {
        const memMod = await import('../memory.mjs');
        process.stdout.write('  ↯ dreaming…\n');
        try {
          const r = await memMod.dream(sessionId, {
            provider: prov,
            model: activeModel,
            apiKey: _resolveAuthKey(cfg, activeProvName),
          }, cfgDir);
          process.stdout.write(`✓ wrote ${r.topics.length} episodic file(s): ${r.topics.join(', ') || '(none)'}\n`);
        } catch (e) { process.stdout.write(`dream error: ${e?.message || e}\n`); }
        return true;
      }
      case '/agent': {
        const rawArg = line.slice('/agent'.length).trim();
        const agentsMod = await import('../agents.mjs');
        const loopMod = await import('../loop-engine.mjs');
        let tokens;
        try { tokens = loopMod.splitArgs(rawArg); }
        catch (e) { process.stdout.write(`/agent error: ${e?.message || e}\n`); return true; }
        const sub = tokens[0];
        const rest = tokens.slice(1);
        const aname = rest[0];
        try {
          if (!sub || sub === 'list') {
            const agents = agentsMod.listAgents(cfgDir);
            if (agents.length === 0) process.stdout.write('no agents registered. /agent add <name> [...] to create.\n');
            else for (const a of agents) {
              const provLine = a.model ? `${a.provider}/${a.model}` : a.provider;
              process.stdout.write(`• ${a.name} — ${a.displayName} — ${provLine} — tools=[${(a.tools || []).join(',')}]\n`);
            }
          } else if (sub === 'show') {
            if (!aname) { process.stdout.write('usage: /agent show <name>\n'); return true; }
            const a = agentsMod.getAgent(aname, cfgDir);
            if (!a) process.stdout.write(`no agent "${aname}"\n`);
            else process.stdout.write(JSON.stringify(a, null, 2) + '\n');
          } else if (sub === 'add') {
            if (!aname) { process.stdout.write('usage: /agent add <name> [role text…]\n'); return true; }
            const roleText = rest.slice(1).join(' ').trim();
            const a = agentsMod.registerAgent({ name: aname, role: roleText }, cfgDir);
            process.stdout.write(`✓ added agent ${a.name} (tools=${a.tools.join(',')})\n`);
          } else if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
            if (!aname) { process.stdout.write('usage: /agent remove <name>\n'); return true; }
            agentsMod.removeAgent(aname, cfgDir);
            process.stdout.write(`✓ removed agent ${aname}\n`);
          } else {
            process.stdout.write(`/agent: unknown sub "${sub}" — list|show|add|remove\n`);
          }
        } catch (e) {
          process.stdout.write(`/agent error: ${e?.message || e}\n`);
        }
        return true;
      }
      case '/team': {
        const rawArg = line.slice('/team'.length).trim();
        const teamsMod = await import('../teams.mjs');
        const loopMod = await import('../loop-engine.mjs');
        let tokens;
        try { tokens = loopMod.splitArgs(rawArg); }
        catch (e) { process.stdout.write(`/team error: ${e?.message || e}\n`); return true; }
        const sub = tokens[0];
        const rest = tokens.slice(1);
        const tname = rest[0];
        try {
          if (!sub || sub === 'list') {
            const teams = teamsMod.listTeams(cfgDir);
            if (teams.length === 0) process.stdout.write('no teams registered. /team add <name> --agents a,b --lead a [--channel #x]\n');
            else for (const t of teams) {
              const chLine = t.slackChannel ? ` — ${t.slackChannel}` : '';
              process.stdout.write(`• ${t.name} — ${t.displayName} — lead=${t.lead} — agents=[${t.agents.join(',')}]${chLine}\n`);
            }
          } else if (sub === 'show') {
            if (!tname) { process.stdout.write('usage: /team show <name>\n'); return true; }
            const t = teamsMod.getTeam(tname, cfgDir);
            if (!t) process.stdout.write(`no team "${tname}"\n`);
            else process.stdout.write(JSON.stringify(t, null, 2) + '\n');
          } else if (sub === 'add') {
            // /team add <name> --agents a,b,c [--lead a] [--channel #x]
            if (!tname) { process.stdout.write('usage: /team add <name> --agents a,b,c [--lead a] [--channel #x]\n'); return true; }
            let agentsCsv = null, lead = null, channel = '';
            for (let i = 1; i < rest.length; i++) {
              const t = rest[i];
              if (t === '--agents') agentsCsv = rest[++i] || '';
              else if (t === '--lead') lead = rest[++i] || null;
              else if (t === '--channel') channel = rest[++i] || '';
              else { process.stdout.write(`/team error: unknown token "${t}"\n`); return true; }
            }
            if (!agentsCsv) { process.stdout.write('/team add: --agents is required\n'); return true; }
            const agents = teamsMod.parseListFlag(agentsCsv);
            const ch = channel ? await teamsMod.resolveSlackChannel(channel, {
              botToken: process.env.SLACK_BOT_TOKEN || null,
              apiBase: process.env.SLACK_API_BASE || 'https://slack.com/api',
              logger: () => {},
            }) : '';
            const team = teamsMod.registerTeam({ name: tname, agents, lead, slackChannel: ch }, cfgDir);
            process.stdout.write(`✓ added team ${team.name} (lead=${team.lead}, agents=${team.agents.join(',')})\n`);
          } else if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
            if (!tname) { process.stdout.write('usage: /team remove <name>\n'); return true; }
            teamsMod.removeTeam(tname, cfgDir);
            process.stdout.write(`✓ removed team ${tname}\n`);
          } else {
            process.stdout.write(`/team: unknown sub "${sub}" — list|show|add|remove\n`);
          }
        } catch (e) {
          process.stdout.write(`/team error: ${e?.message || e}\n`);
        }
        return true;
      }
      case '/handoff': {
        // /handoff <target-channel> <externalId> [--note=...] — migrates the
        // active thread (bound to replState.channel / replState.externalId)
        // to a new channel and posts transition stubs on both sides. In the
        // local-only chat REPL there is no bound channel, so we surface a
        // clear error and stay in the REPL (acceptance test §F).
        const parts = line.trim().split(/\s+/).slice(1);
        if (parts.length < 2) {
          process.stderr.write('usage: /handoff <target-channel> <externalId> [--note=...]\n');
          return true;
        }
        const target = parts[0];
        const externalId = parts[1];
        const note = (parts.find(p => p.startsWith('--note=')) || '').slice(7);
        try {
          const { openThreads } = await import('../channels/threads.mjs');
          const { runHandoff } = await import('../channels/handoff.mjs');
          const threads = openThreads(cfgDir);
          const replState = globalThis.__lazyclawReplState || {};
          const cur = replState.channel && replState.externalId
            ? threads.findByExternal(replState.channel, replState.externalId)
            : null;
          if (!cur) {
            process.stderr.write(
              `handoff: no thread bound to ${replState.channel || '(none)'}:${replState.externalId || '(none)'}\n`,
            );
            return true;
          }
          const next = await runHandoff({
            threads, channels: replState.channels || {},
            threadId: cur.threadId, target, externalId, note,
          });
          process.stdout.write(`handoff -> ${next.channel}:${next.externalId} (session ${next.sessionId})\n`);
          replState.channel = next.channel;
          replState.externalId = next.externalId;
        } catch (e) {
          process.stderr.write(`handoff failed: ${e.code || 'ERR'}: ${e.message}\n`);
        }
        return true;
      }
      case '/personality': {
        // Phase G: thin slash wrapper over cmdPersonality.
        const tail = line.slice('/personality'.length).trim();
        const parts = tail.split(/\s+/).filter(Boolean);
        await (await import('../commands/config.mjs')).cmdPersonality(parts[0] || 'list', parts[1], parts[2]);
        return true;
      }
      case '/exit': {
        // v5 Group A (C4): fire one updateUserModel call before exit so
        // the Honcho-style USER.md captures the durable facts surfaced
        // in this session. Wrapped in a 3-second timeout so a slow
        // trainer never makes /exit hang. Best-effort: failure logs are
        // suppressed so we don't disturb the clean shutdown.
        try {
          const turns = sessionId
            ? sessionsMod.loadTurns(sessionId, cfgDir)
            : messages.map((t) => ({ role: t.role, content: t.content }));
          if (turns && turns.length) {
            const trainer = (typeof getRegistry()?.resolveTrainer === 'function')
              ? getRegistry().resolveTrainer(cfg)
              : { provider: activeProvName, model: activeModel };
            const userModelPromise = import('../mas/user_modeler.mjs').then((m) =>
              m.updateUserModel({
                sessionTurns: turns,
                provider: trainer.provider,
                model: trainer.model,
                apiKey: _resolveAuthKey(cfg, trainer.provider),
                baseUrl: _resolveBaseUrl(trainer.provider),
                configDir: cfgDir,
              }),
            ).catch(() => null);
            await Promise.race([
              userModelPromise,
              new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
          }
        } catch { /* /exit must never hang or throw */ }
        return 'EXIT';
      }
      case '/config': {
        // Route through the shared legacySlashRoute helper (covered by
        // tests/f-config-slash-splash.test.mjs) so the legacy path's /config
        // wiring is the exact code the regression test exercises. It sets
        // _legacyCtx.requestSetup and returns 'EXIT'; the post-loop guard at the
        // bottom of cmdChat re-runs the setup wizard when requestSetup is set.
        // Without this case the legacy readline path fell through to `default:`
        // and printed "unknown slash" instead of launching setup.
        return legacySlashRoute(cmd, _legacyCtx);
      }
      default: {
        // Delegate ONLY ctx-safe dispatcher commands to the shared handler.
        // _legacyCtx is intentionally thin (no setters / openPicker / version),
        // so a blanket delegation would silently degrade picker- or setter-
        // driven handlers (/menu, /clear, /version, …). /channels is ctx-safe
        // (it has a lib/config fallback); everything else stays an honest
        // "unknown slash". 'EXIT' breaks the loop; a returned string prints.
        if (LEGACY_DELEGATED_SLASHES.has(cmd)) {
          const { args } = _parseSlashLine(line);
          const r = await _dispatchSlash(cmd, args, _legacyCtx, (s) => process.stdout.write(s));
          if (r === 'EXIT') return 'EXIT';
          if (typeof r === 'string' && r.length) process.stdout.write(r + '\n');
          return true;
        }
        process.stdout.write(`unknown slash: ${cmd} (try /help)\n`);
        return true;
      }
    }
  };

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
  try { for await (const line of rl) {
    const text = line.trim();
    if (!text) { if (useTerminal) rl.prompt(); continue; }
    if (text.startsWith('/')) {
      const r = await handleSlash(text);
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
  // /config in the legacy path: re-run the wizard after the readline loop closes.
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
