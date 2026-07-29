// tui/repl.mjs — REPL host with mid-stream interrupt-and-redirect
// (spec §5.8) AND a sticky-bottom chat layout (v5.3).
//
// Layout (top → bottom inside the outer column):
//   1. Scrollback — splash item + per-turn user/assistant blocks.
//      Non-alt path uses <Static items={scrollback}/>: Ink writes each
//      item ONCE to terminal scrollback so the splash + history scroll
//      away naturally as new content appends (the v5.3 contract).
//      Alt-buffer path renders the same items as regular flex children
//      instead — Static's "write above the live frame" mechanism is
//      invisible inside the DEC 1049 alt canvas (the live frame
//      immediately overwrites that area), so v5.4.1 splashes vanished.
//      Flex children re-render each frame; <Splash/> output is stable.
//   2. Live region — partial assistant stream (state.liveAssistant) and
//      optional <SlashHints/> while the input buffer starts with '/'.
//      This Box re-renders on every chunk; the rest of the tree does not.
//   3. <StatusBar/> — single row above the input. flexShrink:0.
//   4. <Editor/> — sticky bottom, content-sized (1 line idle, grows with
//      multiline). Last sibling in the column so it pins to the bottom.
//
// Streaming chunks now flow into React state via an injected writeFn
// (state.liveAssistant += chunk). On turn completion the accumulated
// text is committed to scrollback so React stops re-rendering it.
// This closes the v5.0.10 TODO from cli.mjs:2628-2632.
//
// Backward-compat contracts (do not break):
//   - makeReplState()              — still callable with zero args.
//   - onUserInput, onEscape, onTurnComplete, consumeNextTurnFirstMessage
//     keep their pre-v5.3 shapes (tests/phaseC-repl-interrupt.test.mjs).
//   - ReplApp({ splashProps, runTurn })  — legacy callsite (cli.mjs:2637)
//     still works; runTurn writes go to wherever its writeFn points.
//   - ReplApp({ splashProps, runTurnFactory })  — new callsite for the
//     sticky layout; ReplApp injects writeFn → scrollback.
//
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Box, Static, Text, useApp, useStdout } from 'ink';
import { Splash, renderSplashToString } from './splash.mjs';
import { Editor } from './editor.mjs';
import { SlashPopup, filterSlashCommands } from './slash_popup.mjs';
import { SLASH_COMMANDS } from './slash_commands.mjs';
import { argSpecFor } from './slash_args.mjs';
import { ModalPicker, filterModalItems, resolveModalPick } from './modal_picker.mjs';
import { theme } from './theme.mjs';
import { LiveRegion } from './live_region.mjs';
import { setInkWriter } from './stray_writes.mjs';
import { StatusBar } from './status_bar.mjs';
import { onConversationReset, clearTerminalScreen } from './repl_reset.mjs'; export { StatusBar };
// Alt-buffer (DEC 1049) mount cluster moved to ./repl_altbuffer.mjs and pure
// state reducers moved to ./repl_reducers.mjs (file-size gate). Re-exported so
// every existing caller + test sees them on repl.mjs, and imported locally
// because the ReplApp body binds them directly.
import { computeAltEnabled, FullScreen } from './repl_altbuffer.mjs';
export { ALT_BUFFER_ENTER, ALT_BUFFER_LEAVE, CURSOR_VISIBLE, computeAltEnabled, FullScreen } from './repl_altbuffer.mjs';
import {
  makeReplState, onUserInput, onEscape, onStreamChunk, onTurnComplete,
} from './repl_reducers.mjs';
export {
  makeReplState, onUserInput, onEscape, onStreamChunk, onTurnComplete, consumeNextTurnFirstMessage,
} from './repl_reducers.mjs';

// ─── React mount ─────────────────────────────────────────────────────────
//
// Two prop modes:
//   - runTurnFactory(writeFn) → runTurn(text, signal)   (sticky layout)
//   - runTurn(text, signal)                              (legacy, stdout)
// Legacy mode is preserved verbatim for the existing cli.mjs callsite.
export function ReplApp({ splashProps, runTurn, runTurnFactory, slashCommands, onSlashCommand, onArgComplete, onArgList, statusInfo, getStatus, pickerRef }) {
  // statusInfo seeds the StatusBar's provider/model/ctx. getStatus (optional)
  // returns the live values so the bar refreshes after a /provider or /model
  // switch and after each turn (token/ctx gauge) — without it the bar would
  // show whatever was captured at mount (stale after a slash mutates the
  // active provider/model). v5.5.
  const [statusState, setStatusState] = useState(() => statusInfo || splashProps || {});
  const refreshStatus = useCallback(() => {
    if (typeof getStatus !== 'function') return;
    try {
      const s = getStatus();
      if (s) setStatusState((prev) => ({ ...prev, ...s }));
    } catch { /* never let a status read break the turn */ }
  }, [getStatus]);
  const _status = statusState;
  // Splash is rendered ONCE as scrollback[0] via <Static>. Build it lazily
  // so SSR-style imports without a TTY don't crash on process.stdout.
  const splashItemRef = useRef(null);
  if (splashItemRef.current === null) {
    splashItemRef.current = splashProps
      ? { kind: 'splash', id: 'splash-0', splashProps }
      : null;
  }
  const [state, setState] = useState(() => makeReplState({ splashItem: splashItemRef.current }));
  // Latest streaming flag in a ref so the stable handleSubmit can read it
  // (Ink setState is async; a sync read of onUserInput's result is unreliable).
  const streamingRef = useRef(false);
  streamingRef.current = state.streaming;
  const { exit } = useApp();

  // Rendering mode: default Static scrollback (no flicker / alt-canvas bugs);
  // alt-buffer fullscreen opt-in via LAZYCLAW_ALT=1 (LAZYCLAW_NO_ALT=1 forces
  // off). TTY-only; read once on mount into a ref (env can't change at runtime).
  const altEnabledRef = useRef(null);
  if (altEnabledRef.current === null) {
    altEnabledRef.current = computeAltEnabled(process.env, process.stdout && process.stdout.isTTY);
  }
  const altEnabled = altEnabledRef.current;

  // Pin the outer column to rows-1 in alt-buffer mode so the sticky Editor
  // pins; non-alt keeps the legacy content-sized layout. Track SIGWINCH resize.
  const { stdout, write: writeStdout } = useStdout();
  const [rows, setRows] = useState(() => (stdout && stdout.rows) || 24);
  useEffect(() => {
    if (!stdout) return undefined;
    const onResize = () => setRows((stdout.rows) || 24);
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  // Stray writes (slash progress, background loop/cron logs) reach the terminal
  // without Ink's knowledge and desync its erase bookkeeping into stale rows.
  // Register Ink's own writer so tui/stray_writes.mjs can redirect them.
  useEffect(() => { setInkWriter(writeStdout, stdout); return () => setInkWriter(null); }, [writeStdout, stdout]);

  // writeFn: route run_turn chunks into React state (factory mode only).
  const writeFn = useCallback((chunk) => {
    setState((s) => onStreamChunk(s, { chunk }));
  }, []);

  // Build runTurn once: factory (new) or the legacy `runTurn` prop.
  const runTurnRef = useRef(null);
  if (runTurnRef.current === null) {
    if (typeof runTurnFactory === 'function') {
      runTurnRef.current = runTurnFactory(writeFn);
    } else if (typeof runTurn === 'function') {
      runTurnRef.current = runTurn;
    } else {
      runTurnRef.current = async () => {};
    }
  }

  const handleSubmit = useCallback(async (text) => {
    // Normalize trailing whitespace so '/exit ' (left over from a popup
    // fill) is treated identically to '/exit'. Empty input → no-op.
    const trimmed = (text || '').replace(/\s+$/, '');
    if (!trimmed) return;
    // /exit + /quit unmount the Ink app. Done inline so the popup path
    // and the no-popup path both terminate cleanly.
    if (trimmed === '/exit' || trimmed === '/quit') { exit(); return; }
    // Mid-stream input (spec §5.8): abort + queue for the next turn via the
    // reducer; do NOT also start a second dispatch (this double-sent 2–3×).
    if (streamingRef.current) {
      const controller = new AbortController();
      setState((s) => onUserInput(s, { text: trimmed, controller }));
      return;
    }
    // Other slash commands: hand off to the host's slash dispatcher
    // (cli.mjs handleSlash) when one is provided. The host returns a
    // string (or void) which we append to scrollback as an assistant
    // turn so the user sees the result inline. If no dispatcher is
    // wired, fall through to runTurn (legacy behavior).
    if (trimmed.startsWith('/') && typeof onSlashCommand === 'function') {
      const controller = new AbortController();
      setState((s) => onUserInput(s, { text: trimmed, controller }));
      try {
        // Pass the signal so the host can abort a long slash op (e.g. /loop)
        // when the user hits Esc (onEscape aborts state.controller).
        const result = await onSlashCommand(trimmed, controller.signal);
        if (result === 'EXIT') { exit(); return; }
        if (result === 'NEW') { clearTerminalScreen(writeStdout); setState((s) => onConversationReset(s)); refreshStatus(); return; } // /new: wipe screen + scrollback so it visually starts over
        if (typeof result === 'string' && result.length > 0) {
          setState((s) => onStreamChunk(s, { chunk: result }));
        }
        setState((s) => onTurnComplete(s, { reason: 'done' }));
        // A slash like /provider or /model mutates the host's active
        // provider/model — refresh the StatusBar so it isn't stale.
        refreshStatus();
      } catch (err) {
        setState((s) => onTurnComplete(s, {
          reason: err && err.name === 'AbortError' ? 'aborted' : 'error', error: err?.message || String(err),
        }));
      }
      return;
    }
    const controller = new AbortController();
    setState((s) => onUserInput(s, { text: trimmed, controller }));
    try {
      await runTurnRef.current(trimmed, controller.signal);
      setState((s) => onTurnComplete(s, { reason: 'done' }));
      refreshStatus();
    } catch (err) {
      setState((s) => onTurnComplete(s, {
        reason: err && err.name === 'AbortError' ? 'aborted' : 'error',
      }));
    }
  }, [exit, onSlashCommand, refreshStatus, writeStdout]);

  // Auto-submit the queued mid-stream message when promoted (spec §5.8).
  useEffect(() => {
    if (state.nextTurnFirstMessage) {
      const msg = state.nextTurnFirstMessage;
      setState((s) => ({ ...s, nextTurnFirstMessage: null }));
      handleSubmit(msg);
    }
  }, [state.nextTurnFirstMessage, handleSubmit]);

  // Esc handler — abort streaming turn, drop partial output.
  const onEscapeKey = useCallback(() => {
    setState((s) => onEscape(s));
  }, []);

  // v6.4 — 2-stage Ctrl+C: first reuses onEscapeKey (cancel + clear), a second
  // press in the Editor's window calls onExit. Active when exitOnCtrlC:false.
  const onExitKey = useCallback(() => { exit(); }, [exit]);

  // ─── Slash popup state (v5.4) ──────────────────────────────────────
  // The editor reports its current buffer via onBufferChange; we derive
  // the filtered command list from that and own the selection index.
  const catalog = useMemo(
    () => (Array.isArray(slashCommands) && slashCommands.length > 0
      ? slashCommands : SLASH_COMMANDS),
    [slashCommands]
  );
  const [bufferPeek, setBufferPeek] = useState('');
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const activeLenRef = useRef(0); // length of whatever popup list is active (commands or arg candidates)
  const filtered = useMemo(
    () => filterSlashCommands(bufferPeek, catalog),
    [bufferPeek, catalog]
  );

  const handleBufferChange = useCallback((buf) => {
    setBufferPeek(buf || '');
  }, []);
  const handleSlashMove = useCallback((delta) => {
    setSelectedSuggestion((i) => {
      const max = Math.max(0, activeLenRef.current - 1);
      const n = i + delta;
      if (n < 0) return 0;
      if (n > max) return max;
      return n;
    });
  }, []);
  const handleSlashDismiss = useCallback(() => {
    setBufferPeek('');
    setSelectedSuggestion(0);
  }, []);

  // ─── Slash-argument completion (v6.x) ──────────────────────────────
  // argSpec resolves what (if anything) is completable after the command.
  //   kind 'inline' → candidates render in the popup (onArgList → argList);
  //                   ↑/↓ select, Tab/Enter fill the token (fillArgToken).
  //   kind 'modal'  → a "↹ pick" hint shows; Tab opens the drill-in picker
  //                   (handleArgComplete → onArgComplete → argInject).
  const argSpec = useMemo(
    () => argSpecFor(bufferPeek, catalog),
    [bufferPeek, catalog],
  );
  const [argList, setArgList] = useState([]);
  useEffect(() => {
    let cancelled = false;
    if (argSpec && argSpec.kind === 'inline' && typeof onArgList === 'function') {
      Promise.resolve(onArgList(bufferPeek))
        .then((items) => { if (!cancelled) setArgList(Array.isArray(items) ? items : []); })
        .catch(() => { if (!cancelled) setArgList([]); });
    } else {
      setArgList((prev) => (prev.length ? [] : prev));
    }
    return () => { cancelled = true; };
  }, [bufferPeek, argSpec, onArgList]);
  const argCompletable = !!argSpec && argSpec.kind === 'modal' && typeof onArgComplete === 'function';
  const [argInject, setArgInject] = useState(null);
  const argNonceRef = useRef(0);
  const handleArgComplete = useCallback(async (buf) => {
    if (typeof onArgComplete !== 'function') return;
    let value = null;
    try { value = await onArgComplete(buf); } catch { value = null; }
    if (typeof value === 'string' && value) {
      argNonceRef.current += 1;
      setArgInject({ value, nonce: argNonceRef.current });
    }
  }, [onArgComplete]);

  // Hide the command popup when the buffer already exactly matches the only
  // remaining suggestion (so Enter submits /exit etc. instead of re-filling).
  const _bufTrimmed = bufferPeek.replace(/\s+$/, '');
  const _exactOnly =
    filtered.length === 1 &&
    (filtered[0].cmd === bufferPeek || filtered[0].cmd === _bufTrimmed);

  // ─── Modal picker state (v5.4.3) ───────────────────────────────────
  // openPicker(opts) → Promise<id|null>. Stores the resolver on `modal`
  // so confirm/cancel/unmount can settle it. The Editor intercepts
  // Up/Down/Enter/Esc/Backspace/printable when modalOpen is true and
  // routes them as host callbacks below; chat buffer and onSubmit are
  // untouched while a picker is up.
  const [modal, setModal] = useState(null);
  const [modalIdx, setModalIdx] = useState(0);
  const [modalQuery, setModalQuery] = useState('');
  const modalView = useMemo(
    () => (modal ? filterModalItems(modalQuery, modal.items) : []),
    [modal, modalQuery],
  );
  const modalRef = useRef(null);
  modalRef.current = modal;
  const closeModal = useCallback((picked) => {
    const m = modalRef.current;
    setModal(null);
    setModalIdx(0);
    setModalQuery('');
    if (m && typeof m.resolve === 'function') {
      try { m.resolve(picked); } catch { /* swallow */ }
    }
  }, []);
  const openPicker = useCallback((opts = {}) => {
    return new Promise((resolve) => {
      setModalIdx(Number.isFinite(opts.defaultIdx) ? opts.defaultIdx : 0);
      setModalQuery('');
      setModal({
        kind: opts.kind || 'generic',
        title: opts.title || 'select',
        subtitle: opts.subtitle || '',
        items: Array.isArray(opts.items) ? opts.items : [],
        searchable: opts.searchable !== false,
        // Carry the secret flag so a credential entry (api-key / token) masks
        // the typed query — dropping it here echoed the secret in plaintext.
        secret: !!opts.secret,
        resolve,
      });
    });
  }, []);
  // Expose openPicker via the host-supplied ref so cli.mjs can inject
  // it into the slash dispatcher's ctx.
  useEffect(() => {
    if (pickerRef && typeof pickerRef === 'object') {
      pickerRef.current = { openPicker };
    }
    return () => {
      if (pickerRef && typeof pickerRef === 'object') {
        pickerRef.current = null;
      }
      // If the app unmounts while a picker is open, resolve(null) so
      // the awaiting dispatcher promise doesn't hang the next /command.
      const m = modalRef.current;
      if (m && typeof m.resolve === 'function') {
        try { m.resolve(null); } catch { /* swallow */ }
      }
    };
  }, [pickerRef, openPicker]);

  const onModalMove = useCallback((delta) => {
    setModalIdx((i) => {
      const max = Math.max(0, modalView.length - 1);
      const n = i + delta;
      if (n < 0) return 0;
      if (n > max) return max;
      return n;
    });
  }, [modalView.length]);
  const onModalConfirm = useCallback(() => {
    // A `freeText` row resolves to { id, query } so the dispatcher can use
    // the typed filter buffer as a custom value (e.g. an unlisted model id).
    closeModal(resolveModalPick(modalView[modalIdx], modalQuery));
  }, [modalView, modalIdx, modalQuery, closeModal]);
  const onModalCancel = useCallback(() => { closeModal(null); }, [closeModal]);
  const onModalQuery = useCallback((next) => {
    setModalQuery(next || '');
    setModalIdx(0);
  }, []);
  const modalOpen = !!modal;

  // Command popup (no space) vs inline-arg popup (has space + an inline spec) —
  // mutually exclusive via the space. Both feed the same Editor/SlashPopup
  // machinery; slashFillMode tells the Editor which fill to apply (whole
  // command vs the arg token). Modal-kind args show a hint instead (Tab opens
  // the drill-in picker). Suppressed entirely while a modal picker is up.
  const cmdPopup =
    !modalOpen &&
    bufferPeek.startsWith('/') && bufferPeek.indexOf(' ') < 0 &&
    filtered.length > 0 && !_exactOnly;
  const argPopup = !modalOpen && !cmdPopup && !!argSpec && argSpec.kind === 'inline' && argList.length > 0;
  const popupRows = cmdPopup
    ? filtered
    : argPopup
      ? argList.map((i) => ({ cmd: i.value, help: i.desc || '' }))
      : [];
  const showSlashPopup = popupRows.length > 0;
  const slashFillMode = argPopup ? 'arg' : 'command';
  activeLenRef.current = popupRows.length;
  // Reset / clamp the highlighted row when the active list changes.
  const lastLenRef = useRef(0);
  useEffect(() => {
    if (popupRows.length !== lastLenRef.current) {
      setSelectedSuggestion(0);
      lastLenRef.current = popupRows.length;
    } else if (selectedSuggestion >= popupRows.length) {
      setSelectedSuggestion(Math.max(0, popupRows.length - 1));
    }
  }, [popupRows.length, selectedSuggestion]);

  // Outer column height: pinned to rows-1 in alt-buffer mode so the
  // Editor truly sticks to the bottom. Non-alt keeps content-sized layout
  // (legacy behavior — required for existing snapshot tests + non-TTY).
  const outerHeight = altEnabled ? Math.max(1, rows - 1) : undefined;

  return React.createElement(
    FullScreen,
    { enabled: altEnabled },
    React.createElement(
      Box,
      { flexDirection: 'column', height: outerHeight },
      // 1) Scrollback.
      //    Alt-buffer path: render items as regular flex children, NOT via
      //    <Static/>. Ink's <Static/> writes once to stdout above the live
      //    frame — in the DEC 1049 alt canvas that area is immediately
      //    overwritten by the next live frame, so the splash + history
      //    end up invisible (v5.4.1 regression). Trade-off: items
      //    re-render each frame; <Splash/> output is stable so this is
      //    visually identical to the Static version.
      //    Non-alt path: keeps <Static/> — the legacy v5.3 contract
      //    (splash scrolls away naturally on the primary buffer) AND the
      //    structural snapshot in tests/v53-repl-layout.test.mjs.
      altEnabled
        ? React.createElement(
            Box,
            // v5.5 — `justifyContent: 'flex-end'` pins the newest content to
            // the bottom of the fixed-height alt canvas; older lines (the
            // splash / sloth + manual) overflow off the TOP and are clipped
            // naturally, exactly like a real scrollback. This replaces the
            // v5.4.3 hack that hard-dropped the splash after the first turn
            // (which made the manual + character abruptly vanish the moment
            // you ran any command). The splash now scrolls off only once
            // there's enough content to push it past the top edge.
            { flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden', justifyContent: 'flex-end' },
            state.scrollback.map((item) =>
              React.createElement(ScrollbackItem, { key: item.id, item })
            ),
            // Live region — partial assistant stream (inside the scroll
            // region so it grows naturally above the status bar).
            React.createElement(LiveRegion, { text: state.liveAssistant }),
          )
        : React.createElement(
            Static,
            { key: `sb-${state.generation}`, items: state.scrollback },
            (item) => React.createElement(ScrollbackItem, { key: item.id, item })
          ),
      // Live region (legacy path only — alt path already rendered it inside the inner Box).
      altEnabled ? null : React.createElement(LiveRegion, { text: state.liveAssistant }),
      // 3) Slash popup — flex sibling above the StatusBar; Ink can't
      //    absolutely position so this is the "just above input" pattern.
      showSlashPopup
        ? React.createElement(SlashPopup, {
            buffer: bufferPeek,
            commands: popupRows,
            selectedIndex: selectedSuggestion,
            forceChooser: slashFillMode === 'arg',
          })
        : null,
      // 3a) Modal-kind arg hint — for 2-step specs (/model, /trainer set,
      //     /orchestrator planner) Tab opens the drill-in picker. Inline-kind
      //     args render their candidates in the popup above instead.
      (!showSlashPopup && argSpec && argSpec.kind === 'modal' && !modalOpen)
        ? React.createElement(
            Box,
            { paddingX: 1, key: 'arghint' },
            React.createElement(Text, { dimColor: true }, `↹ pick ${argSpec.name}`)
          )
        : null,
      // 3b) Modal picker (v5.4.3) — flex sibling above StatusBar, only
      //     visible while ReplApp's `modal` state is set. Suppresses the
      //     slash popup so the overlays don't stack.
      modalOpen
        ? React.createElement(ModalPicker, {
            title: modal.title,
            subtitle: modal.subtitle,
            items: modalView,
            selectedIndex: modalIdx,
            query: modalQuery,
            searchable: modal.searchable,
            secret: modal.secret,
          })
        : null,
      // 4) Status bar (sticky, single row above input). flexShrink:0 so
      //    it isn't squeezed when the scrollback grows.
      React.createElement(StatusBar, {
        provider: _status.provider,
        model: _status.model,
        streaming: state.streaming,
        ctxUsed: _status.ctxUsed,
        ctxTotal: _status.ctxTotal,
        hud: _status.hud,
      }),
      // 5) Editor — sticky bottom, content-sized. Wrapped in a flexShrink:0
      //    Box so Yoga doesn't squeeze the input row when scrollback fills.
      React.createElement(
        Box,
        { flexShrink: 0, flexDirection: 'column' },
        React.createElement(Editor, {
          history: state.history,
          onSubmit: handleSubmit,
          onEscape: onEscapeKey,
          onBufferChange: handleBufferChange,
          // v6.4 — 2-stage Ctrl+C wiring (active when exitOnCtrlC:false).
          onInterrupt: onEscapeKey,
          onExit: onExitKey,
          slashSuggestions: showSlashPopup ? popupRows : null,
          slashSelectedIndex: selectedSuggestion,
          slashFillMode,
          onSlashMove: handleSlashMove,
          onSlashDismiss: handleSlashDismiss,
          // v6.x slash-argument completion (inline fills the token; modal kind
          // uses argCompletable+onArgComplete to open the drill-in picker).
          argCompletable,
          onArgComplete: handleArgComplete,
          argInject,
          // v5.4.3 — modal picker key contract. When modalOpen the
          // Editor swallows all keys (no buffer mutation, no submit).
          modalOpen,
          modalQuery,
          onModalMove,
          onModalConfirm,
          onModalCancel,
          onModalQuery,
          // v5.4.3 — when alt-buffer is on, Editor moves the terminal
          // cursor back inside its content row after each render so
          // macOS Hangul / Japanese / Chinese IMEs draw their pre-edit
          // overlay where the user is actually typing instead of on
          // the row below the editor box. Opt-out via env.
          altEnabled,
        })
      )
    )
  );
}

// ScrollbackItem renders each scrollback child. Splash renders via the real
// <Splash/> component (preserves gradient wordmark colorization); everything
// else is plain Text.
//
// Wrapped in React.memo: scrollback item objects are stable across renders,
// so when only the editor buffer changes (every keystroke) the memo skips
// re-rendering every committed line. Without this the whole alt-buffer
// scrollback re-rendered on each keypress — the source of the typing flicker.
export const ScrollbackItem = React.memo(function ScrollbackItem({ item }) {
  if (item.kind === 'splash') {
    return React.createElement(Splash, item.splashProps);
  }
  if (item.kind === 'user') {
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(Text, null, theme.accent('› ') + item.text)
    );
  }
  if (item.kind === 'error') {
    return React.createElement(Text, { color: 'red' }, item.text);
  }
  // 'assistant' (default)
  return React.createElement(Text, { color: theme.fg }, item.text);
});

// StatusBar moved to ./status_bar.mjs (re-exported above) so the HUD row can
// grow without pushing repl.mjs over the file-size ratchet.

// Exported for tests that want to verify the splash snapshot without a TTY.
export function _renderSplashToString(splashProps) {
  return renderSplashToString(splashProps);
}
