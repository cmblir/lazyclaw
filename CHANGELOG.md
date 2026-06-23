# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [6.9.1] - 2026-06-23

### Fixed

- **Streaming indicator is green, not amber.** The pulsing stream dot now uses
  a green "live" color instead of the amber brand accent.
- **DB error internals no longer leak to the user.** The better-sqlite3
  ABI-mismatch hint (and other `[index_db]` messages) printed into the chat;
  they're now recorded in the failures log + `lazyclaw doctor` and only echoed
  to the console under `LAZYCLAW_DEBUG`.
- **`lazyclaw message send` is honest + readable.** On a machine with no Slack
  configured it now says so in plain text with the exact setup command, instead
  of a terse error; success prints `✓ sent to "<name>"` rather than raw JSON.
  add/remove are human-friendly too.

## [6.9.0] - 2026-06-23

### Fixed

- **Orchestrator on/off in chat now switches the LIVE provider.** "orchestrator
  off" wrote `cfg.provider` but the REPL kept its in-memory provider, so the HUD
  still showed `orchestrator` and the next turn still answered as orchestrator.
  The turn-runner now re-points the live provider + status from cfg after an
  on/off, matching `/provider`.
- **Setup provider picker — Esc steps back one level.** Esc on the model step
  (Step 3) restarted the picker at the auth-family step (Step 1) instead of
  returning to the provider step (Step 2).

### Added

- **Blinking streaming indicator.** While a turn streams, the status-bar dot now
  pulses (bright ↔ dim) so there's a live "working" signal; idle is steady.
- **Esc-to-go-back in the setup wizard's typed questions.** The context-window
  and tool-permission prompts read keys in raw mode (`tui/prompt_back`), so Esc
  now steps back (permission → context); arrow keys are ignored, Backspace and
  Enter work as expected.

## [6.8.0] - 2026-06-23

### Added

- **Configurable tool-permission mode for claude-cli.** `cfg.chat.permissionMode`
  (asked at `lazyclaw setup`; `config set chat.permissionMode <mode>` too) is
  threaded into every claude spawn — interactive chat, the persistent session,
  and the agentic path. Unset defaults to `bypassPermissions` so the agent
  doesn't stop to ask before each tool; pick `default`/`acceptEdits`/`plan` to
  re-enable prompting.
- **Plain-language orchestrator control in chat.** Typing "orchestrator off",
  "플래너를 소넷으로", "워커를 하이쿠로", etc. now actually writes
  `cfg.orchestrator` (and confirms) instead of being sent to the model. The
  matcher is conservative — questions and unrelated chat pass through untouched.

### Fixed

- **Chat no longer fakes settings changes.** Config changes it can't apply are
  no longer answered with a hallucinated "done": a system-prompt guard tells the
  model to give the real command (`/orchestrator`, `lazyclaw agent add`, …). The
  per-turn orchestrator banner already reflected real config, so the stale
  display was the unpersisted change — now fixed end-to-end.

## [6.7.0] - 2026-06-23

### Added

- **`lazyclaw login`** — verify or establish the claude-cli credential. It
  resolves the bearer across `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` /
  the `~/.claude` credential file / the macOS Keychain and reports the source;
  when none is found it runs `claude setup-token` to mint a long-lived token and
  stores it (via `--token`) in `<config>/.env` (0600). `login --check` is a
  non-interactive status probe.

### Fixed

- **claude-cli model listing now works keyless on macOS.** `claude login` stores
  its OAuth token in the macOS Keychain (no `~/.claude/.credentials.json`), so
  listing models previously failed with "set ANTHROPIC_API_KEY or
  CLAUDE_CODE_OAUTH_TOKEN". lazyclaw now reads the `Claude Code-credentials`
  Keychain item (read-only; the token only goes to api.anthropic.com) and uses
  the existing login automatically.
- **better-sqlite3 ABI mismatch no longer spams the REPL.** When the native
  addon was built against a different Node.js version (`NODE_MODULE_VERSION`
  mismatch), every recall/skill index write dumped a stack trace. lazyclaw now
  prints one actionable hint (`npm rebuild better-sqlite3`) and stays quiet;
  chat is unaffected.

## [6.6.0] - 2026-06-22

### Added

- **Choose an agent's Team Live avatar.** Agents gained an optional `avatar`
  field: `lazyclaw agent set-avatar <name> <1-20>` picks one of the 20 built-in
  pixel-art sprites instead of the keyword-inferred default (`none` restores
  inference; `agent add/edit --avatar` work too). The dashboard already rendered
  `rec.avatar` — this supplies the writer it never had.
- **Custom character photo per agent.** The same command also accepts a real
  image: `lazyclaw agent set-avatar <name> <file|url>`. A local image
  (png/jpg/jpeg/gif/webp) is copied under `<configDir>/agent-avatars/` and a
  remote URL is stored verbatim; the daemon serves copied files at
  `GET /agent-avatars/<file>` (filename constrained — no path traversal). The
  Team Live tab renders the custom photo ahead of the sprite + inference.

## [6.5.0] - 2026-06-22

### Fixed

- **Cost accounting hardened across the remaining providers.** The persistent
  warm claude-cli session (now the default chat path) now surfaces cache tokens
  and signals a `--max-turns` cut; `codex-cli`/`gemini`/`gemini-cli` reported
  their prompt count as cache-inclusive while also surfacing cache-read tokens,
  so a rate card double-billed the cached portion — those providers now report
  `inputTokens` net of cache (matching Anthropic), so the cap prices each turn
  once; and `gemini-cli` now reports usage on a failed (error) turn instead of
  throwing before the tokens are counted.
- **OpenAI tool-use surfaces malformed tool arguments.** A tool call whose
  `arguments` is neither a string nor an object is now recorded as a tool error
  instead of silently running the tool with `{}`.

### Added

- **`lazyclaw config set` writes nested dotted keys.** `config set chat.recall
  false` now sets `chat: { recall: false }` (boolean) instead of a literal
  `"chat.recall": "false"` string; values coerce by type (true/false → boolean,
  clean integer/float → number, ids like `gpt-4.1` stay strings). Flat keys are
  unchanged.
- **Cache token metrics.** `metrics.tokensTotal` now also counts
  `cacheReadInputTokens` / `cacheCreationInputTokens`; the Gemini tool-use
  adapter honors `maxTokens` (output cap).

### Changed

- **Internal: D8 split-debt paydown.** Eight oversized modules (chat, setup,
  agents, automation; pickers, repl, slash_dispatcher, editor) were split into
  focused sibling modules — pure refactors, no behavior change — clearing the
  file-size gate. No user-facing impact.

## [6.4.0] - 2026-06-22

### Fixed

- **Team (channel-bound) turns now count toward the cost cap.** A Slack channel
  bound to a team drove a multi-agent loop whose spend was invisible: the
  tool-use adapters dropped token usage, `runAgentTurn` never surfaced it, and
  the inbound route never accounted it — so the cap was checked once at
  admission but team spend was never added, and it never tripped on team
  traffic. The whole chain now carries usage: the anthropic/openai/gemini
  adapters expose normalized `{ inputTokens, outputTokens }`, `runAgentTurn`
  accumulates it, `runTaskTurn` fires `onUsage` per agent turn with that agent's
  `provider`+`model` (so a mixed-provider team prices each turn against the
  right rate card), and the daemon accumulates it into metrics and aborts the
  loop mid-run once the cap trips. claude-cli agents bill a flat $0 so they
  don't move the cap.
- **Streaming, CLI, and tool-use providers now report token usage to the cost
  cap.** A provider audit found several paths dropping usage so their spend was
  invisible: Gemini and Ollama streaming never read usage at all; the claude-cli
  one-shot, persistent-session, and tool-use paths read the zero-usage `result`
  event instead of the per-turn `assistant` event (so the default subscription
  agentic path reported nothing); codex-cli double-counted cached/reasoning
  tokens (they are subset breakdowns, not additive); gemini-cli dropped
  reasoning (`thoughts`) tokens; OpenAI/openai-compat/Anthropic stranded usage
  when a stream closed without its terminal frame; and the tool-use adapters
  dropped cache tokens. All now surface input/output/cache tokens (plus cost on
  the subscription path), and `runAgentTurn` carries cache + total cost through
  so the cap can price them.
- **A truncated streaming turn is no longer shown as a complete answer.** When a
  turn hits the model's output-token limit (OpenAI/openai-compat
  `finish_reason: length`, Gemini `MAX_TOKENS`/`SAFETY`/`RECITATION`, Anthropic
  `stop_reason: max_tokens`, Ollama `done_reason: length`) the provider fires
  `onTruncated` and interactive chat appends a `[truncated … raise maxTokens]`
  notice, mirroring the agentic path. Gemini streaming also honors `maxTokens`.
- **`config validate` stops false-flagging valid keys.** `KNOWN_KEYS` listed
  only 9 top-level keys, so a dozen keys the rest of the codebase actually reads
  (`sandbox`, `channels`, `cron`, `pairing`, `authProfiles`,
  `authActiveProfile`, `nodes`, `messaging`, `mcp`, `orchestra`, `security`,
  `skills`, `workspace`) were reported as "unknown top-level key" warnings on a
  perfectly valid config. They're now recognised; a genuinely unknown key still
  warns.
- **Response-cache key now covers the static/volatile system prompt.**
  `withResponseCache`'s `hashKey` folded in only `opts.system`, ignoring
  `opts.systemStatic` / `opts.systemVolatile` (the fields the REPL caller
  actually uses) and any embedded `role:system` message. A caller that varied
  only its static system with a fixed `messages` array could collide on one key
  and be served another call's cached reply. The key now folds in all three
  system sources; identical inputs still hash identically so real hits are
  unaffected.

### Changed

- **The persistent warm claude-cli session is ON by default for interactive
  chat** (set `cfg.chat.persistentSession=false` to disable). Reusing one warm
  process per conversation amortizes the Claude Code harness boot — measured
  ~1.2s/turn (~42%) faster after the cold first turn (a model-independent win;
  latency is otherwise model-dominated). Scoped to the interactive path (the
  daemon is unaffected, so it stays one warm child per conversation); the
  session respawns if the system prompt changes (e.g. plan-mode toggle) so it
  can never answer with a stale system, and recall already rides the user turn.

### Added

- **Hermes-style workflow automation — `lazyclaw workflow add/run`, cron, and
  Slack triggers.** A declarative workflow can now be stored by name
  (`cfg.workflows[<name>]`), run on a schedule, AND triggered by an inbound
  Slack message: when a message arrives on a workflow-bound channel
  (`--channel slack:#x`), the daemon runs that workflow with the message as
  `{{input}}` and replies with its output (an unbound channel is unchanged). `workflow add <name> <def.json> [--channel slack:#x]
  [--cron "<spec>"] [--reply-node <id>]` persists it (and installs an OS cron
  job `lazyclaw workflow run <name>` when `--cron` is given); `workflow run
  <name>` executes the def and posts its reply (the named reply node, else the
  last node's output) to the bound Slack channel; `workflow list/show/remove`
  round it out. So a stored workflow runs on a schedule and replies in Slack —
  no resident scheduler (the OS fires it) and no new dependency.
- **Device tokens get a TTL, capability scope, and `nodes rotate`.** A paired
  device's bearer token never expired and carried no authorization. Now:
  `approve`/`rotate` can stamp an `expiresAt` (`--ttl <ms>`), and the gateway
  rejects an expired token on every authenticated route; the signed pairing
  payload's `role`/`scopes` are persisted, and a `read-only` device is blocked
  (403) from resolving an exec approval (the one mutating gateway action);
  `lazyclaw nodes rotate <deviceId>` re-issues a token in place (the old one
  stops working immediately) without ever printing it. Fully backward-
  compatible: a legacy record with no `expiresAt` never expires and a role-less
  device keeps its prior behaviour.

### Changed

- **Chat surfaces per-turn recall.** The streaming chat path sent a fixed system
  prompt, so it never pulled in context relevant to the CURRENT message — only
  the agentic path (which rebuilds the prompt stack per turn) did. Each user
  message now gets a fresh recall layer prepended to it before sending (the
  stored session keeps the original). It rides the user turn rather than the
  system because a warm `claude-cli` persistent session fixes its system at
  spawn and every provider reads the user message. Best-effort + lazy (an empty
  or missing index never blocks a reply); opt out with `cfg.chat.recall=false`.
- **Opt-in agentic orchestrator workers (`cfg.orchestrator.agenticWorkers`).**
  An EXECUTE-phase worker could only stream text — it couldn't use tools. With
  `agenticWorkers: true` each worker runs through `runAgentTurn` instead, so it
  can do real work with its tools (shell / file read / grep / recall) and then
  report. Tool calls are confined by the caller's sandbox; the loop is bounded
  by `workerMaxIterations` (default 8) and propagates the abort signal. Off by
  default — the text-streaming path is byte-stable.
- **The orchestrator runs its worker pool in parallel by default.** A bounded
  parallel dispatch existed for `cfg.orchestrator.concurrency >= 2`, but the
  default when it was unset was `1` (sequential), so an unconfigured fleet ran
  subtasks one at a time — wall-clock = sum, not max. The default is now
  `min(3, workers.length)`. An explicit `concurrency` of `0` or `1` still
  selects the sequential live-streaming path (each worker's tokens stream as
  they arrive); parallel buffers per subtask and flushes in plan order.
- **SSE streaming yields only under real backpressure.** The `/chat` and
  `/agent` token streams awaited a full event-loop turn (`setImmediate`) after
  EVERY token, even when the socket's write buffer wasn't full. `writeSse` now
  returns the data-frame `res.write()` result, and the loops yield only when it
  signals a full buffer — dropping one event-loop turn per token in the common
  case while still relieving backpressure for a slow consumer.
- **The post-task learning hook runs its two trainer calls in parallel.**
  `synthesizeSkill` and `updateUserModel` are independent LLM calls
  (`updateUserModel` doesn't consume the synthesised skill), but ran
  sequentially — a full network round-trip for one before the other started.
  They now run concurrently via `Promise.allSettled`, each keeping its own
  error isolation, halving the background learning pass's wall-clock.
- **Dashboard static assets are served from memory, not re-read per request.**
  Every GET for `dashboard.html` / `.css` / `.js` and the 20 avatar PNGs ran a
  synchronous `fs.readFileSync` of the whole file, blocking the event loop on
  each request. Assets are now served from an mtime-keyed in-memory cache (read
  once per unchanged file; a dev edit still busts it), and `dashboard()` drops
  its per-request `await import('node:fs')`.
- **Skill bodies are read from disk once, not every agent turn.** `loadSkill`
  did a fresh `readFileSync` per call, and `composeSystemPrompt` calls it once
  per requested skill on every `POST /agent` reply — so each turn re-read every
  selected skill `.md`. The skills *index* was already cached; now the per-skill
  *body* is too (mtime-keyed, so a live edit or `installSkill` rewrite busts it).
- **Inbound Slack routing no longer rescans the teams directory per message.**
  Auto-routing a channel message to its team called
  `teamForChannel(listTeams(configDir), channel)` — a full `teams/` readdir + a
  `JSON.parse` of every team file + a linear scan, on every inbound. A new
  `teamForChannelCached` builds a `slackChannel`→team index once and reuses it
  until the directory changes (`register`/`patch`/`removeTeam` invalidate it,
  and the dir-mtime key also catches manual edits), so the lookup is an O(1)
  `Map.get`.
- **The prompt-stack composer stops re-reading static files every loop pass.**
  `composePromptStack` runs once per iteration of the per-message agent loop and
  re-read four static config files (global `SOUL.md`, workspace `SOUL.md`,
  personality, `USER.md`) from disk on every call through an unmemoized
  `readOpt`. Those layers are byte-identical across a loop, so the reads were
  pure waste. `readOpt` is now mtime-memoized (same pattern as the skills
  index): an unchanged file is read once, and editing it busts the cache. The
  volatile layers (recent-turn tail, FTS recall) are untouched.
- **CLI providers retry transient upstream throttles instead of failing hard.**
  `claude-cli` / `codex-cli` / `gemini-cli` surface server-side throttling by
  exiting non-zero with the throttle text on stderr (e.g. claude's "Server
  temporarily limiting requests (not your usage limit)"). Every non-zero exit
  used to map to a non-retriable `CLI_EXIT`, so a transient throttle killed the
  call — and a fan-out of agents — outright. A new `classifyCliExit`
  (`providers/cli_error.mjs`) maps those throttles (overload, 429/5xx) to a
  retriable `RATE_LIMIT` with a short backoff, while keeping a genuine usage cap
  ("reached your usage limit", out of credits) non-retriable so it still fails
  fast.
- **Chat replies no longer block on the FTS index write.** `sessions.appendTurn`
  runs on the reply path (before the answer is flushed to the client), but it
  mirrored each turn into the better-sqlite3 FTS index inline via a static
  import — a fully-synchronous `INSERT`, plus a first-turn schema-create, sat
  directly on the user-visible latency path. The mirror write is now deferred
  off the calling tick behind a dynamic import (mirroring `tasks.mjs`), so the
  only thing on the reply path is the durable JSONL append; recall is unchanged
  (the row still lands, just a tick later).
- **`claude-cli` chat is dramatically faster (whole-codebase perf pass).** A
  user message used to cold-spawn `claude -p` THREE times (1 answer + 2 trainer)
  and let Claude Code run an unbounded internal agent loop. Fixes: the internal
  loop is now bounded (`--max-turns`/`--tools`; measured "make a team" 126s → 9.4s);
  the per-turn learning hook is gated so trivial turns don't spawn 2 extra
  `claude` (greetings/acks/short/empty turns skip synth + user-model); the
  SQLite `integrity_check` is no longer paid on the recall/session-write hot
  paths; and `readConfig` is mtime-cached (was re-parsed on every daemon
  request). Opt-in **persistent session** (`cfg.chat.persistentSession=true`,
  new `providers/claude_cli_session.mjs`) keeps one warm `claude
  --input-format stream-json` child per conversation so the harness boots once
  instead of every turn (measured turn 2+ ~1.1s vs ~2.2s), preserving the $0 Pro
  subscription.
- **`claude-cli` runs lean — much faster and on-task.** The provider spawned
  `claude` in the user's normal environment, so every turn loaded the user's
  global `CLAUDE.md`, skills, hooks, and all configured MCP servers (~180k
  tokens, measured, running from a project dir) and let Claude Code act on that
  personal config instead of lazyclaw's prompt — slow, and off-task. It now
  runs `claude` with `--setting-sources ''` (no user/project/local settings)
  and `--strict-mcp-config` (no MCP), so lazyclaw's own system prompt drives a
  clean session: per-turn context dropped ~10× (≈180k → ≈18k) and responses
  stop being polluted by the user's skills/CLAUDE.md. Pass the provider
  `lean: false` to restore the full Claude Code environment.

### Added

- **Declarative workflows can be authored in YAML** (`workflow add <name>
  file.yaml`). A dependency-free parser (workflow/yaml_min.mjs) handles the subset a
  def needs — block maps, sequences of maps, scalars, inline JSON, and `|`/`>`
  block scalars — and errors clearly on anything unsupported (tabs, unclosed
  flow). JSON stays canonical; no new dependency.
- **Declarative workflows can run persisted + resumable.** `POST /workflows/run`
  with a `sessionId` (or `runDeclarativeRequest({ sessionId, dir })`) runs through
  the persistent engine: state is keyed under the workflow-state dir and a second
  run with the same `sessionId` resumes — already-succeeded nodes are skipped.
  The `{{ref}}` bag is pre-seeded from the prior run's success outputs, so a
  downstream reference to a skipped node still resolves.
- **Declarative workflows, runnable over HTTP.** Workflows were hand-written
  `.mjs` passing arbitrary node functions to the executor. You can now author a
  workflow as DATA — `{ nodes: [{ id, type, config, deps?, timeoutMs?, retry? }] }`
  (`workflow/declarative.mjs`) — compiled onto the existing executor
  (ordering / timeout / retry / cleanup / cancellation unchanged). Data flows
  between nodes by `{{ref}}` (e.g. `{{fetchUser.name}}`, nested + whole-value
  refs). Built-in node types are safe (`set`, `template`); side-effecting types
  (`http` SSRF-guarded, `llm` provider-backed) are granted by the runner via
  `caps.nodeTypes` — capability injection, not ambient power. **`POST
  /workflows/run`** executes a posted definition with caps derived from the
  daemon config (http + the configured llm provider, never shell), so a posted
  workflow can't spawn a process or reach a private host. (Next: sandboxed
  `shell` + `channel-send` node types, YAML input, persisted/resumable runs.)
- **Opt-in hybrid recall — embedding similarity blended with FTS5 (off by
  default).** Recall stayed pure-FTS5 bm25. Now, when `cfg.recall.embeddings` is
  enabled, the `recall` tool embeds the query and re-ranks the FTS candidates by
  a fused bm25 + cosine score, so semantically-close hits surface even when the
  keyword ranking is flat. Embeddings come from a pluggable source
  (`mas/embedder.mjs`): OpenAI / Gemini (needs a key) or a local Ollama embed
  model (keyless). The $0 chat-subscription user has no embedding source and
  rides pure FTS5 — we deliberately bundle **no** heavy local model. No new hard
  dependency: doc vectors are stored as BLOBs and cosine runs in JS (sqlite-vec
  is a possible future optimization for very large indices). `lazyclaw index
  embed` backfills doc vectors off the hot path. Default behavior is byte-stable
  pure-FTS5.
- **Opt-in wall-clock cap on streaming replies (`cfg.chat.maxStreamMs`).** The
  daemon's `/chat` and `/agent` SSE streams only had a per-chunk idle timeout,
  so a model that streams steadily could run unbounded. Set
  `cfg.chat.maxStreamMs` to abort the turn after that many milliseconds; the
  client gets a `truncated` SSE event (reason `maxStreamMs`) so it can tell a
  capped reply from a clean finish or a disconnect. Unset/≤0 is a no-op —
  existing streams are byte-stable.
- **`lazyclaw mcp add / remove / call`.** MCP servers were manageable only by
  hand-editing `cfg.mcp.servers`, and there was no way to invoke a tool from the
  CLI. `mcp add <name> --command <cmd> [--args "…"] [--allow-glob <glob>]
  [--env "K=V …"]` and `mcp remove <name>` mutate the config (atomic 0600 write,
  duplicate-name rejected, name validated as the `mcp:<name>:<tool>` namespace);
  `mcp call <server> <tool> [--args-json '{…}']` spawns the server in-process,
  runs one tool through the approval-gated registry, and tears it down.
  `mcp list` (configured + connected) is unchanged.
- **Live agent-team dashboard.** Agents gain an optional `manager` field, so a
  team forms an org tree (a planner with sub-agents on different harnesses — e.g.
  a data-engineer on `gemini-cli`, a backend on `claude-cli`). A new in-process
  event bus (`mas/events.mjs`) streams agent activity over `GET /events`
  (Server-Sent Events) — `task`/`turn`/`tool.call`/`agent.status`/`delegate`
  events emitted by the mention router, agent-turn loop, and `task_spawn`. The
  new **Team Live** dashboard tab renders the team as avatar tiles with status
  rings + harness badges, animates real-time agent-A→B delegation, and opens a
  click-to-drill-down panel (harness, current task, recent activity). A Slack
  message to a channel bound to a team (`team.slackChannel`) now auto-routes into
  the multi-agent task loop instead of a single-shot reply, so the team works the
  request and the dashboard shows it live.

### Security

- **Sensitive tools are confined by default.** `bash`, `python_exec`/`node_exec`,
  the `git_*` tools, and the `os` tools now run inside an OS sandbox by default
  (macOS `seatbelt`, Linux `bubblewrap`/`firejail`, auto-detected): writes are
  limited to the workspace + temp, and secret directories (`~/.ssh`, `~/.aws`,
  `~/.gnupg`, the lazyclaw config dir, …) are unreadable — even an approved
  command can no longer exfiltrate host credentials or write outside the
  workspace. The seatbelt profile is an allow-default base that carves out the
  filesystem (a strict `deny default` profile silently killed `python3`/`node`
  at the dyld stage on macOS). Network is allowed; the secret-scrubbed child env
  still applies. Confinement is threaded at the agent entrypoints (task tick,
  agentic chat, `task_spawn`), so `runTool`/`runAgentTurn` library defaults stay
  byte-stable. Opt out with `cfg.sandbox.confine=false`; inspect the effective
  posture with `lazyclaw sandbox status`. The keyless `gemini-cli` trust bypass
  (`--skip-trust` + `GEMINI_CLI_TRUST_WORKSPACE`) is consolidated behind one
  `trustWorkspace` switch. `browser_*` keeps its in-tool SSRF guard (Playwright
  manages its own Chromium subprocess and is not OS-confined).
- **Remote skills are sanitized on install.** A skill installed from
  GitHub/URL is injected into other agents' system prompts, but the body was
  copied verbatim; it now runs the same redact / `[[TASK_DONE]]`-defang /
  control-strip pass as synthesized skills, plus role-label neutralization.
- **`env` scrubbing catches the real secret names.** The bash/coding child
  env now drops `*_KEY`/`*_KEY_ID`, connection strings (`DATABASE_URL`, …),
  `SSH_AUTH_SOCK`, and any value that is a `scheme://user:pass@host` URL —
  previously `STRIPE_SECRET_KEY`/`SUPABASE_KEY`/`AWS_ACCESS_KEY_ID` leaked.
- **`image_describe` is confined to the working directory** (it uploads the
  bytes to OpenAI, so it can no longer be coaxed into exfiltrating an
  arbitrary host file), and `file_dialog` escapes the model-supplied prompt
  to close an AppleScript-injection hole.

### Fixed

- **tool_use turns truncated at the token ceiling are caught.** Anthropic /
  OpenAI / Gemini adapters now flag `max_tokens`/`length`/`MAX_TOKENS` and the
  agent stops instead of acting on a partial answer or empty tool args; the
  OpenAI adapter also surfaces malformed tool-call JSON as a tool error rather
  than silently running with `{}`.
- **Team agents can be granted any registered tool.** Agent tool grants are
  validated against the live 51-tool registry instead of a hardcoded 8-name
  list (with a stale, unregistered `slack_post`).
- **launchd cron honours cron's OR semantics** for restricted day-of-month ×
  day-of-week, matching crontab on Linux.
- **The default (unauthenticated) daemon no longer leaks nested API keys.**
  `GET /config` and `GET /config/<key>` shallow-copied the config and masked
  only the top-level `api-key`, serving `customProviders[].apiKey`,
  `authProfiles` key material, and channel bot tokens in cleartext to any
  local process. Both endpoints now deep-redact every secret-named value at
  any nesting depth (numeric budgets like `chatWindow.tokens` are preserved).
- **`python_exec` / `node_exec` no longer hand the full secret env to the
  snippet.** They spawned with `env: process.env` while claiming a "sandboxed
  subprocess"; the child env is now scrubbed of secrets (as `bash` already
  was) and the false "sandboxed" wording is dropped.
- **In-chat credential entry is masked.** `/provider key`, `/login apikey`,
  and `/channels` credential prompts echoed the typed API key/bot token in
  plaintext (the picker dropped the `secret` flag); the modal now renders
  bullets.

- **`lazyclaw export` no longer leaks per-provider secrets.** Redaction
  previously masked only the top-level `api-key`; it now deep-redacts any
  secret-named config value and the `authProfiles[<provider>][].key` entries
  (keeping `label` so the bundle stays inspectable). `lazyclaw import`
  reciprocally strips the `***REDACTED***` placeholder so it is never
  persisted into `config.json`. `--include-secrets` still exports verbatim.

### Fixed

- **Channel setup no longer points at packages that don't exist.** The five
  non-builtin channels (Discord/Email/Signal/Voice/WhatsApp) ship in-tree, but
  setup + `channels install` told you to install unpublished
  `@lazyclaw/channel-*` npm packages (which 404'd) and marked the channel
  enabled even when its runtime dependency was absent. Now the catalog
  declares each channel's real requirement (an npm package like `discord.js`,
  or the `signal-cli` binary), `channels install <name>` installs the real
  deps into `~/.lazyclaw`, the gateway resolves them from there, a channel is
  enabled only once its requirement is present, and the wizard verifies the
  credentials it just saved (✓/✗).
- **Piped/scripted `lazyclaw setup` no longer hangs.** The non-TTY picker
  fallback read the whole piped buffer at once (skipping the channel and
  starving the next prompt); it now reads exactly one line and hands the rest
  back.
- **`/new` (and `/reset`, `/clear`) actually clear the screen** in the Ink
  REPL, instead of resetting state while leaving the prior conversation on
  screen.
- **The self-learning loop no longer deletes its own fresh skills.** A new
  skill was scored `0.21`, already under its own `0.3` archive floor, so the
  first recall miss removed it; fresh skills now use a neutral prior.
- **`dream()` / `setCore()` memory and removed skills are written through to
  the recall index**, so "durable recall over memory" holds without a manual
  `index rebuild`.
- **`loop --detach --use-memory` honours memory and uses the real auth key**
  (the worker dropped the flags and sent an empty key).
- **MCP tool failures (`isError`) surface as failures**, not silent success.

### Added

- **Setup wizard channel step is now a picker.** The first-run wizard's
  "where will you run it?" step no longer makes you type the channel name —
  pick it from an arrow-key list (type to filter), set its credentials inline
  (secrets masked), and loop to add several channels in one pass (exit via the
  "Done" row or Esc).
- **The rest of the wizard is pickable too.** "Test the provider now?",
  "Initialise a workspace?", "Install a skill bundle?", "Add a webhook?" and
  "Enable orchestration?" are now arrow-key Yes/Skip picks, and the context
  window is a preset pick (keep / small / default / large / custom) — no more
  typing `y`/`n` or raw numbers.

### Fixed

- **Wizard no longer pushes the screen down each step.** The arrow-key picker
  cleared the main screen buffer on every redraw, which interleaved with prior
  steps' output and pushed a screenful into scrollback per step (a growing
  gap). It now renders on the alternate screen buffer (like vim/less/fzf) and
  restores the main buffer on exit, pushing nothing.
- **One model picker everywhere.** Bare `/trainer` opens an action menu
  (Set / Fallback / Clear / Show, like bare `/orchestrator`); `/trainer set|fallback`
  and the new `/agent edit <name>` open the same provider→model picker as `/model`
  (family drill-in, live-fetch, a `… type a custom model id` row, and — for
  the trainer — an `auto` and a `provider default` row), instead of requiring
  a hand-typed `provider:model` spec. `/orchestrator` planner/worker and the
  `/provider`→model chain share that one picker too; the parallel
  `pickModelForProvider` implementation was removed.
- **Guided `/personality install`** prompts for the name + source file (with
  retry on a bad path) instead of erroring on missing args.
- **`/orchestrator planner` / `worker add|remove` with no spec** open the
  provider→model picker; **`/trainer set`** via the picker now offers an
  optional fallback pick.
- **`lazyclaw setup --only <steps>` / `--skip <steps>`** to re-run or bypass
  individual wizard steps (provider/verify/channel/workspace/skill/webhook/
  orchestrator).
- **Chat key preflight** — starting chat with a key-requiring provider but no
  key warns up front (with the fix) instead of failing the first turn opaquely.
- **Guided creation.** `/agent add`, `/goal add`, `/task start`, `/team add`
  now walk you through it when you don't pass the args — prompt for the name,
  pick the team/agents from the registry, choose a cron preset — instead of
  printing a usage string. Typed forms still work.
- **Verify channel credentials.** `lazyclaw channels test <name>` and
  `/channels <name> test` do a live check (Slack/Telegram/Matrix) and report
  ✓ verified or ✗ rejected with the fix, so a bad token is caught at setup
  rather than at first message. `/channels` list also flags a channel whose
  required credentials are missing.
- **`/menu` runs commands in chat** when a slash equivalent exists (was always
  "run it from a shell").
- **No-arg action menus.** Bare `/agent` `/team` `/task` `/goal` `/channels`
  `/context` `/memory` now open a pick-an-action menu (like bare `/trainer`)
  instead of printing status or a "run it from the shell" dead-end. `/channels`
  toggles a channel in place or jumps to credential setup; `/context` drills a
  numeric picker. `/skill` with no argument no longer silently wipes active
  skills — it opens the skill picker; clearing now needs explicit `/skill clear`.
- **Readable `show` output.** `/agent show`, `/team show`, `/goal show`,
  `/task show`, and `/trainer`'s configured block print `key: value` lines
  instead of a raw JSON dump; append `json` (e.g. `/agent show x json`) for the
  machine form.
- **Inline slash-argument autocomplete for every arg-taking command.** Typing
  a value after a command now shows candidates in the popup (like the
  `/command` popup): `/login` → `codex-cli`/`gemini-cli`, `/hud` → `on`/`off`,
  `/memory`, `/channels` (names + `on`/`off`), `/handoff` (channel), `/dashboard`
  (`stop`/`kill`), `/skill`, `/provider`, and subcommand menus for `/task`
  `/team` `/goal` (incl. existing goal names) `/context` `/agent` `/personality`
  `/trainer` `/orchestrator` (plus dynamic agent/skill/personality name lists).
  ↑/↓ select, Enter fills. (`/config` opens its own setting picker on Enter.) The 2-step provider→model picks
  (`/model`, `/trainer set`, `/orchestrator planner`) show a `↹ pick` hint and
  open the drill-in modal on **Tab**. Typed forms still work.
- **`NO_COLOR` / dumb-terminal respect.** A central color gate (`NO_COLOR`
  env per no-color.org, `TERM=dumb`, or non-TTY) disables color, and the
  legacy pickers/setup-wizard route their ANSI through it instead of emitting
  raw escapes. The setup wizard's `Ctrl+C` now cancels the step instead of
  hard-killing the process.
- **Provider-adaptive splash tip** — the "$0 on your Claude subscription" tip
  shows only for `claude-cli`; other providers get a neutral `/help` tip.
- **`/new` clears the screen** — the scrollback is wiped, not just the
  in-memory history, so a fresh conversation actually looks fresh.
- **Ink REPL input UX.** Up/Down recalls this session's prompts; mid-line
  editing (Left/Right, Home/End or Ctrl+A/E, Ctrl+K kill-to-end, Ctrl+W
  delete-word, cursor-position backspace); bracketed paste; two-stage Ctrl+C
  (first cancels/clears, second exits); an aborted (Esc) turn prints a dim
  `[aborted]` marker; provider errors render in the red error style. API keys
  typed in the picker are masked on screen (the real value still submits).
- **Context gauge shows a percentage + bar** with a warning threshold, not
  just raw token counts.
- **Agentic chat REPL + plan mode.** With `/agentic on` (or `cfg.chat.agentic`)
  the interactive chat turn runs the tool loop — reads, greps, and (with
  approval) edits/runs — instead of being text-only; tool activity and the
  final answer render inline. Sensitive tools still pass the existing
  fail-closed approval gate; agentic mode is OFF by default. `/plan on` adds a
  read-only mode (read-only tools + "propose, don't act"). Chat tool whitelist
  is `cfg.chat.tools` (default `read`/`grep`/`skill_view`; `bash`/`write`
  opt-in).
- **MCP server boot.** `cfg.mcp.servers` are now started at daemon boot
  (best-effort, stopped on shutdown) and their tools register as
  `mcp:<server>:<tool>`. MCP tools are forced `sensitive` (approval-gated)
  regardless of config. `lazyclaw mcp list` shows configured servers.
- **Configured sandbox now contains agent shell commands.** The `bash` tool
  runs inside the configured sandbox (`spawnSandboxed`) when a sandbox spec is
  threaded through; the no-sandbox path is unchanged.
- **Plugin channels are reachable.** The gateway now loads enabled non-builtin
  channels (discord/email/signal/voice/whatsapp) via the plugin contract,
  skipping non-conforming plugins with a warning instead of ignoring them.
- **`lazyclaw daemon status | stop | logs` + a pidfile.** The bare daemon now
  records `~/.lazyclaw/daemon.pid` (pid + bound port) on start and removes it
  on shutdown; `status` reports `{running,pid,port}` and self-heals stale
  pidfiles, `stop` SIGTERMs (SIGKILL fallback), `logs` points at the logfile.
  `service status` on launchd now reports `running`+pid like systemd/fallback.
- **`lazyclaw index rebuild`.** The FTS5-recovery command the code and doctor
  already pointed operators at now exists — repopulates the index from the
  corpus (`reindexAll`), not the destructive wipe.
- **Configurable max output tokens** via top-level `maxTokens` in
  `config.json` (was hard-capped at 4096 with no surface).
- **Provider idle timeout.** Every HTTP provider now aborts a stalled stream
  after an inter-chunk idle window (default 120s, `LAZYCLAW_REQUEST_TIMEOUT_MS`)
  instead of freezing the turn forever; healthy long streams are unaffected.
- **Bundled starter skill pack + `lazyclaw skills starter`.** Eight curated
  skills now ship with the package under `skills/` (`concise`, `korean`,
  `commit-message`, `code-review`, `channel-style`, `summarize`, `explain`,
  `debug-coach`). `lazyclaw skills starter` copies them into
  `~/.lazyclaw/skills/` — existing names are skipped so user edits survive
  re-runs; `--force` overwrites. The `/skills` empty state now points at the
  starter pack, and `lazyclaw skills install <user>/lazyclaw` resolves the
  same bundle from GitHub via the existing `skills/`-dir heuristic.
- **Orchestrator planner/workers are now fetch+pick, not typed specs.**
  `/orchestrator` (no arg) gains *Set planner…*, *Add worker…*, *Remove worker…*,
  and *Max subtasks…* — each opens the arrow-key picker: choose a provider, then
  its model (with live "fetch model list" + "provider default"), and the
  `provider:model` spec is assembled for you. Typed subcommands still work.
- **`/provider` now chains straight into a model pick.** After choosing a
  provider from the picker it immediately offers that provider's model list, so
  provider + model are set in one flow instead of `/provider` then `/model`.
- **claude-hud-style status bar.** With the HUD enabled (default on), a second
  status row under the chat input shows real-time usage (`↑in ↓out tok`), session
  cost (when a rate card or provider-reported cost is available), the trainer
  model, and the orchestrator shape (`planner +Nw`) — alongside the existing
  provider · model · ctx row. Toggle it from `/config → HUD status bar` or the
  `/hud on|off` slash (persists to `cfg.chat.hud`).
- **Inline connect / login for the keyless CLI providers.** Picking `codex-cli`
  or `gemini-cli` in `/provider` (or the new `/login [provider]`) now detects
  whether the CLI is installed and signed in, and — when it isn't — offers an
  in-chat menu instead of dead-ending on the CLI's own "please log in" message:
  **▶ log in via browser** (`codex login`, or Google sign-in by launching
  `gemini`), **paste an API key** (`codex login --with-api-key`; `GEMINI_API_KEY`
  for gemini, now forwarded to the subprocess), or **install the CLI**
  (`npm i -g @openai/codex` / `@google/gemini-cli`). The browser / install
  actions suspend the TUI, run in the real terminal, then drop back into chat on
  the chosen provider. Already-signed-in providers are switched to silently.

### Fixed

- **Set channel credentials from `/channels`.** `/channels [<name>] setup` now
  collects the bot token / homeserver / etc. in-chat (masked modal) and saves
  them — previously toggling was all `/channels` did and setting creds forced a
  detour out to `/config`.
- **Secret entry is masked in the setup wizard.** API keys (`lazyclaw onboard`/
  `setup`) and channel tokens (`runChannelStep`) were read with plain readline
  and echoed in plaintext to the terminal/scrollback; they now read in raw mode
  and echo bullets. (Security.)
- **Slash help text corrected** to match the handlers (`/team`, `/agent`,
  `/handoff`, `/loop`, and the README `/config` row no longer advertise
  verbs/args that don't exist).
- **Destructive removes ask first.** `/agent remove`, `/team remove`,
  `/task remove`, and `/personality remove` now confirm in chat before deleting
  (the non-interactive CLI still deletes directly). `/channels off` and
  `/goal close` print how to reverse them.
- **Chat errors suggest a fix.** A failed turn (bad/missing key, unknown model,
  network) now shows a one-line hint under the error instead of just the raw
  message.
- **`/model` and `/provider` picks now persist across restarts.** The active
  model/provider were held in memory only, so a model chosen via `/model`
  reverted to the on-disk `cfg.model` on the next launch (only the
  `/provider`→model chain saved before). Both setters now read-merge-write
  `config.json`; orchestrator routing is left to `/orchestrator on|off`.
- **Stale default models bumped.** `claude-cli` and `anthropic` `defaultModel`
  were `claude-opus-4-7` (previous gen) and the streaming/tool_use fallbacks
  disagreed with the registry; all now resolve to `claude-opus-4-8` /
  `gemini-2.5-pro`, so empty-model agents and `providers test` hit a current
  model. (Fallbacks only fire when no model is passed.) `claude-fable-5` was
  also removed from the suggested lists (API-priced, not on the claude-cli
  subscription tier) — `claude-opus-4-8` is now the first suggestion; it can
  still be entered as a custom id.
- **`config validate` recognizes first-class keys.** `trainer`, `orchestrator`,
  `persona`, `customProviders` and `chat` are no longer reported as
  "unknown top-level key".
- **Interactive chat now retries transient provider errors.** The retry
  wrapper covers 5xx / overloaded (Anthropic 529) before the first chunk (was
  RATE_LIMIT-only), and the chat hot path wraps its provider with it (and
  re-wraps after a `/provider` or `/model` switch) — a transient 429/529 no
  longer just prints `error: …`. Mid-stream errors are still never retried.
- **A corrupt `config.json` fails loudly instead of silently resetting.**
  `readConfig` distinguished missing (fresh, returns `{}`) from present-but-
  unparseable; the latter now prints an actionable error and throws a
  `ConfigError` (caught at the CLI boot boundary) instead of returning `{}` —
  so a typo no longer drops every setting or lets a later write clobber the file.
- **Unknown subcommands suggest the nearest match** (`did you mean "sessions"?`)
  and `lazyclaw help <name>` prints that command's usage instead of erroring.
- **Learning loop: two dead triggers wired.** `periodic-curation` was a
  `{stub:true}` no-op — it now runs the real `skills_curator` (archives
  agent-authored skills idle >90d). `post-failure` had zero callers — a
  non-DONE team-task stop (budget/idle/failed) now fires it (writes a failure
  trajectory). *(Confidence accumulation and the active-recall-miss detector
  remain deferred — they need a skill-success signal design.)*
- **Agent-authored skills/memories were invisible to recall.** `skill_create`,
  `skill_edit`, and `memory_write` now write through to the FTS5 index (were
  only findable after a full `reindexAll`); `index_db.deleteSkill` is a real
  op; the recall `since` filter no longer drops hits that lack a timestamp;
  recall snippets no longer carry `<mark>` HTML into the model prompt.
- **`claude-cli` silently ignored its own top-suggested models.** The picker
  leads with `claude-fable-5` / `claude-opus-4-8`, but the alias table stopped
  at `4-7`, so `resolveModelAlias` returned `''` for those ids and the CLI fell
  back to its default model. Added the current canonical ids (and a `fable`
  tier alias) so the picked model is honored.
- **OpenAI reasoning models (`o1`/`o3`/`o4…`) returned HTTP 400.** The provider
  always sent `max_tokens`; o-series ids now send `max_completion_tokens`
  instead (native `openai` + tool-use path; OpenAI-compat vendors unchanged).
- **`task_spawn` / `delegate` agent tools always failed.** `task_spawn` now
  resolves the agent name to a record before calling `runAgentTurn` (was
  passing a string → `PROVIDER_UNSUPPORTED`); `delegate` now has a real
  `orchestrator.dispatchWorker` (one-shot worker provider call) instead of an
  "unavailable" stub.
- **Multi-agent tasks that stopped on budget/abort/idle were stranded as
  "running" forever.** A non-DONE terminal exit now patches the task to a
  terminal status and posts a stop note to the thread (was silent).
- **Workflow detail in the dashboard never showed node results** (read the
  wrong field `nodeResults` instead of `nodes`); the node status pill and the
  "Done" count read non-existent fields (`'done'` status / boolean `sm.done`)
  and now use the canonical `'success'` / `sm.success`. Removed the dead
  per-session "Trajectory" link (404, route deferred) and the false "index
  will be deleted and recreated empty" reindex warning (it repopulates).
- **Not-implemented stub tools** (`tts_speak`, `sql_query`, `ha_call_service`,
  `ha_get_state`) are hidden from the tool schemas shown to the model (flagged
  `unavailable`, still registered) so agents stop wasting calls on them.
- **The dashboard works against an `--auth-token` daemon.** The static shell
  (HTML/CSS/JS, no secrets) loads without a token; every API call now routes
  through a single auth-aware fetch that attaches `Authorization: Bearer` from
  localStorage and prompts once on 401. Data/mutation routes stay gated; a
  path-traversal guard keeps the static bypass from reaching them.
- **Web dashboard rendered unstyled with every tab stuck on "Loading…".** The
  HTML referenced its CSS/JS by relative path (`href="dashboard.css"`), but the
  daemon serves the page at `/dashboard` **and** `/dashboard/`; under the
  trailing-slash URL the browser resolved the assets to `/dashboard/dashboard.css`
  → 404, so neither the stylesheet (page unstyled, all panels stacked) nor the
  script (no tab populated) loaded. Asset refs are now absolute (`/dashboard.css`,
  `/dashboard.js`) and the daemon also serves the page at the trailing-slash URL.
- **`/model` "fetch live" failed for a logged-in `codex-cli` / `gemini-cli`**
  ("fetch failed: codex-cli model listing needs a credential: set OPENAI_API_KEY").
  A ChatGPT-plan / Google-account login has no platform API key to list
  `/v1/models`, so the fetch now falls back to the model the local CLI config is
  set to use (`~/.codex/config.toml`, `~/.gemini/settings.json`) instead of
  erroring — the picker shows the account's real model.
- **Status-bar context gauge was misleading on CLI providers** (e.g. `ctx
  49467/8000` after a single message). It plotted the provider's *self-reported*
  cumulative usage against lazyclaw's chat-history budget — two unrelated axes.
  CLI providers (codex/claude/gemini) ship their own system prompt + tool defs
  on every call, so their reported input is tens of thousands of tokens and has
  nothing to do with how much conversation lazyclaw holds. The gauge now tracks
  the estimated size of the chat history lazyclaw actually sends, so a fresh
  conversation reads near 0 and grows toward the budget.
- **`codex-cli` / `gemini-cli` would not connect** because the providers forced
  their hardcoded default model via `-m`. A ChatGPT-account `codex` login only
  accepts the models that plan is entitled to (read from `~/.codex/config.toml`),
  so `-m gpt-5-codex` was rejected with HTTP 400 "The 'gpt-5-codex' model is not
  supported when using Codex with a ChatGPT account." and the turn exited 1. The
  keyless CLI providers now pass **no `-m` by default** (`defaultModel: null`) and
  let the CLI's own login pick an account-appropriate model; pass a model only
  when your plan allows it.
- **The real failure reason was swallowed.** `codex` reports API/turn errors on
  STDOUT as `{"type":"error"}` / `{"type":"turn.failed"}` events (stderr only said
  "Reading additional input from stdin…"), and `gemini --output-format json`
  carries an `error` object even on a clean exit. Both providers now surface that
  message instead of an empty reply.

### Changed

- The interactive model picker now offers **"▷ Use the provider's own default
  model"** (no `-m` override), pre-selected for providers without a forced
  default — the reliable onboarding path for `codex-cli` / `gemini-cli`.

## [6.3.1] - 2026-06-10

### Fixed

- **Chat crashed at boot on the legacy readline path** (`ReferenceError:
  SLASH_COMMANDS is not defined` in the ghost-autocomplete) — a missing
  import that only fired on a real TTY, so tests/CI never caught it. Any
  terminal where the Ink UI was unavailable (narrow window, node incompat)
  hit it immediately.
- **Retired the v4 figlet banner.** The legacy path now shows the same v5
  sloth splash as the Ink UI, and the ink→legacy fallback prints the reason
  in one dim line instead of silently downgrading.

## [6.3.0] - 2026-06-10

### Added

- **`/setup` vs `/config` split.** `/setup` is the first-run / full re-setup
  command (every wizard step — what `/config` used to do). `/config` is now a
  settings editor: pick ONE item — provider, model, context window, trainer,
  orchestrator (handled in-chat), or channel credentials / outbound webhook
  (leaves chat for the secret prompts, runs just that step, and returns to
  chat) — so changing e.g. a webhook URL no longer means re-walking the
  whole wizard. The legacy readline path routes both to the full wizard.
- **Always-visible caret in the input box.** An inverse-video cell marks the
  typing position at all times — including an empty box before anything is
  typed — and the terminal-cursor IME anchor now re-applies after every
  render, so streaming output or status-bar updates can no longer leave the
  box apparently cursor-less while idle.

## [6.2.0] - 2026-06-10

### Added

- **Live model lists for the keyless CLI providers.** `claude-cli`,
  `gemini-cli`, and `codex-cli` can now populate the model picker by
  borrowing the credential their vendor accepts: an anthropic key or a
  Claude Code OAuth token (`CLAUDE_CODE_OAUTH_TOKEN` / the Linux credential
  store) for claude-cli; `GEMINI_API_KEY`/`GOOGLE_API_KEY` for gemini-cli;
  an OpenAI key (env / profile / a plain key in `~/.codex/auth.json`) for
  codex-cli. When no credential is available the picker shows an honest,
  actionable message and falls back to the curated list.
- **Live model lists for anthropic and gemini.** The model picker (setup
  wizard + `/model`) can now pull the up-to-date catalogue from the
  provider's native list endpoint — Anthropic `GET /v1/models`, Gemini
  `GET /v1beta/models` (chat-capable entries only) — exactly like
  openai/ollama/OpenAI-compat vendors already could, so newly released
  models (e.g. `claude-fable-5`) appear the day they ship.

- **`gemini-cli` and `codex-cli` are now selectable providers.** Both keyless
  CLI adapters were fully implemented but never registered, so they were
  invisible in `/provider` and the setup wizard. The CLI/Local family now
  offers claude-cli, gemini-cli (local `gemini` login), codex-cli (local
  `codex` / ChatGPT plan), and ollama.
- **The orchestrator is pickable again.** It was excluded from the provider
  picker entirely; it now appears in its own "Multi-agent" family — visible
  and selectable, but still never a wizard default. (`/orchestrator on|off`
  keeps working as before.)

### Changed

- **Refreshed curated model lists.** `claude-cli` and `anthropic` suggest
  the current Claude lineup (`claude-fable-5`, `claude-opus-4-8`,
  `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`,
  `claude-haiku-4-5`); retired models (`claude-3-5-*`, `gemini-1.5-*`)
  no longer appear as suggestions. (claude-cli's curated list is the
  offline fallback; the live list needs a credential — see Added.)

### Fixed

- **`providers test` crashed on boxes without the `gemini`/`codex` CLIs.**
  A missing binary surfaces as an async ChildProcess `error` event; the
  gemini-cli/codex-cli adapters only caught the sync throw, so the
  unlistened event killed the whole process mid-probe. They now surface a
  per-provider `CLI_MISSING` error exactly like claude-cli.

## [6.1.0] - 2026-06-10

### Added

- **`lazyclaw gateway` — the single-process always-on agent.** One process
  runs the daemon core AND the configured channel transports (Slack Socket
  Mode / Telegram long-poll / Matrix sync); every inbound goes through the
  session-bearing `POST /inbound`, and each channel registers a live sender
  so `POST /handoff` finally notifies the target channel with a resume marker
  (a failed notify rolls the binding back). `lazyclaw service install gateway`
  keeps it alive across reboots.
- **Always-on service install.** `lazyclaw service <install|uninstall|status|
  restart> [daemon|gateway]` wraps the surface as a launchd plist
  (RunAtLoad+KeepAlive), a systemd user unit (Restart=always), or a detached
  pidfile fallback; backend auto-detected, override with `--backend`.
- **Channel listeners now bridge through the daemon (single agent).**
  `slack|telegram|matrix listen` POST every inbound to the daemon's
  `POST /inbound` instead of calling the provider inline, so chat, the
  dashboard, and every channel share one on-disk session/memory store and
  cross-channel handoff works. Slack now forwards the sender id, so the
  pairing allowlist gates all three channels symmetrically.
- **Inbound idempotency.** Channels thread their native message id (Slack
  `channel:ts`, Telegram `chat:message_id`, Matrix `event_id`); the daemon
  dedups on it — a redelivery replays the recorded reply (no second provider
  call, no duplicate session turns) and the store survives a restart.
- **Channel turns feed the learning loop.** Session-bound `/inbound` turns
  fire the same fire-and-forget post-task learning hook as the chat REPL
  (trainer `auto` → claude-cli, $0).
- **Fail-closed always-on guards.** A channel listener, the daemon/dashboard,
  or the gateway refuses to boot while `security.allowUnattendedSensitive=true`
  (that flag bypasses the sensitive-tool approval gate for every inbound
  message — RCE with an always-on surface), and long-running processes now
  install crash handlers (structured log + socket drain + non-zero exit so a
  service manager restarts them).
- **Gateway hardening (adversarial-review pass).** The gateway authenticates
  by default (token minted + persisted 0600 to `~/.lazyclaw/gateway.token`;
  `--no-auth` opts out); dedup keys are conversation-scoped (a colliding or
  forged messageId can't replay another conversation's reply/sessionId);
  Telegram edits are processed instead of replaying the stale answer
  (update_id-keyed dedup); listeners stay silent on duplicate redeliveries;
  the /inbound learning hook is serialised + depth-capped; Slack Socket Mode
  reconnect survives failed renegotiation and crashes loudly on permanent
  death instead of going silently deaf; Telegram shutdown aborts the held-open
  long-poll; handoff resume markers no longer leak session ids and sanitize
  the note.
- **Adjust the chat context window.** `/context` slash (`status | turns <N> |
  tokens <N>`) and a setup prompt right after the model pick set
  `cfg.chat.window{Turns,Tokens}` — the sliding history budget sent each turn
  (not the model's hard limit). Backed by shared
  `config_features.{chatWindowGet,chatWindowSet}`; default 20 turns / 8000 tokens.
- **`lazyclaw orchestrator on|off`** (CLI parity with the `/orchestrator on|off`
  slash) routes `cfg.provider` to/from `orchestrator`, restoring the previous
  provider on `off`.

- **Turn on multi-agent orchestration from setup or chat.** The setup wizard
  has an optional final step to enable orchestration (pick a planner + workers);
  a new `/orchestrator` slash views/edits it (`status | on | off | planner
  <spec> | worker add|remove <spec> | maxsubtasks <N>`). Both reuse shared
  `config_features.{orchestratorGet,orchestratorSet,orchestratorEnable}` so the
  setup wizard, the slash, and `lazyclaw orchestrator` agree.

- **Setup collects the Slack app-level token for inbound.** The channel step now
  asks for `SLACK_APP_TOKEN` (xapp-…, Socket Mode) in addition to the bot token,
  so `lazyclaw slack listen` (receiving messages) is configurable from the
  wizard, not just outbound.

- **View and edit channel settings: `/channels` slash + `lazyclaw channels`.**
  The CLI `lazyclaw channels` now lists configured built-in channels
  (`cfg.channels.<name>` — enabled/disabled, bound agent) alongside installed
  plugins, instead of only ever printing "no channel plugins installed";
  `lazyclaw channels enable|disable <name>` toggles one. In chat, `/channels`
  lists them and `/channels <name> on|off` toggles. A new shared
  `config_features.{KNOWN_CHANNELS,channelStatusList,channelSetEnabled}` is the
  single source the daemon `/channels` route, the CLI, and the slash all read,
  so the three views can't drift. Unknown channel names are rejected (no config
  pollution).

- **`/config` slash command.** Typing `/config` in the chat REPL leaves the
  conversation and re-runs the setup wizard (provider, model, channels). Ink
  owns stdin, so the slash signals the host (`ctx.requestSetup`) and unmounts;
  the wizard then runs once the REPL exits. Wired into both the Ink path and the
  legacy readline path (via a shared `legacySlashRoute` seam).

- **Hermes-style first-run setup.** `lazyclaw setup` (and the first-run path)
  is now phased: pick a provider + model (with a ≥64k-context tip), verify one
  clean chat, then optionally connect a channel/gateway — Slack, Telegram,
  Matrix, or HTTP built in, plus Discord, Email, Signal, Voice, and WhatsApp via
  plugin packages (the wizard prints the install command and never pretends an
  uninstalled channel is ready). Channel credentials are written to
  `<configDir>/.env` at 0600 (tokens masked on screen); `cfg.channels.<name>`
  records which channels are enabled for the daemon and dashboard to read.

### Fixed

- **Slash commands with arguments now run with their args (e.g. /orchestrator off).** The slash popup stayed open as a one-row hint while you typed args, and the editor treated Enter as fill-the-matched-command — so it dropped the args and reverted the buffer to the bare command. The interactive popup is now hidden once the buffer has a space, so Enter submits the full line; this affected every slash command that takes an argument.
- **Backspacing no longer eats the output above the input box.** The cursor
  anchor could move the terminal cursor up several times between redraws (fast
  typing / backspace); the eraseLines shim only compensated for the last move,
  so log-update walked up into and erased the scrollback above the editor (only
  visible in the default Static layout, not the fixed alt-buffer canvas). The
  anchor now undoes any not-yet-consumed offset before re-anchoring, so it
  always re-bases from below the frame.
- **The input cursor is now visible at the caret, and CJK/Hangul IME pre-edit
  stays inside the box, in the default REPL layout.** The terminal-cursor anchor
  (which parks the cursor at the typing position so you can see it and so an IME
  draws its composing text there) only ran in the opt-in alt-buffer layout; in
  the default non-alt layout the cursor parked below the box, so you couldn't
  tell where you were typing and a half-composed Hangul syllable (e.g. "하"
  while typing "한") leaked onto the row below. The anchor now runs in both
  layouts (the editor is the last element either way, so the geometry math is
  identical). Opt out with `LAZYCLAW_NO_CURSOR_ANCHOR=1`.

- **The status bar's `ctx N/M` now reflects the configured context window.** The
  total `M` was hardcoded to the 8000 default; it now reads
  `cfg.chat.windowTokens`.

- **Long streaming replies no longer spill below the chat input box.** In the
  REPL's non-alt (Static) layout the whole reply was held in a growing live
  region; once it was taller than the terminal it overflowed past the sticky
  editor. `onStreamChunk` now commits completed lines to the `<Static>`
  scrollback as they stream (so they scroll up above the editor) and keeps only
  the in-progress partial line live — the editor stays pinned at the bottom.
  Newline-free chunks still accumulate, so short replies are unchanged.

- **Slack inbound (Socket Mode) no longer requires `SLACK_SIGNING_SECRET`.**
  `lazyclaw slack listen` demanded the signing secret, but Socket Mode
  authenticates the WebSocket with the app-level token — the signing secret is
  only for the (unused) HTTP Events API. Requiring it blocked socket-mode setups
  that only had the bot + app tokens; it is now optional.

- **The setup wizard no longer exits after the verify step.** Step 2 ran the
  provider ping via `lazyclaw providers test`, which calls `process.exit` — fine
  when the ping was the last step, but after the phased reorder moved it to Step
  2 that exit killed the rest of the wizard (channels/workspace/skills never
  ran). The verify step now uses a shared no-exit `providers/probe.mjs` and
  prints one concise line (`✓ <reply> · <model> · <ms>`) instead of dumping the
  full JSON, so it no longer scrolls the splash away or quits mid-wizard.

- **Assistant replies no longer vanish in the interactive chat REPL.** The Ink
  REPL was wired with the legacy `runTurn` prop, whose writeFn wrote streamed
  chunks straight to `process.stdout`. Those bytes landed in Ink's live frame
  and were erased on the next render (status refresh, next keystroke), so each
  assistant reply flashed and disappeared while the user's own lines — `<Static>`
  scrollback items — survived. The chat path now goes through `runTurnFactory`,
  so chunks flow into React state and commit to the `<Static>` scrollback on
  turn-complete (the long-standing v5.1 TODO); replies persist across re-renders.
- **Dashboard renders styled when served from a subpath or opened directly.**
  `dashboard.html` referenced its split-out assets with absolute paths
  (`/dashboard.css`, `/dashboard.js`), so any context where the page is not at
  the host root — a reverse-proxy subpath, or opening `web/dashboard.html` as a
  local file — 404'd both, leaving a completely unstyled page with every tab
  section stacked and no JS. The references are now relative (`dashboard.css`,
  `dashboard.js`), which resolves correctly from the daemon root, a subpath, and
  `file://`.
- **The first run always reaches setup — a `mock`/blank provider no longer counts
  as configured.** First-run routing keyed on `!!cfg.provider`, so a config left
  on the placeholder `mock` provider (canned replies, never a real choice)
  registered as "configured" and dropped straight into chat, skipping the guided
  setup. `hasConfiguredProvider()` now treats blank and `mock` as not-configured,
  so the first real launch lands in setup and only a genuine saved provider skips
  it on later runs.

### Changed

- **Bare  opens an arrow-key picker** (Turn ON / Turn OFF /
  Status) so toggling orchestration is point-and-pick, not typed; the legacy
  no-picker path still prints status text. ( and
   continue to work directly.)
- **The setup wizard accent is the terminal amber.** The wizard's step
  headers/prompts were printed in orange (xterm-256 #208); they now use the same
  amber-gold (`#d9b35a`, 24-bit) as the dashboard accent.
- **The setup wizard now shows the full lazyclaw splash.** `lazyclaw setup` (and
  the first-run welcome) rendered a small figlet banner; they now render the same
  sloth + wordmark + subcommands splash the chat REPL shows. The dynamic props
  (tool + skill groups) are gathered by a shared `tui/splash_props.mjs` so the two
  surfaces can't drift.
- **Dashboard: dropped the header mascot and recolored the accent to a terminal
  amber.** Removed the pixel mascot SVG (and its CSS) from the header, leaving
  the `lazyclaw` wordmark. The accent moved from coral `#d97757` to amber-gold
  `#d9b35a`; primary buttons now use dark text (`--accent-ink`) for AA contrast
  on the lighter accent. Verified across the mobile / small-window / desktop
  viewports.

## [6.0.1] - 2026-06-08

### Fixed

- **The published package now actually installs and runs.** 6.0.0 shipped a
  `package.json` `files` whitelist that predated the Phase D refactor, so the
  npm tarball was missing `lib/`, `commands/`, `daemon/`, and several root
  modules (`first_run.mjs`, `dotenv_min.mjs`, `goals_cron.mjs`,
  `secure_write.mjs`) — a global install crashed immediately with
  `ERR_MODULE_NOT_FOUND: …/lib/config.mjs imported from …/cli.mjs`. The repo
  tests never caught it because they run from the source tree where every file
  exists. Added the missing paths (plus the `channels-*` platform dirs) and a
  new `scripts/check-pack.mjs` gate (wired into CI) that resolves every
  relative import in the would-be-published file set and fails if any target
  isn't shipped, so a published-but-broken release can't happen again.

## [6.0.0] - 2026-06-08

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

- **Cross-channel handoff actually carries context now (daemon relay path).**
  The "context follows" marquee feature was dead: `channels/threads.mjs` (the
  threadId ↔ session store) had zero production callers, and `POST /inbound`
  was a stateless one-shot relay. Now, when a relaying bot includes `channel`
  + `externalId`, `POST /inbound` binds them to a persistent thread/session,
  hydrates prior turns, and persists each turn — so a conversation survives
  across messages. A new `POST /handoff` re-points a thread to another channel
  (preserving the session); the next inbound on the target resumes the SAME
  session, so context follows across the channel boundary. A rollback helper
  restores the source binding if a target notification fails. (Inbound with no
  `channel`/`externalId` stays byte-compatibly stateless. The CLI `/handoff`
  slash and per-channel listener auto-binding remain separate follow-ups; this
  wires the daemon relay path that external bots use.)
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
- **The mention router reuses a single Slack client per task run.** Each thread
  post and "thinking…" placeholder used to construct, start, and stop its own
  `SlackChannel` — a fresh auth handshake on every one of the ~3-4 posts per
  agent turn. `runTaskTurn` now opens one client for the whole run, threads it
  through every post, and closes it once; a long-lived caller can pass its own
  client (via `slackSender`) to reuse across runs, in which case the router
  leaves the caller to manage its lifecycle.
- **The chat REPL surfaces the actual error instead of a bare `[error]`.** When
  a turn failed, the Ink REPL appended only ` [error]` to the transcript,
  hiding the cause (rate limit, auth, network, …). It now renders
  ` [error: <message>]` with the thrown message, falling back to the bare
  badge only when no message is available.
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
