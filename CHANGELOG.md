# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Security

- **Sensitive tools are fail-closed by default.** `bash`, `write`, `web_fetch`,
  `browser_navigate`, `delegate`, and every other tool flagged `sensitive` used
  to run with no confirmation whenever no approval hook was wired — which on a
  default interactive install meant an agent, including one steered by prompt
  injection from a fetched page, a channel message, an MCP result, or recalled
  memory, could run arbitrary shell and write arbitrary files with no human in
  the loop. They now **deny by default** unless an approval hook grants the
  call or `security.allowUnattendedSensitive: true` is set in config. The
  interactive REPL and `task tick` ship a default approval prompt (in-chat
  confirm modal / terminal y-N); `--approve-url` remote approval is unchanged.
  Unattended/non-TTY runs without the explicit opt-in refuse sensitive tools
  rather than running them silently.
- **The `bash` tool no longer hands inherited secrets to the child.** It used to
  spawn `sh -c` with the full `process.env`, so a model-issued command (or a
  prompt-injected one) could `env | curl …` and exfiltrate every API key /
  channel token, including those loaded from `<configDir>/.env`. The child env
  is now scrubbed of secret-shaped variables (`*_API_KEY`, `*_TOKEN`,
  `*_SECRET`, `*_PASSWORD`, `*_PRIVATE_KEY`, …) while operational vars (PATH,
  HOME, locale) pass through.
- **SSRF guard hardened and extended to the browser tool.** `web_fetch` chased
  redirects with `redirect:'follow'`, so a public URL could 30x-redirect into
  `127.0.0.1` / `169.254.169.254` / RFC1918 and bypass the pre-flight check; it
  now follows redirects manually and re-validates every hop. `browser_navigate`
  had no host filter at all — it now runs the same DNS-resolving guard before
  `page.goto` and aborts in-page requests to private/metadata IPs via context
  route interception. IPv6 loopback / link-local / ULA and IPv4-mapped-private
  addresses are recognized now too.
- **Config and workflow-state files are written owner-only (0600).** `writeConfig`
  saved `config.json` — which stores plaintext API keys and auth profiles — at
  the default umask (typically world/group-readable 0644), so any local user on
  a shared host could read the keys. It now writes atomically at 0600 inside a
  0700 dir (the pattern the gateway device store already used), tightens an
  existing loose config the first time it is read, and applies the same to
  persisted workflow state.
- **No more fake `landlock` sandbox; seatbelt profile injection closed.** The
  `landlock` confiner reported itself available on any Linux but returned the
  command argv unchanged, so selecting it ran fully unconfined while appearing
  sandboxed — worse than `none`. It now reports unavailable and refuses to build
  an argv (fail-closed) until a real enforcer ships. The macOS `seatbelt`
  confiner interpolated paths into its SBPL profile unescaped, so a path
  containing `")` could inject directives (e.g. re-enable networking); paths are
  now escaped and control characters rejected.

### Fixed

- **`providers test` (CLI + daemon `GET /providers/test`) no longer crashes the
  process when the `claude` binary is absent.** The claude-cli provider spawned
  `claude` but caught only *synchronous* spawn failures; ENOENT (no binary on
  PATH) arrives asynchronously as a ChildProcess `'error'` event, and with no
  listener Node escalated it to an uncaughtException — taking down the whole
  parallel provider probe (empty CLI output / daemon socket close) on any box
  without Claude Code installed, e.g. CI. The provider now attaches an `'error'`
  listener and surfaces the failure as a catchable `CliMissingError`, so the
  probe reports `claude-cli` as a normal per-provider failure (`CLI_MISSING`)
  and the batch always returns valid JSON.
- **The orchestrator now honours `concurrency` as a real bound on parallel
  subtask dispatch.** The parallel execute path fired every planned subtask at
  once through a single `Promise.all`, so a large plan opened N simultaneous
  provider streams regardless of `cfg.orchestrator.concurrency` —
  over-subscribing provider rate limits and buffering every worker's output at
  the same time. It now runs at most `concurrency` subtasks at a time via a
  bounded pool; plans with `<= concurrency` subtasks are unchanged (still start
  immediately), and output is still flushed in plan order.
- **`trainer: auto` now actually detects a Claude session — the $0 learning
  loop works for real subscribers.** Detection was a stub keyed on an exported
  `CLAUDE_CODE_OAUTH_TOKEN`, which a normal `claude login` never sets (it writes
  the keychain / `~/.claude`), so `auto` silently billed the paid chat provider
  for every skill-synthesis / reflection / user-model call. It now also probes
  the credential store and the `claude` binary on PATH, and when it must still
  fall back to a paid provider it prints a one-time notice instead of charging
  silently. Unknown short model aliases now pass through to the CLI instead of
  being dropped to the CLI default.
- **The dashboard Trainer tab no longer shows a no-op "Sync now" button.** It
  posted to `POST /trainer/sync`, a stub that only bumped a `syncQueued` counter
  in `trainer-state.json` that nothing ever drained, then reported "sync queued"
  — implying a manual trigger that did not exist. Learning already runs
  automatically after each completed agent task (`mas/learning.mjs`
  `_runPostTask`), so the button and its dead route are removed and the tab now
  states plainly that there is no manual sync.
- **The web dashboard is responsive on small viewports and keyboard-accessible.**
  The 17-tab nav bar used a hidden horizontal scroll that overflowed even at
  desktop width; it now wraps. The Status summary banner no longer clips its
  right edge on phones, tab controls meet the 44px touch-target minimum, every
  interactive control has a visible keyboard focus ring, and
  `prefers-reduced-motion` is honoured. The dashboard's markup, CSS, and JS were
  also split out of the former single 1964-line `web/dashboard.html` into
  `dashboard.html` + `dashboard.css` + `dashboard.js`, served as same-origin
  static assets.
- **Every advertised OpenAI-compatible provider can now be an agent / trainer.**
  `resolveToolUseAdapter` had a hardcoded 4-provider switch, so onboarding on
  Groq / OpenRouter / DeepSeek / NIM / Together / xAI / Mistral / Fireworks (or
  a custom OpenAI-compatible endpoint) worked for chat but threw "does not
  support text completion" the moment you used agents, teams, or skill
  synthesis. They now resolve to the OpenAI tool-use adapter bound to the
  provider's base URL.
- **Crash-safety in persisted-state and stream paths.** `loadState` (workflow
  inspect/resume) and `trajectory_store.get` did an unguarded `JSON.parse`, so a
  corrupt/truncated file threw an uncaught `SyntaxError` instead of failing
  gracefully — both now return null. The detached loop worker no longer races
  two writers onto `result.json` on SIGTERM. The daemon `POST /chat` stream now
  aborts the provider when the SSE client disconnects (it previously kept
  generating — and billing — to completion), matching the `/agent` path.
- **`index rebuild` repopulates instead of zeroing recall; recall is faster and
  dedup'd.** A bare `rebuild()` (and the daemon `POST /index/rebuild`) dropped
  the FTS5 db and recreated it EMPTY — silently wiping the recall corpus. A
  shared `reindexAll()` now rebuilds AND repopulates from disk (sessions /
  skills / memory); the daemon route and `migrate v5` both use it. Skill /
  trajectory / memory writes upsert by natural key, so replay / re-index no
  longer accumulates duplicate rows that skew bm25 ranking. The recall read
  path skips the per-process `integrity_check` (it belongs in `doctor`), and
  `appendTurn` keeps an in-memory turn counter instead of re-reading the whole
  session file on every turn (was O(n²) over a session's life).
- **Cost tracking works for the subscription path.** `costFromUsage` ignored the
  `total_cost_usd` that claude-cli / codex-cli / gemini-cli report and computed
  only from a user-authored rate card (which ships zero-filled), so subscription
  spend showed as $0 and the daemon cost cap never tripped on it. It now prefers
  the provider-reported dollar cost (no rate card required), falling back to the
  rate card for API providers.
- **Agent skill tools share the real skill store now.** `skill_create` /
  `skill_view` / `skill_edit` wrote and read a private
  `skills/<name>/SKILL.md` directory, while everything else — the
  self-improvement synthesizer, the curator, the FTS5 recall index, and the
  hermes/openclaw importers — uses the flat `skills/<name>.md` store. So the
  agent could not view skills it had synthesized, and skills it created were
  invisible to recall and curation. All three tools now go through
  `skills.mjs`, and `skill_view` records a curator usage hit again. The unused
  duplicate `mas/tools/skill_view.mjs` was removed.
- **`npm test` runs the whole suite again.** The script globbed only
  `tests/phaseC-*.test.mjs` (6 of 110 node files), so the sandbox, FTS5,
  learning, and daemon unit tests never ran under the canonical gate, and it
  failed on a stale resume-count assertion. The node glob now covers
  `tests/*.test.mjs`, Playwright is pinned to `*.spec.ts`, the stale assertion
  is fixed, and a CI workflow runs the full gate on every push and PR.
- **`/model` no longer dead-ends on "orchestrator".** When `cfg.provider`
  is the composite `orchestrator`, the start-up provider picker is skipped,
  so the active provider was the orchestrator — and the Ink `/model` picker
  only listed `PROVIDER_INFO[active].suggestedModels`, which for orchestrator
  is just `['orchestrator']`, with no in-REPL escape. `/model` now detects a
  composite / model-less active provider and lets you pick a real provider
  first (orchestrator + mock hidden), then its model.
- **`/loop --use-memory` / `--recall` are no longer silent no-ops.** The Ink
  `_loop` parsed the flags but never passed a `buildSystem` to the engine, so
  the loop ran without the per-iteration core/episodic memory the readline
  path injected. Restored, including the post-loop system-message restore.
- **`/goal add --cron` actually schedules now.** It used to record the cron
  string on the goal but never install a job (and `/goal close` left any job
  dangling). Both now attach/detach through a shared `goals_cron.mjs`.
- **The StatusBar refreshes after a `/provider` or `/model` switch.** It read
  a literal captured at mount, so it showed the old provider/model until the
  next restart; it now refreshes from a live `getStatus()` after each slash
  command and turn (and feeds the ctx token gauge).
- **Esc aborts a running `/loop`.** The Ink loop used a throwaway
  AbortController; it now uses the REPL's turn signal, so Esc stops the loop
  between iterations and cancels the in-flight request.
- **The splash (sloth + manual) no longer vanishes the moment you run a
  command.** v5.4.3 hard-dropped it from scrollback after the first turn; it
  now stays and scrolls off the top of the alt canvas naturally
  (`justifyContent: flex-end`).
- **Less typing flicker.** Every keystroke re-rendered the whole scrollback,
  including the expensive `<Splash/>` (gradient + ASCII recompute).
  `ScrollbackItem` is now memoized so committed lines don't re-render on each
  keypress. (Full-frame redraw is inherent to the alt-buffer fullscreen; set
  `LAZYCLAW_NO_ALT=1` for the flicker-free Static scrollback.)
- **`/model` can reach any provider's models.** A user on ollama could not see
  the connected claude-cli models; the picker now has a "⇄ pick a different
  provider" row, so opus/sonnet are reachable without leaving `/model`.
- **`/skills` lists + picks installed skills** (was a plain alias for
  `/skill`, which never listed) and tells you how to install when none exist.
- **`/dashboard` opens the actually-bound port.** It hard-coded 19600, so a
  random-port fallback (EADDRINUSE) opened a dead URL; it now reads the
  daemon's printed URL. Also stops leaking a daemon + browser tab under the
  test runner.
- **`/task done|abandon` posts the Slack closing message** to the bound thread
  (parity with the CLI), best-effort and never rolling back the status change.
  `/task start|tick` now echoes the exact shell command with your args.
- **`/menu` command palette.** Browse the full subcommand catalog from chat
  (the no-arg launcher menu was hidden behind `lazyclaw menu`).
- **No typing flicker by default.** The chat now defaults to the Static
  scrollback, which only redraws the small live region per keystroke (the
  alt-buffer fullscreen redrew the whole screen). The splash prints once and
  scrolls naturally — it never hits the v5.4 alt-canvas vanish/blank. Opt back
  into fullscreen with `LAZYCLAW_ALT=1`.
- **First run gets the full guided setup.** A fresh install (no provider)
  routes through the 5-step `cmdSetup` (provider+model, workspace, skills)
  instead of just the provider picker; `chat --pick` stays a lightweight
  re-pick, and a still-unconfigured provider says it's defaulting to claude-cli
  instead of switching silently.
- **`/task start` + `/task tick` run in chat.** They were stubs pointing at the
  shell; `start` registers the task + posts the Slack kickoff, and `tick`
  drives one multi-agent router turn (its logger output streams into the chat).

### Added (restored from the pre-Ink readline chat)

- **`/trainer fallback` routing knob.** `resolveTrainer` honors a
  `trainer.fallback` ("provider:model") but `/trainer set` could only write
  provider+model. Added `/trainer set <p:m> --fallback <p:m>` and a
  `/trainer fallback <p:m> | clear` sub.

- **`/model` live model fetch + custom id.** The picker regains a pinned
  "↻ fetch live model list" row (pulls `/v1/models` for openai / ollama /
  any OpenAI-compatible endpoint) and a "… type a custom model id" row that
  uses the typed filter buffer, so unlisted models (e.g. a local Ollama tag
  like `qwen3.5-instruct:9b`) are reachable from the picker again. Shared
  resolver extracted to `providers/model_catalogue.mjs`.
- **`/provider` family drill-in + tags.** Replaces the flat alphabetical
  list with the legacy auth-family wizard (API key / CLI-Local / Mock,
  orchestrator excluded), with `[needs key]`/`[no key]`/`[custom]` row tags.
  Shared bucketing in `tui/provider_families.mjs`.
- **Register a custom OpenAI-compatible endpoint from chat.** `/provider add
  <name> <baseUrl> [apiKey]` and an interactive "+ add a custom endpoint" row
  (NIM / OpenRouter / Together / Groq / vLLM / LM Studio). Validate / persist /
  hot-register / live-probe core extracted to `providers/custom_provider.mjs`;
  the readline wizard now delegates to it too.
- **Api-key prompt for keyless built-ins.** Picking a built-in api-key
  provider that has no key configured now prompts for one and persists it
  (`providers/auth_store.mjs`), mirrored in-memory so it takes effect the
  same session.

## [5.4.4] — 2026-06-06

### Fixed

- **/dashboard no longer spawns a daemon pile-up.** Rapid repeated
  `/dashboard` inside a single chat session used to fork a fresh
  detached `lazyclaw dashboard --no-open` child every time, and each
  new child's cmdDashboard called `_killPortOccupant` to SIGTERM the
  prior one to claim port 19600. With autorepeat or several /dashboard
  calls back-to-back this stacked 20+ zombie children. Root-cause fix:
  module-level `_dashboardSpawning` latch + `_dashboardChildPid` cache;
  port-level probe (raw `net.connect` to :19600) before the slower
  `/healthz` HTTP probe, so a daemon that has bound the socket but
  not yet answered HTTP is recognized as running. Concurrent /dashboard
  calls now reuse the in-flight spawn and the same browser open.
- **No more cursor flicker from the IME anchor.** v5.4.3's anchor
  moved the terminal cursor inside the editor between renders so
  Ink's next `log-update` eraseLines walked up from inside the editor
  and erased rows ABOVE the actual frame, painting the new frame one
  editor-height higher (visible jitter on every keystroke). The
  editor now lazy-installs a one-time `process.stdout.write` shim:
  whenever the next write starts with `\x1b[2K` (log-update's
  eraseLines prefix) AND the anchor offset is non-zero, the shim
  prepends `\x1b[<offset>B\r` to move the cursor back DOWN to the
  row log-update expects before erasing. Net effect: IME composition
  stays inside the editor AND there is no visible flicker.

### Added

- **`/dashboard stop`** — best-effort kill of every listener bound to
  :19600 (via `lsof -ti tcp:19600 | kill`) plus a `pkill -f
  "lazyclaw dashboard"` sweep. Cleanup helper for anyone who ran
  v5.4.3 long enough to accumulate zombie daemons.

### Changed

- `/status`, `/usage`, `/memory recent`, `/memory episodic` (no
  topic) now render human-readable blocks instead of JSON dumps. The
  shell-CLI subcommands keep their original `emitJson` output for
  scripts. (Hermes-style friendliness pass.)
- `/help` text for `/provider`, `/model`, `/personality` updated to
  surface the no-arg picker as the primary UX.

## [5.4.3] — 2026-06-06

### Fixed

- **/help no longer overlaps the status bar in the alt-buffer chat.**
  The splash carried its own baked-in status row (`provider · model |
  ctx -- | […] | 0s`) at the end of every tier. With ReplApp's real
  `<StatusBar/>` already pinned to the bottom of the alt canvas, that
  baked row appeared as a phantom second status line and — more
  importantly — pushed the tall splash + slash output past the
  bottom-pinned chrome. The baked row is removed in all three render
  tiers; once the user types their first turn, the splash drops from
  the visible scrollback so /help and other multi-line slash output
  renders cleanly above the StatusBar.
- **macOS Hangul / Japanese / Chinese IME pre-edit anchors inside the
  editor.** Ink's `log-update` writes `frame + '\n'`, which parked the
  terminal cursor on the row BELOW the editor's bottom border. macOS
  IMEs anchor the marked-text overlay at the terminal cursor, so
  composing syllables appeared at the bottom-left of the alt canvas
  instead of inside the editor box. The editor now emits a
  `\x1b[<n>A\x1b[<m>G\x1b[?25h` escape after each render to move the
  cursor back into its content row at the correct column (computed
  via the same `wrapToBudget` used to render the buffer). Opt out via
  `LAZYCLAW_NO_CURSOR_ANCHOR=1` if your terminal misbehaves.

### Added

- **Ink-native modal picker for /provider, /model, /personality.**
  New `tui/modal_picker.mjs` component + ReplApp `openPicker(opts) →
  Promise<id|null>` API. Editor intercepts Up/Down/Enter/Esc/printable
  while the modal is up so the chat buffer is never mutated and the
  current turn is never accidentally submitted. `/provider` with no
  arg lists the registered providers; `/model` with no arg lists the
  current provider's suggested models; `/personality` with no arg
  lists `~/.lazyclaw/personalities/*.md`. The legacy `/provider X` /
  `/model X` arg form still works for scripts and non-TTY callers.
- **/dashboard slash.** Probes `http://127.0.0.1:19600/healthz` and
  reuses an already-running daemon when present; otherwise spawns a
  detached `lazyclaw dashboard --no-open` child so the daemon
  outlives the chat session. Opens the URL in the platform browser.
  Never installs signal handlers; Ctrl-C in chat does NOT touch the
  dashboard.
- **/task and /trainer slash forms.** `/task list|show|transcript|
  abandon|done|remove` wraps `tasks.mjs` directly (start/tick still
  point to the shell CLI because they need Slack + the multi-agent
  router). `/trainer show|set <provider:model>|clear` reads and
  writes `cfg.trainer` via a read-merge-write of `config.json` so
  the rest of the user's config is preserved.
- **/clear alias** — same semantics as `/new` / `/reset`; matches
  Claude CLI muscle memory.

### Changed

- `tui/editor.mjs` `wrapToBudget` is now an exported module-level
  function so the cursor-anchor effect and future external callers
  (snapshot tools, tests) can share it without duplicating the
  cell-aware wrap logic.

## [5.4.2] — 2026-06-06

### Fixed

- **v5.4.1 blank-screen bug (real fix).** v5.4.1 claimed to render the
  splash inside the alt-buffer via `<Static items={scrollback}/>`. In
  practice Ink's `<Static/>` writes its items to stdout above the live
  frame — inside the DEC 1049 alt canvas that area is immediately
  overwritten by the next live frame, so the splash + per-turn history
  were invisible. The alt-buffer arm of `tui/repl.mjs` now renders
  scrollback items as regular flex children (`state.scrollback.map(
  ScrollbackItem)`). The non-alt branch still uses `<Static/>` so the
  v5.3 scroll-away contract on the primary buffer is preserved.
- **CJK input character drops.** macOS Korean / Japanese IMEs commit
  each completed syllable as a separate stdin event. The pre-v5.4.2
  `<Editor/>` callback captured `state` via the React render closure,
  so two events fired in the same React frame caused the second
  applyKey to start from the pre-first-event state and overwrite the
  first event's setState payload — leaving the first character missing
  from the buffer. v5.4.2 mirrors editor state into a `useRef` and
  commits through it, so every keystroke applies on top of the most
  recent buffer regardless of render timing.

### Tests

- `tests/v54-altbuffer.test.mjs`: new structural test pins that the
  alt-buffer arm does NOT use `<Static/>` (regression for the v5.4.1
  Static-in-alt-canvas trap).
- `tests/v542-editor-stale-closure.test.mjs`: new test pins the
  `stateRef + commit()` pattern and verifies `applyKey` chains across
  rapid Hangul + Han + emoji inserts without dropping a character.

## [5.4.1] — 2026-06-06

### Fixed

- **v5.4.0 blank-screen bug.** v5.4.0 pre-printed the splash to the
  PRIMARY terminal buffer before entering the alt-buffer; on enter the
  alt-buffer cleared, leaving an empty viewport above the status bar
  and editor. v5.4.1 renders the splash INSIDE the alt-buffer (via
  the existing Static scrollback) so the user sees the wordmark +
  sloth + subcommands catalog as soon as the chat REPL mounts.
- Verified by PTY-capturing `node cli.mjs chat` in a real terminal:
  alt-buffer enter (`\x1b[?1049h`) emits, splash + panel render
  inside the alt-buffer, status bar pins to bottom.

## [5.4.0] — 2026-06-06

### Added

- **Alt-buffer fullscreen Ink mount**. `tui/repl.mjs` now wraps the
  ReplApp in a `FullScreen` component that writes `\x1b[?1049h` on
  mount (saves cursor + switches to alt screen) and `\x1b[?1049l` on
  unmount via the React useEffect cleanup. Signal handlers for exit /
  SIGINT / SIGTERM / SIGHUP restore the primary buffer if the process
  dies rudely. Korean IME pre-edit composition now lands inside the
  Ink editor box because the cursor lives at the editor's last row in
  the alt buffer — no more bleed onto a separate stdout line below
  the rendered frame.
- **All 24 slash commands wired** in the sticky-bottom REPL. New
  module `tui/slash_dispatcher.mjs` ports every command from the v4
  cli.mjs readline handler (`/help · /status · /version · /new ·
  /reset · /usage · /skills · /skill · /tools · /provider · /model ·
  /trainer · /personality · /loop · /goal · /memory · /recall ·
  /dream · /agent · /team · /task · /handoff · /exit · /quit`).
  `/exit` and `/quit` return an EXIT sentinel; everything else
  streams output through the scrollback writeFn so it shows up in
  the Ink chat history.
- 51 new tests across `tests/v54-altbuffer.test.mjs` and
  `tests/v54-slash-dispatcher.test.mjs` exercising every command +
  alt-buffer escape emission. 457 total tests pass (was 406).

### Notes

- Interactive sub-pickers (provider/model picker, personality
  picker) are still readline-coupled in cli.mjs. In the Ink branch
  they print a hint asking the user to pass an arg form
  (`/provider openai` etc) or to fall back to `LAZYCLAW_NO_INK=1`
  for the legacy menu. Ink overlay pickers land in v5.5.
- `LAZYCLAW_NO_ALT=1` opts out of alt-buffer (kept the legacy inline
  render path for users on dumb terminals or tmux-without-alt-screen).

## [5.3.3] — 2026-06-06

### Fixed

- **CJK editor box overflow (real fix).** v5.3.2 claimed to fix
  Hangul/Han width but only updated the `displayWidth` helper — the
  actual Ink `<Box width="100%">` mount still let long Korean buffers
  bleed past the right border in real terminals. The editor now
  pre-wraps the buffer to an explicit cell budget (`process.stdout.columns
  - 4`) using `string-width` per codepoint and sets `Box width =
  TERM` directly, so the box border closes correctly at every tested
  width (60 / 80 / 100 / 120 / 140 cols). New visual-render test
  suite `tests/v533-editor-cjk-render.test.mjs` mounts the actual
  Editor via `ink-testing-library` and asserts no line overflows.
- Added `ink-testing-library` to devDependencies so v5.3.3-style
  render tests can run in CI.

### Note

v5.3.2 was tagged + published but did not actually resolve the CJK
overflow it claimed; users on 5.3.2 should upgrade to 5.3.3.

## [5.3.2] — 2026-06-06

### Fixed

- Default chat provider in fresh onboard is now a concrete provider
  (`claude-cli` etc.) instead of the `orchestrator` meta-provider.
- When `cfg.orchestrator` is undefined, the orchestrator provider
  now truly single-shots to the configured chat provider instead of
  running a Planning/Subtask decomposition for simple questions.
- `displayWidth` helper added to `tui/editor.mjs` (cell-aware width
  math) — but see v5.3.3 above for the real visual fix.

## [5.3.1] — 2026-06-05

Patch release covering three v5.3.0 follow-up bugs reported right after
ship: `/exit` no longer hanging the REPL, the editor frame no longer
absorbing rapid keypresses, and the narrow-tier splash panel rendering
in the correct amber tone.

### Fixed

- `/exit` (and `/quit`) now reliably unmount the Ink app. The slash
  dispatcher recognizes trailing-whitespace variants, and the host
  normalizes the command before routing so the editor's "fill on Tab"
  path no longer produces a stuck process. (`tui/editor.mjs`,
  `tui/repl.mjs`, `cli.mjs`)
- Editor input no longer blocks under bursty keystrokes: the input
  handler no longer awaits inside the synchronous keypress path, and
  the editor frame uses `theme.border` consistently so re-renders stay
  cheap. (`tui/editor.mjs`, `tui/theme.mjs`)
- Narrow-tier splash (`cols ≤ 89`) now paints the bordered panel and
  sloth banner in `theme.fg` (amber `#FFB347`) instead of the terminal
  default, matching the WIDE tier. (`tui/splash.mjs`)

### Verified

- `tests/v53-*.test.mjs`: 58/58 pass (0 fail, 0 skip) in 2.4s.
- Full sweep across phaseA/B/C/E/F/G/H + sandbox + v52 + v53:
  387/387 pass in ~4.1s.
- `echo "/exit" | node cli.mjs chat` exits clean in ~3.1s (well under
  the 5s budget) — no hang.

## [5.3.0] — 2026-06-05

Splash, REPL, and slash popup get a proper narrow-terminal pass. The
launcher no longer truncates verb lists with ellipsis at narrow widths;
the chat REPL sticks the editor to the bottom; the slash-command popup
becomes its own component with a tested catalog.

### Added

- `tui/slash_commands.mjs` — single-source-of-truth slash catalog
  (`/help`, `/exit`, `/model`, `/memory`, `/handoff`, etc.).
- `tui/slash_popup.mjs` — extracted slash-suggestion popup component
  consumed by the editor and REPL.
- `tui/splash.mjs` — narrow-tier renderer with bordered panel, full
  braille sloth banner, and wrapped (never truncated) verb lists.
- `runTurnFactory(writeFn)` in `tui/repl.mjs` — additive turn runner
  used by the new sticky-bottom layout; legacy `runTurn` prop on the
  pre-v5.3 REPL callsite still works via fallback.
- New v5.3 test suites covering splash narrow rendering, REPL layout,
  and slash-popup behavior (33 new tests, 368/368 total passing).

### Changed

- `tui/splash.mjs` — narrow tier (`cols ≤ 89`) now wraps long verb
  rows with indented continuations instead of truncating with `…`.
  The apple row keeps `apple-notes · apple-reminders · findmy ·
  imessage · calendar` intact on every tested width.
- `tui/repl.mjs` — sticky-bottom layout: Static scrollback → live
  region → SlashPopup → StatusBar → Editor (last sibling pins to the
  bottom of the terminal).
- `tui/editor.mjs` — receives `slashSuggestions`,
  `slashSelectedIndex`, `onSlashMove`, `onSlashDismiss`; Esc with an
  open popup clears the buffer.

### Verified

- All three verifier reports pass (splash, REPL, slash popup).
- Full test sweep: 368 pass, 0 fail, 0 skip.
- Non-TTY fallback (`LAZYCLAW_NO_INK=1`) still streams headless
  planner output to stdout.

## [5.2.0] — 2026-06-05

Closes the learning loop and the Anthropic token bill. Audit found 12
critical + 14 major gaps between the v5 spec and what was actually
wired up in v5.0.9; this release lands fixes for all of them.

### Added — Foundation

- `mas/learning.mjs` — `runLearning(trigger, ctx)` hub for the 5 spec
  triggers (post-task, post-failure, nudge, active-recall-miss,
  periodic-curation). Single fan-out point for all learning work.
- `mas/orchestra.mjs` — orchestration coordinator (re-export of
  providers/orchestrator.mjs for v5.2; gets its own runtime in v5.3).
- `tui/run_turn.mjs` — chat REPL turn factory that wires
  `provider.sendMessage`, `sessions.appendTurn`, and the post-task
  learning hook into the ink REPL's previously-stub `runTurn`.
- `chat_window.mjs` — sliding-window helper keeping the chat prefix
  cacheable past long sessions.

### Fixed — Learning loop (C1, C3, C4, C5, C6, M1, M2, M3, M4, M5)

- Chat REPL post-task hook now fires `trajectory_store.put` +
  `synthesizeSkill` (via `resolveTrainer(cfg)`) + `updateUserModel`
  on every turn. Was previously dead code.
- Removed the opt-in `trajectoryRef` guard in `agent_turn.runAgentTurn`.
  Trajectories persist by default; env-var opt-out for tests.
- `composePromptStack` wired into the chat path via `cli.mjs` so
  USER.md + SOUL + personality + skills + memory + trajectory tail
  actually reach the provider system block. Test fixtures keep using
  `agent.role`-only via `usePromptStack: false`.
- `resolveTrainer(cfg)` has its first production callers: chat
  `/exit` slash + the learning hub's post-task path.
- `computeConfidence` + `resolveDampenFactor` now stamp confidence,
  trainedBy, and cross_cli_tested[] on every synthesized skill.
- `recent.jsonl` writes on unsessioned chat too — nudges now fire on
  every install, not only when `--session` is passed.
- `tasks.appendTurn` mirrors to `fts_sessions`, closing a write-path
  hole for multi-agent transcripts.
- `skill_synth.mjs:359` operator-precedence bug fixed (was silently
  corrupting `trained_by` metadata for any skill with prior
  frontmatter).
- Fresh-agent default flipped from `skillWrite: 'manual'` to `'auto'`.

### Fixed — Token efficiency (C8, C9, C10, M6)

- Anthropic prompt caching is on by default. `providers/anthropic.mjs`
  and `providers/tool_use/anthropic.mjs` build the system block as
  `[{text: STATIC, cache_control:{type:'ephemeral'}}, {text: VOLATILE}]`
  and attach `cache_control` to the last entry of `body.tools` so
  the tool schema array caches as a single block.
- `mas/mention_router.buildTurnContext` no longer rewraps the whole
  transcript into a mutating `user` message. It now emits
  `history: [{role:'user', taskDesc}, ...turns, {role:'user', 'Your turn'}]`
  so Anthropic's prefix cache actually hits.
- `chat_window.mjs` caps the chat prefix at 20 turns / 8K tokens
  (sliding window). Long-running sessions stay flat-rate instead of
  linear-in-age.
- Audit estimate: 4-5x reduction in input token cost on typical
  sessions, biggest single win is the C8 + C9 cache_control pair.

### Fixed — Runtime + parity (C7, C11, C12)

- Ink REPL `runTurn` is no longer a no-op stub. The chat streaming
  loop is wired through `tui/run_turn.mjs` so users on real TTYs
  actually chat (instead of the previous fall-through-to-legacy path).
- `providers/orchestrator.mjs` honors `cfg.orchestrator.concurrency`.
  When `concurrency > 1`, subtasks dispatch via `Promise.all` with
  per-subtask buffered streams interleaved. 5 subtasks no longer take
  5x wall clock.
- `cli.mjs cmdDoctor` probes for `git` on PATH. Windows installs
  without Git-for-Windows now get a clear actionable message instead
  of cryptic ENOENT from `mas/tools/git.mjs`.

### Fixed — Minor (M7-M14)

- `tool_runner.listToolSchemas`: `undefined` → DEFAULT_TOOLS,
  `[]` → empty list. Matches deny-check semantics.
- `mas/tools/recall.mjs`: cross-CLI provider-aware re-ranking
  (`workerProvider` arg boosts skills whose `cross_cli_tested[]`
  includes the same provider family).
- `skills.skillsIndex`: memoized read so the index doesn't reload on
  every prompt-stack compose.
- Plus daemon route gaps documented (M14 dashboard tabs that pointed
  at missing routes now have the routes — `/v5/trainer-status`,
  `/v5/recall`, `/v5/sandbox-health`, `/v5/channels-state`).

### Tests

329 tests pass (was 257 in v5.1.0). 72 new tests across:
`v52-learning-hub`, `v52-prompt-stack-wiring`, `phaseH-anthropic-cache-control`,
`phaseH-chat-sliding-window`, `phaseH-daemon-missing-routes`,
`phaseH-doctor-git-probe`, `phaseH-ink-runturn`, `phaseH-learning-loop-closed`,
`phaseH-mas-transcript-messages`, `phaseH-orchestrator-concurrency`,
`phaseH-skills-index-memo`, `phaseH-tool-runner-empty-whitelist`.

## [5.1.0] — 2026-06-05

### Added

- **Responsive splash with 4 tiers**. Splash now collapses cleanly on
  narrow terminals: WIDE (≥140 cols, full wordmark + panel + sloth +
  2-col), MEDIUM (90-139 cols, no wordmark, panel + sloth, wrapped
  values), NARROW (60-89 cols, no panel border, single column with
  truncated verbs), MINIMAL (<60 cols, headline + provider + cwd +
  /help only). 6 new tier tests in `tests/phaseC-splash.test.mjs`.
- **Dashboard v5**. `web/dashboard.html` overhauled to surface v5
  state: trainer-split status, FTS5 recall query box, sandbox backend
  health, channel plugin list, session/skill/trajectory browsers.
  `daemon.mjs` extends the HTTP gateway with the routes those pages
  need.

### Changed

- **README rewrite**. Length, accuracy, and ordering updated for the
  5.0.3 → 5.0.9 splash/launcher work and the responsive tiers.
  Honest "Known limitations (v5.1 roadmap)" section retained.

## [5.0.9] — 2026-06-05

### Added

- **Wordmark gradient**. The Larry 3D `LAZYCLAW` is now rendered with
  a 4-stop warm-orange palette (`#FFD580` → `#FFB347` → `#E08020` →
  `#A05010`), top rows brightest, bottom rows shadow-dark. Same
  gradient applies in the chat splash and the launcher.
- **Subcommands section** in the chat splash. All 40+ lazyclaw
  subcommands are now grouped (core / workflow / config / state /
  runtime / channels / v5 / utility) and listed inside the panel
  alongside Available Tools and Available Skills.
- **Hermes-style bottom separator + status bar**. The splash ends
  with a horizontal rule, a one-line status bar
  (`provider · model | ctx -- | [progress] | 0s`), and another rule
  before the prompt cursor.

## [5.0.8] — 2026-06-05

### Changed

- **New wordmark** — operator-supplied 13×120 "Larry 3D" style ASCII
  art `LAZYCLAW`, replacing the 6×67 ANSI Shadow wordmark from 5.0.6.
  Single-tone orange retained. Wider terminal required for clean
  render (≥124 cols); narrow terminals see the wordmark wrap.

## [5.0.7] — 2026-06-05

### Fixed

- **Chat splash now lists the real tools and skills**. 5.0.6 mounted
  the ink REPL with empty `tools: []` / `skills: []` props, so every
  install rendered `0 tools · 0 skills`. The chat command now reads
  `mas/tools/registry.byCategory()` (12 categories: agents, browser,
  coding, exec, fs, git, iot, learning, media, net, os, scheduling)
  and `skills.listSkills()` grouped by filename hyphen-prefix, and
  passes both into the splash. Sensitive categories are flagged with
  a trailing `*`.

## [5.0.6] — 2026-06-05

### Changed

- **Hermes-style splash**. ANSI Shadow `LAZYCLAW` wordmark on top,
  bordered panel below with the sloth on the left and Available
  Tools / Available Skills on the right. Provider, cwd, and session
  info now sit outside the panel followed by a welcome line and a
  trainer tip — mirrors the Hermes Agent reference layout.
- **Panel is terminal-width responsive**. Border spans
  `process.stdout.columns - 4`, so the box fills wide terminals
  instead of floating in the middle as a small 80-col box.
- **`lazyclaw` (no subcommand) now drops into chat**. The arrow-key
  launcher menu moved behind `lazyclaw menu`. Non-TTY callers
  (pipes, scripts) still get the historical usage line.
- **Shared `tui/wordmark.mjs` module** so the chat splash and the
  launcher render the same ANSI Shadow art without duplication.

## [5.0.5] — 2026-06-05

### Fixed

- **Hero banner now reads as a sloth, not negative space.** The 5.0.4
  chafa render used `--invert`, which mapped the sloth itself to gaps
  and the pillow background to dense `⣿`. In a real terminal that
  inverted to a featureless humanoid silhouette. Replaced with the
  operator-curated 48×35 braille rendering of the same source photo
  with the inversion removed — sloth body, head, and arms now show as
  ink instead of cutouts.

## [5.0.4] — 2026-06-05

### Changed

- **Hero banner is a high-resolution chafa braille render**. Both the
  no-arg launcher and the chat splash now share the same 47×35 dense
  braille sloth (rendered from the Pexels sleepy-sloth photo via
  `chafa --symbols=braille --invert`). Replaces the 24×12 hand-drawn
  icon (chat) and the ANSI Shadow `LAZYCLAW` wordmark (launcher) —
  identical visual identity across both entry points.
- **Chat splash layout is now hero-on-top, single-column body**.
  Tools and skills stack full-width (76 cells) below the banner
  instead of competing for a 24-cell gutter. Verb lists no longer
  truncate. `LAZYCLAW_LEGACY_MENU=1` still drops the launcher banner
  back to the v4 figlet box.
- **Banner contract relaxed**. `tui/banner.generated.mjs` no longer
  has to be 24 cells wide; the test now asserts `rows.length ===
  height` and `stringWidth(row) <= width` instead of literal `24/12`.

## [5.0.3] — 2026-06-05

### Changed

- **Chat splash sloth banner**. The Phase C placeholder (chafa output
  of a featureless silhouette PNG) is replaced with a hand-drawn 24×12
  sleepy sloth: ears, closed eyes, mouth, Zzz inside body, claws, and
  the project label. Reads as a creature; the rasterised conversion
  did not. Still 24 East-Asian-Width cells per row to keep the splash
  gutter math intact (`tests/phaseC-build-splash.test.mjs` unchanged
  and passing).
- **No-arg launcher wordmark**. `lazyclaw` (no subcommand) now opens
  with a 6-row ANSI Shadow "LAZYCLAW" wordmark in box-drawing +
  half-block glyphs (67 cols, single-tone orange). Replaces the v5.0.1
  caption-on-sloth experiment which was visually weak at launcher
  width. Set `LAZYCLAW_LEGACY_MENU=1` to fall back to the v4 figlet
  box; the arrow-key menu beneath is unchanged.

## [5.0.2] — 2026-06-05

### Fixed

- **Critical: `tui/` and `mcp/` directories were missing from the npm
  tarball.** Phase C (ink TUI: splash, repl, editor, ghost, banner,
  theme) and Phase E (MCP stdio client + server_spawn driver) shipped
  in the git tree but were not listed in `package.json#files`, so
  `npm install -g lazyclaw@5.0.0` / `@5.0.1` produced a package that
  silently fell through to the v4 figlet REPL on `lazyclaw chat`
  because `import('./tui/repl.mjs')` threw `ERR_MODULE_NOT_FOUND`.
  Both directories are now in the file list and verified present in
  the tarball.

## [5.0.1] — 2026-06-05

### Changed

- **No-arg launcher banner** now matches the chat splash. Typing
  `lazyclaw` shows the same sloth ASCII art as `lazyclaw chat` (the
  Phase C banner) instead of the v4 figlet box. Visual identity is
  consistent across both entry points.

### Added

- `LAZYCLAW_LEGACY_MENU=1` env var restores the v4 figlet banner in
  the no-arg launcher for users who prefer it. The arrow-key menu
  itself is unchanged.

## [5.0.0] — 2026-06-05

Hermes-parity release. v5 reorganises lazyclaw around four substrates —
**trainer split**, **SQLite + FTS5 learning index**, **tool registry**, and
**channel plugins** — and adds a polished ink-based TUI plus a personality
compose stack.

### Added

- **Trainer split (spec §3)**: `resolveTrainer()`, dotted `config get
  trainer.provider`, separate trainer model independent from chat provider.
  Canonical default `trainer.provider = "auto"` (decision C9).
- **TrajectoryRecord store (§3.3)**: JSONL append-only persistence under
  `<configDir>/trajectories/<task_id>.jsonl` with secret redaction and
  canonical 3-value outcome enum (C1: `done | failed | escalated`).
- **SQLite + FTS5 index (§4)**: `mas/index_db.mjs` mirrors sessions,
  skills, trajectories, and memory into a queryable BM25 store. Recall
  budget < 50 ms on 10 k rows.
- **Write-through hooks**: every `appendTurn`, `installSynthesized`, and
  `trajectory_store.put` now indexes into FTS5. Source-of-truth writes
  never break on index failure.
- **Learning core (Phase B)**: skill_synth v2 with anti-pattern outcome
  switch, user_modeler (Honcho-equivalent USER.md), recall tool over
  the FTS5 substrate, nudge SSE ticker, Wilson + cross-CLI confidence.
- **Ink-based TUI (Phase C)**: two-column splash with sloth ASCII
  banner, ghost autocomplete editor, interrupt-and-redirect REPL, fixed
  4-line footer, multiline editor.
- **6-backend sandbox abstraction (Phase D)**: local / docker / ssh /
  singularity / modal / daytona. Pluggable OS confiners
  (seatbelt / bubblewrap / firejail / landlock). `lazyclaw sandbox
  list|test|add|use` CLI subcommand.
- **Tool registry + 45 tools (Phase E)**: unified `mas/tools/registry.mjs`
  with `adaptLegacy` for v4-shaped tools. New groups: fs, exec, web, os,
  coding, git (5 read + 2 sensitive), scheduling, delegation, media, ha,
  clarify, browser, learning. Sensitive-tool approval hook in
  `tool_runner.mjs`.
- **MCP support (Phase E)**: stdio client + `server_spawn` driver,
  `lazyclaw toolsets` named bundles.
- **Channel plugins (Phase F)**: plugin loader, `channels install|list|
  remove` CLI, threads.jsonl cross-channel session mapping, `/handoff`
  slash command, skeletons for discord / email / signal / voice /
  whatsapp.
- **Persona + migration (Phase G)**: 8-layer prompt compose stack,
  `lazyclaw personality` subcommand + `/personality` REPL slash,
  v4 → v5 migration with rollback, hermes-import, openclaw-import.
- **Trajectory exporter (Phase H)**: `lazyclaw trajectories export
  --format atropos|axolotl|openai-ft|jsonl` with `--since` and
  `--filter outcome=` filters.
- **Tunable cross-CLI confidence dampening (Phase H)**: configurable via
  `orchestra.learning.crossCliDampenFactor`, default 0.85.
- **Docs (Phase H)**: `docs/migration-v4-to-v5.md`, `docs/persona-
  cookbook.md`, `docs/trainer-recipes.md`, Korean companion
  `README.ko.md`.
- **Perf benchmarks (Phase H)**: `tests/index_store.bench.mjs` (single
  insert, bulk 10 k, recall cold / warm / p95) and `tests/phaseH-
  perf.test.mjs` (cold-start ≤ 400 ms, idle RSS ≤ 180 MB).

### Changed

- Provider IDs are canonical kebab-case (decision C3): `claude-cli`,
  `openai-cli`, `gemini-cli`, `ollama`, `z-ai`.
- `sandbox.mjs` deprecated in favor of `sandbox/` directory backends.
- Tool runner now resolves through registry instead of static map.
- Skill frontmatter v2 with `trained_by` enum (C4) and `group` fallback
  to filename hyphen-prefix or `legacy` (C5).

### Migration

Run `lazyclaw migrate v5` from a v4 install. It backs up `configDir` to
`backup-v4-<ts>/`, rewrites `config.json` with `trainer.provider = "auto"`,
upgrades skill frontmatter, and rebuilds the FTS5 index. See
[`docs/migration-v4-to-v5.md`](docs/migration-v4-to-v5.md) for the full
walkthrough and rollback.

### Known limitations (deferred to v5.1)

- `recall` is a tool, not a top-level CLI subcommand.
- `sandbox run --backend ...` CLI shape not yet wired (only
  `list|test|add|use`).
- `codex-cli` and `gemini-cli` provider modules tracked but not
  registered in main runtime.
- E2E matrix test ships with 32/48 flows marked `test.skip` pending
  v5.1 wiring; min-green-set is documented in
  `tests/e2e/phaseH-e2e-matrix.spec.ts`.

## [4.3.0] — earlier

See git history prior to `5.0.0` for the v4.x line.
