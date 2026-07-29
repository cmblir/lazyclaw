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

This is an Ink erase mismatch. Verified by reading
`node_modules/ink/build/{ink,log-update}.js`: Ink repaints by walking the
cursor UP `previousLineCount` rows from wherever the cursor currently is,
and `tui/editor.mjs:373-378` deliberately parks the cursor up inside the
editor box after every commit (for CJK/Hangul IME pre-edit).
`tui/editor_anchor.mjs` compensates for that only when a chunk begins with
`\x1b[2K`. Every Ink write path in 5.2.1 does call `log.clear()` first, so
the compensation usually fires — **the exact trigger is not yet proven.**
Candidate causes, to be confirmed by reproduction first:

1. Writes that bypass Ink while the REPL is mounted — `commands/chat.mjs`
   hands the slash dispatcher a callback that writes straight to
   `process.stdout`, and background loop/cron code can write to
   `process.stderr`. Ink can't erase lines it didn't draw.
2. Live frame height reaching terminal rows, which switches Ink to its
   `clearTerminal + fullStaticOutput` branch.
3. The interleaving of `log` and `throttledLog` around a `<Static>` append.

The reproduction instrument is a VT100 screen model fed by one ordered
byte log containing both Ink's writes and the anchor's writes. Acceptance:
typing `/…` (popup open/close), long streamed replies, background loop
ticks, and window resize produce zero duplicated rows.

**RESOLVED during execution.** The reproduction landed on suspect (1) and
sharpened it: the trigger is a foreign write that **ends a line**. Its
newlines move the cursor down N rows while the anchor still believes the
cursor is parked N rows higher, so Ink's next `eraseLines` walks up from
the wrong baseline and the top N rows of the previous frame survive. Each
bypassing write leaves one more stale row.

That also invalidated the planned fix: no cursor arithmetic in a shim can
repair Ink's line accounting after a foreign newline. Only Ink's own
`writeToStdout` (clear the frame → write the text → repaint below it) can.
The fix is therefore a **stray-write adapter**: Ink renders into a proxy
stdout that flags its own writes, and the shim redirects everything else —
stdout and stderr alike — through Ink's registered writer. That makes
stray writes safe from anywhere, including background loop/cron code, not
just from the one in-repo caller (`commands/chat.mjs`'s slash callback,
which is additionally routed into scrollback).

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

   Mechanism (revised during planning): `<Static>` output is write-once,
   so a splash rendered through it cannot animate, and swapping a live
   splash for a static copy mid-flight is the same erase/cursor desync
   class as W3. Instead the intro plays **before Ink mounts**, writing
   frames to a screen it owns outright, then clears and hands over.
   Consequence: the intro plays at **startup only**, not after `/clear`
   (`/clear` re-prints the settled splash per W2). Budget ~1.15 s total
   (350 ms reveal + 800 ms shimmer), skipped entirely when motion is off.
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
