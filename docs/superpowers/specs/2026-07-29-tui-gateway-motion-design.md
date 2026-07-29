# TUI: /gateway command, splash persistence, stale-frame fix, motion package

Date: 2026-07-29
Status: approved (chat session)

## Goals

1. `/gateway` slash command inside the chat REPL (status / start / stop).
2. The startup splash (banner + command manual) must survive `/clear` — today it
   vanishes and the screen is left blank above the input.
3. Kill the "pushed" stale lines: duplicated `○ idle …` status rows and orphaned
   box borders accumulating above the live frame (see repro below).
4. A motion/interactive package for the TUI — 7 features, all gated behind
   TTY + color checks.

Non-goals: idle screensaver, Ctrl+R scrollback search, typewriter output,
matrix rain (explicitly rejected during brainstorming).

## W1 — `/gateway` slash command

Today `lazyclaw gateway` exists only as a top-level CLI command
(`commands/gateway.mjs`); typing `/gateway` in the REPL hits the
did-you-mean fallback (`tui/slash_dispatcher.mjs:1391`).

- Catalog: append `{ cmd: '/gateway', help: 'gateway: status · start · stop (background)' }`
  to `tui/slash_commands.mjs`.
- Dispatcher: new handler in `tui/slash_dispatcher.mjs`:
  - `/gateway` and `/gateway status` — report: process liveness (reuse the
    daemon pidfile helpers in `commands/daemon.mjs` — `readDaemonPidfile`,
    liveness check), bound port, `GET /health` ping with a short timeout,
    enabled channels (from cfg), auth-token file presence
    (`~/.lazyclaw/gateway.token`). Output is a plain text block appended to
    scrollback like every other slash result.
  - `/gateway start` — refuse if already running; otherwise spawn a detached
    child (`lazyclaw gateway`, stdio ignored, `unref()`), wait briefly for the
    health endpoint to come up, report success/failure. Config-safety errors
    from `assertUnattendedSafe` surface as a readable error line, not a crash.
  - `/gateway stop` — SIGTERM via pidfile (reuse the daemon stop helper's
    escalation logic), report result.
- The REPL is never blocked: start is fire-and-verify with a bounded wait.

## W2 — splash disappears after `/clear` (bug)

Root cause: `/clear` wipes the physical terminal
(`tui/repl_reset.mjs:32-37`) and resets scrollback to `[splash]`
(`tui/repl_reset.mjs:14-24`), but the non-alt render path uses Ink
`<Static>` (`tui/repl.mjs:438-442`), which is write-once: its internal
index has already advanced past item 0, so the retained splash item is
never re-printed. The splash survives only in React state, not on screen.

Fix: add a `generation` counter to the REPL state
(`tui/repl_reducers.mjs` / `makeReplState`), incremented by
`onConversationReset`. The `<Static>` element gets
`key={'sb-' + generation}` so the reset remounts it and it re-prints the
current items (the splash). The alt-buffer path re-renders every frame and
needs no change.

Tests: reducer unit test (generation bumps, scrollback keeps only splash);
existing layout snapshot tests must keep passing.

## W3 — stale/duplicated status lines (bug)

Symptom: multiple `○ idle claude-cli · claude-opus-5 ctx --` rows and a
detached editor top-border pile up above the live frame on the primary
buffer.

This is an Ink erase mismatch: Ink repaints the live frame by cursor-up +
erase of the previous frame's height; anything that breaks that count
leaves orphaned rows. Candidate causes, to be confirmed by reproduction
first (systematic-debugging):

1. Writes to stdout that bypass Ink while the REPL is mounted (background
   loop/goal ticks, channel/gateway logs, stray `console.log` in host
   code). Ink can't erase lines it didn't draw.
2. Live frame height exceeding terminal rows in non-alt mode (slash popup
   + status bar + editor + hints) — rows scroll off and can't be erased.
3. The editor cursor re-anchor writes (`tui/editor.mjs:373-378`) running
   outside the alt-buffer path and desyncing Ink's cursor bookkeeping.

Fix by confirmed cause: route host/background writes through the Ink
`writeFn`/`patchConsole`, clamp popup + live-region height to the
terminal, and/or guard the anchor writes to alt mode only. Acceptance:
typing `/…` (popup open/close), long streamed replies, background loop
ticks, and window resize produce zero duplicated rows.

## W4 — motion package (7 features)

New module `tui/motion.mjs`: shared frame helpers as pure functions
(`spinnerFrame(t)`, `shimmerColors(rowPalette, t)`, `tweenGauge(from, to, t)`)
plus one `useMotion(fps)` hook that owns a single `setInterval` and tears
down when inactive. Pure helpers keep everything unit-testable without
timers (same pattern as `streamingIndicator` in `tui/status_bar.mjs:18`).

Global gate: all motion is disabled when stdout is not a TTY, when
`NO_COLOR`/`colorEnabled()` says no, or when `LAZYCLAW_NO_MOTION=1`
(reduced-motion opt-out). `renderSplashToString` stays static — snapshot
tests unaffected.

1. **Streaming spinner** — status bar swaps the pulsing dot for braille
   frames (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏, ~90 ms) plus elapsed seconds while streaming.
   Replaces the 450 ms blink during streaming; idle row unchanged.
2. **Boot sequence** — on startup the splash rows reveal top→bottom over
   ~0.8 s (progressive row count in the Splash component, TTY only).
3. **Banner shimmer** — after the boot reveal, the LAZYCLAW wordmark
   gradient sweeps once for ~1.5 s (palette offset cycling per row,
   `tui/wordmark.mjs` palette), then settles to the static gradient.

   Mechanism note (non-alt path): `<Static>` output is write-once, so a
   splash inside it cannot animate. During the animation window
   (~2.3 s at startup, and again after a `/clear` remount) the splash
   renders as a live flex child; when the animation settles, the final
   static splash is committed to scrollback and the live copy unmounts in
   the same commit. The two renders are identical, so the swap is
   seamless; if it flickers in practice, the fallback is animating in the
   alt-buffer path only and keeping the primary buffer static.
4. **Thinking indicator** — between submit and the first stream chunk, the
   live region shows `⠋ thinking…` (same spinner frames). Disappears on
   first chunk.
5. **ctx gauge tween** — when the ctx percent changes at turn end, the
   ▰▱ gauge fills stepwise from old→new over ~300 ms instead of jumping.
6. **Live meter** — while streaming, the HUD row (when enabled) counts up
   chars/sec (tokens/sec when counts are available from the HUD data
   source) and running cost. Extends `tui/hud.mjs` formatting only.
7. **Error flash** — on a turn error the editor border pulses red twice
   (~900 ms total) then returns to the theme border. Driven by a
   `lastErrorAt` timestamp in REPL state.

Animation state lives only in the leaf components (StatusBar, Editor,
Splash, live region). The memoized scrollback (`ScrollbackItem`,
`tui/repl.mjs:546`) must not re-render on animation ticks.

## Error handling

- `/gateway` handlers never throw into the REPL loop: every failure path
  (health timeout, spawn failure, unsafe config) returns a readable text
  block.
- Motion timers are always cleaned up on unmount/inactivity; a timer
  callback never touches scrollback state.

## Testing

- Unit: pure frame helpers in `tui/motion.mjs`; reducer generation bump;
  `/gateway` handler with injected deps (fake pidfile/fetch/spawn — same
  DI style as `commands/daemon.mjs` stop/status).
- Existing: splash snapshot + v53 layout tests must pass unchanged.
- Manual TTY pass: boot+shimmer, /clear → banner re-appears, spinner +
  thinking + meter during a streamed turn, error flash, no stale rows
  during popup/resize/background ticks.
