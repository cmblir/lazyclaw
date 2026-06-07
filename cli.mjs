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

// --- Phase G: personality subcommand (spec §9, decision C7) -------------

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
async function cmdOnboard(flags) {
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
      const noKeyHint = '\x1b[38;5;208mclaude-cli\x1b[0m (subscription, no key) is the default';
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
      flags['api-key'] = (await ask(`api-key${prefix}: `)).trim();
    }
    rl.close();
  }
  const next = applyOnboardConfig(readConfig(), flags);
  if (!next.provider) { console.error('onboard: provider is required'); process.exit(2); }
  writeConfig(next);
  console.log(JSON.stringify({ ok: true, written: configPath(), provider: next.provider, model: next.model || null, hasApiKey: !!next['api-key'] }));
}





// One-line summaries used by `lazyclaw help`. Format keeps it scan-friendly
// in a 80-column terminal: subcommand padded to 12 chars, then the summary.
const HELP_SUMMARIES = {
  run:        'Execute a workflow file (run <session-id> <workflow.mjs>)',
  resume:     'Resume a workflow from its last persisted checkpoint',
  config:     'Manage local config (get|set|list|delete <key>)',
  chat:       'Interactive REPL with the configured provider',
  agent:      'One-shot prompt: streams a single response, exits',
  doctor:     'Print diagnostic JSON; exits non-zero on issues',
  status:     'Print current provider/model/masked key as JSON',
  onboard:    'Guided setup (use --non-interactive for scripts)',
  sessions:   'Persistent chat sessions (list|show|clear|export)',
  skills:     'Markdown skill bundles (list|show|install|remove)',
  providers:  'Inspect / register providers (list|info|test|add|remove|models)',
  daemon:     'Run the local HTTP gateway (--port, --auth-token, --allow-origin)',
  version:    'Print VERSION + node + platform as JSON',
  completion: 'Emit shell completion script (completion <bash|zsh>)',
  export:     'Dump config + skills (+ optional sessions) as a JSON bundle',
  import:     'Apply a JSON bundle from stdin or --from <path>',
  rates:      'Manage cost rate-cards in config (rates list|set <provider/model>|delete|shape)',
  auth:       'Multiple keys per provider (auth list|add|remove|use|rotate <provider>)',
  pairing:    'Sender allowlist for the messaging surface (pairing list|add|remove <id>)',
  nodes:      'Companion device registration (nodes list|register|remove <id>)',
  message:    'Outbound webhook messaging (message list|add|remove|send <name>)',
  workspace:  'AGENTS.md / SOUL.md / TOOLS.md system-prompt convention (workspace list|init|show|remove|path)',
  browse:     'Fetch a URL and emit Markdown on stdout (browse <url> [--max-bytes <N>])',
  cron:       'Schedule recurring agent runs via launchd / crontab (cron list|add|remove|show|sync|run)',
  setup:      'OpenClaw-style multi-step first-run wizard (provider + workspace + skill + webhook + ping)',
  dashboard:  'Launch the lazyclaw-only web UI (lighter than the full lazyclaude dashboard)',
  inspect:    'Print persisted workflow state without executing',
  clear:      'Delete a persisted workflow state file (idempotent)',
  validate:   'Static-check a workflow file: shape, deps, cycles, parallelism',
  graph:      'Emit workflow DAG as Mermaid syntax (paste-ready for docs)',
  orchestrator: 'Multi-agent dispatch — planner decomposes, workers run, planner synthesises',
};

// Detailed usage per subcommand for `lazyclaw help <name>`. Kept as flat
// strings so the help output is identical in every terminal.
const HELP_DETAILS = {
  run: 'Usage: lazyclaw run <session-id> <workflow.mjs> [--parallel | --parallel-persistent] [--concurrency <N>]\n  Default: runPersistent — sequential, persists state, resumable via `lazyclaw resume`.\n  --parallel: runParallel — topological-level DAG, in-memory only, NOT resumable.\n  --parallel-persistent: runPersistentDag — DAG + checkpoint + resume.\n  --concurrency <N>: cap in-flight nodes within a level (DAG modes only). 0/missing → unbounded.\n  Workflow file exports `nodes`; deps: string[] declares dependencies for both DAG modes.',
  resume: 'Usage: lazyclaw resume <session-id> <workflow.mjs> [--parallel-persistent] [--concurrency <N>]\n  Re-enters a previously persisted run; succeeds nodes are skipped.\n  Pass --parallel-persistent to resume a DAG run (must match the original run\'s mode).\n  --concurrency <N>: cap in-flight nodes per level (DAG mode only).',
  inspect: 'Usage: lazyclaw inspect [<session-id>] [--dir <state-dir>] [--status done|resumable|failed|running] [--summary] [--filter <substr>] [--limit <N>] [--node <node-id>] [--slowest <N>] [--critical-path <workflow.mjs>] [--aggregate]\n  With no session-id: list every persisted session in the state dir, sorted by recency.\n  --aggregate (list mode): per-node stats across all sessions (count, success/failed/pending/running, min/max/avg/total duration).\n  --status filters the listing to a single lifecycle bucket.\n  --filter / --limit refine list-mode further (case-insensitive sessionId substring + post-filter cap).\n  --summary trims per-node detail in single-session mode (matches list-mode shape).\n  --node <id>: print just that node\'s state. Exit 0 success/pending/running, 1 failed, 2 no such node.\n  --slowest <N>: top N nodes by durationMs (descending, ties broken by id).\n  --critical-path <workflow.mjs>: longest-weighted-path analysis using each node\'s recorded durationMs (bottleneck finder).\n  With a session-id (no per-node flag): print full state. Exit code: 0=resumable, 1=fully done, 2=no state, 3=terminal failure.',
  clear: 'Usage: lazyclaw clear <session-id> [--dir <state-dir>]\n  Delete the state file for <session-id>. Idempotent — exits 0 whether the file existed or not.\n  Refuses sessionIds that resolve outside <state-dir>. Mirrors DELETE /workflows/<id> on the daemon.',
  validate: 'Usage: lazyclaw validate <workflow.mjs>\n  Static check: load + shape + dep + cycle + parallelism estimate.\n  Exit 0 valid · 1 hard failure (issues populated) · 2 file/import error.',
  graph: 'Usage: lazyclaw graph <workflow.mjs> [--lr] [--state <session-id>] [--dir <state-dir>]\n  Emit the workflow DAG as Mermaid syntax (graph TD by default; --lr for left-right).\n  --state overlays a persisted run\'s status (success ✓ / running ⏳ / failed ✗ / pending) with classDef styling.\n  Output is paste-ready for GitHub markdown / Notion / Obsidian.',
  config: 'Usage: lazyclaw config <get|set|list|delete|path|edit|validate> [key] [value]\n  Local key-value config at $LAZYCLAW_CONFIG_DIR/config.json (default ~/.lazyclaw).\n  `path` prints the file location; `edit` opens it in $EDITOR (or $LAZYCLAW_EDITOR / $VISUAL / vi) and validates JSON on save.\n  `validate` checks the structural integrity of the whole config file (typed values, known providers, rate-card shape).',
  chat: 'Usage: lazyclaw chat [--session <id>] [--skill name1,name2] [--workspace <name>] [--pick] [--sandbox docker:<image>] [--sandbox-network <net>] [--sandbox-mount <m>] [--sandbox-env <e>]\n  --session persists turns to <configDir>/sessions/<id>.jsonl across invocations.\n  --skill composes named skills into a system message at the head of the conversation.\n  --workspace stitches AGENTS.md/SOUL.md/TOOLS.md from <configDir>/workspaces/<name>/ into the system prompt.\n  --pick opens an interactive provider/model picker before the prompt (also auto-fires on first run).\n  --sandbox routes the underlying claude CLI through `docker run --rm -i --network <net> -v cwd:cwd ...` (default --network=none).',
  agent: 'Usage: lazyclaw agent <prompt|-> [--provider X] [--model Y] [--skill list] [--workspace <name>] [--thinking N] [--show-thinking] [--usage] [--cost] [--sandbox docker:<image>]\n  One-shot non-interactive call. Pass "-" as the prompt to read from stdin.\n  --workspace stitches AGENTS.md/SOUL.md/TOOLS.md into the system prompt (combines with --skill).\n  --usage prints normalized {inputTokens, outputTokens, ...} to stderr after the response.\n  --cost adds a cost line on stderr when config.rates has a card for the active provider/model.\n  --sandbox docker:<image> wraps the subprocess provider (claude-cli) in a Docker container; --sandbox-network defaults to none.',
  doctor: 'Usage: lazyclaw doctor\n  Validates configuration and registered providers. Exits 0 only when no issues.',
  status: 'Usage: lazyclaw status\n  Provider, model, and masked API key. Never prints the raw key.',
  onboard: 'Usage: lazyclaw onboard [--non-interactive] [--provider X] [--model Y] [--api-key Z]\n  --model accepts the unified "provider/model" string (e.g. anthropic/claude-opus-4-7).',
  sessions: 'Usage: lazyclaw sessions <list [--filter <substr>] [--limit <N>]|show <id>|clear <id>|export <id> [--format md|json|text]|search <query> [--regex]>\n  list — recent sessions by mtime; --filter caps to ids containing substring (case-insensitive); --limit caps result count.\n  export — render in chosen format (md default for human sharing, json for tooling, text for paste).\n  search — case-insensitive substring (or --regex pattern) match across all session content; returns first excerpt + match count per matching session.',
  skills: 'Usage: lazyclaw skills <list [--filter <substr>] [--limit <N>]|show <name>|install <user/repo[@ref][:path]> [--prefix <p>] [--force] | install <name> [--from <path> | --from-url <https://...>]|remove <name>|search <query> [--regex]>\n  list — installed skills; --filter caps to names containing substring (case-insensitive); --limit caps result count.\n  install <user>/<repo>[@<ref>][:<subpath>] — fetch a GitHub tarball, install every .md under skills/ (or the explicit subpath, or repo root). Default ref is `main`.\n    --prefix prepends a name prefix so a multi-skill repo doesn\'t collide with locally-managed skills. --force overwrites existing names.\n  install <name> --from <path> | --from-url <https://...> — single-file install. --from-url is HTTPS-only with a 1 MiB cap.\n  search — case-insensitive substring (or --regex) match across all skill markdown bodies; returns first excerpt + match count per skill.',
  providers: 'Usage: lazyclaw providers <list [--filter <substr>] [--limit <N>] | info <name> | test <name> [--model X] [--prompt T] | test [--all] [--prompt T] | add <name> --base-url <url> [--api-key <k>] [--default-model <id>] [--no-probe] | remove <name> | models <name> [--filter <substr>]>\n  list   — registered providers (--filter case-insensitive name substring; --limit caps post-filter count).\n  info   — static metadata: requiresApiKey, defaultModel, suggestedModels, endpoint.\n  test   — send a 1-token "ping" through the provider and report ok/error + duration.\n           Useful after configuring an API key to verify it works before relying on it.\n           No name OR --all: tests every registered provider in parallel; exits 0 only when ALL pass.\n  add    — register a custom OpenAI-compatible endpoint (NIM / OpenRouter / Together / Groq / vLLM / LM Studio / …).\n           Probes /v1/models on success unless --no-probe is set; persists to cfg.customProviders[].\n  remove — drop a custom provider entry from cfg.customProviders[].\n  models — fetch + print the live model catalogue from <provider>/v1/models (works for openai / ollama / custom).',
  daemon: 'Usage: lazyclaw daemon [--port <N>] [--once] [--auth-token <token>] [--allow-origin <origin>] [--rate-limit <N>] [--response-cache] [--log <level>] [--shutdown-timeout-ms <N>] [--cost-cap-<currency> <N> ...] [--workflow-state-dir <dir>]\n  Always binds 127.0.0.1. --port 0 picks a random port and prints the URL.\n  --auth-token also reads $LAZYCLAW_AUTH_TOKEN; --allow-origin also reads $LAZYCLAW_ALLOW_ORIGINS.\n  --rate-limit <N> caps each remote IP at N requests / 60 s.\n  --response-cache enables process-scoped memoization; per-request opt-in via body.cache.\n  --log <debug|info|warn|error> emits JSON-line access logs on stderr (also reads $LAZYCLAW_LOG_LEVEL).\n  --shutdown-timeout-ms <N> caps graceful drain on SIGINT/SIGTERM (default 10000). Second signal forces immediate exit.\n  --cost-cap-usd 100 (or any currency code in lowercase) rejects POST /agent + /chat with 402 once cumulative cost reaches the cap.\n  --workflow-state-dir <dir> backs GET /workflows + GET /workflows/<id> (default .workflow-state, also reads $LAZYCLAW_WORKFLOW_STATE_DIR).',
  version: 'Usage: lazyclaw version\n  Aliases: --version, -v.',
  completion: 'Usage: lazyclaw completion <bash|zsh>\n  bash:   eval "$(lazyclaw completion bash)"\n  zsh:    lazyclaw completion zsh > "${fpath[1]}/_lazyclaw"',
  export: 'Usage: lazyclaw export [--include-secrets] [--include-sessions] > bundle.json\n  --include-secrets keeps the raw api-key in the bundle (default redacts it).\n  --include-sessions adds full turn content (default keeps metadata only).',
  import: 'Usage: lazyclaw import [--from <path>] [--overwrite-skills] [--no-overwrite-config] [--import-sessions]\n  Reads JSON from stdin (or --from <path>). Sessions are NEVER overwritten.\n  Redacted api-keys (***REDACTED***) are dropped, never written.',
  rates: 'Usage: lazyclaw rates <list [--filter <substr>] [--limit <N>] | set <provider/model> --input <N> --output <N> [--cache-read <N>] [--cache-create <N>] [--currency USD] | delete <key> | shape | validate | copy <src> <dst> [--force]>\n  Rates are per million tokens. costFromUsage uses cfg.rates to compute the cost block in /usage and body.cost.\n  `list` accepts --filter (case-insensitive key substring) and --limit (post-filter cap), same shape sessions/skills/workflows lists use.\n  `shape` prints the reference template (zero-filled) you can copy into config.\n  `validate` checks the cfg.rates shape: required fields, non-negative numbers, known providers (warn-only).\n  `copy` clones an existing card to a new key (use when a new model launches at the same price as an old one).',
  sandbox: 'Usage: lazyclaw sandbox <list|test|add|use> [args]\n  list             show 6 backends (local, docker, ssh, singularity, modal, daytona)\n  test <kind>      run echo through the backend (or argv-shape check for remote)\n  add <name> --kind <kind> [--image|--host|--user|--workspace|--app|--confiner ...]\n  use <profile>    set the profile as cfg.sandbox.default',
  auth: 'Usage: lazyclaw auth <list <provider> | add <provider> <key> [--label <name>] | remove <provider> <label> | use <provider> <label> | rotate <provider>>\n  Multiple keys per provider for rate-limit rotation. The active label is sent on every chat / agent call.\n  `rotate` advances the cursor to the next label; pair with a 429 hook for auto-failover.',
  pairing: 'Usage: lazyclaw pairing <list | add <id> [--label <name>] | remove <id>>\n  Sender allowlist for the messaging surface. Inbound senders not on this list are rejected.\n  Sender ids are opaque per-channel: Slack member id, Discord user id, phone number for SMS, etc.',
  nodes: 'Usage: lazyclaw nodes <list | register <id> [--platform macos|ios|android|web|cli] [--label <name>] | remove <id>>\n  Companion device registration table. CLI only — the actual mobile / menu-bar apps are out of scope here.\n  Platform is free-form lower-case; future surfaces (iOS / Android nodes) authenticate against the daemon using these ids.',
  message: 'Usage: lazyclaw message <list | add <name> <webhook-url> [--kind slack|discord|generic] | remove <name> | send <name> <text>>\n  Outbound webhook messaging — Slack / Discord Incoming Webhooks. Auto-detects kind from the URL pattern.\n  send accepts a literal string, or `-` to read the body from stdin.',
  workspace: 'Usage: lazyclaw workspace <list | init <name> | show <name> [<file>] | remove <name> | path <name>>\n  Workspace = a directory under <configDir>/workspaces/<name>/ containing AGENTS.md, SOUL.md, TOOLS.md.\n  When `chat` or `agent` is invoked with --workspace <name>, the three files are stitched into a single system prompt at the head of the conversation. Missing files are skipped silently.\n  init scaffolds the three files with short stubs you replace.\n  show prints the composed prompt; show <name> AGENTS.md (etc) prints just one file.',
  browse: 'Usage: lazyclaw browse <url> [--max-bytes <N>] [--timeout-ms <N>] [--user-agent <ua>] [--meta]\n  Fetches the URL and emits Markdown on stdout. Pipes cleanly into `agent`:\n      lazyclaw browse https://example.com/docs | lazyclaw agent -\n  Strips <script>/<style>/<svg>/comments, prefers <main>/<article>, falls back to <body>.\n  --max-bytes caps the body read (default 2 MB) so a misconfigured upstream can\'t OOM the process.\n  --meta prints { url, title, bytes, truncated } as JSON to stderr alongside the markdown on stdout.',
  cron: 'Usage: lazyclaw cron <list | add <name> "<cron-spec>" -- <cmd> ... | remove <name> | show <name> | sync | run <name>>\n  Schedule recurring agent runs. macOS uses launchd (~/Library/LaunchAgents/com.lazyclaw.<name>.plist); Linux / WSL uses the user crontab.\n  Cron spec is the standard 5-field form (minute hour dom month dow). Supports *, range a-b, list a,b,c, step */N.\n  add: pass the command after `--`. Typical use:\n      lazyclaw cron add daily-summary "0 9 * * 1-5" -- lazyclaw agent "Summarise today\'s TODOs"\n  list / show: read from cfg.cron[name] (config is the source of truth).\n  sync: re-installs every job in cfg.cron into the system scheduler — handy after a reinstall.\n  run: one-shot in-process execution of the named job; the OS scheduler does the same thing on its trigger.\n  Logs: ~/.lazyclaw/logs/cron-<name>.{out,err}.log (macOS launchd path).',
  setup: 'Usage: lazyclaw setup [--skip-test]\n  OpenClaw-style multi-step first-run wizard. Walks through:\n    1. Provider + model + api-key (delegates to onboard --pick)\n    2. Optional workspace init  (AGENTS.md / SOUL.md / TOOLS.md)\n    3. Optional skill bundle install from GitHub\n    4. Optional outbound webhook (Slack / Discord)\n    5. Reachability test against the picked provider\n  Each optional step takes Enter or "skip" to bypass. Re-runnable safely.\n  Also fires automatically on first run when `lazyclaw` is invoked with no config.',
  dashboard: 'Usage: lazyclaw dashboard [--port <N>] [--no-open]\n  Launches the lazyclaw-only web UI on http://127.0.0.1:<port> (default 19600) and opens it in the default browser.\n  Wraps `lazyclaw daemon` + a static HTML; no Python / lazyclaude dashboard required.\n  See web/dashboard.html for the current tab set (v5: Chat / Sessions / Workflows / Skills / Providers / Rates / Metrics / Doctor / Config / Status / Agents / Teams / Tasks / Trainer / Recall / Sandbox / Channels).\n  --no-open keeps the browser closed (handy for SSH / headless / dev). The bound URL is always printed to stdout.',
  orchestrator: 'Usage: lazyclaw orchestrator <status | set-planner <provider[:model]> | workers add <spec> | workers remove <spec> | workers set <spec,spec,...> | workers clear | set-max-subtasks <N> | clear>\n  Read/write cfg.orchestrator without editing config.json by hand.\n  status               — print {planner, workers, maxSubtasks} as JSON; lists registered providers for reference.\n  set-planner          — replace the planner spec ("provider" or "provider:model"). "orchestrator" itself is rejected (self-recursion).\n  workers add          — append a worker (idempotent — duplicates skipped).\n  workers remove       — drop a worker by exact match. Idempotent.\n  workers set          — replace the whole list (comma-separated specs).\n  workers clear        — empty the workers list.\n  set-max-subtasks <N> — cap subtasks per request, clamped 1..10 (default 5).\n  clear                — delete the cfg.orchestrator block entirely.\n  Pair with: `lazyclaw config set provider orchestrator` to route chats through it.',
};

function cmdHelp(name) {
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


async function cmdChat(flags = {}) {
  await ensureRegistry();
  const sessionsMod = await import('./sessions.mjs');
  const skillsMod = await import('./skills.mjs');
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
    hasProvider: !!activeProvName,
    flagPick: !!flags.pick,
    isTTY: !!process.stdin.isTTY,
  });
  if (_mode === 'setup') {
    try { await cmdSetup(undefined, [], {}); }
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
      const { ReplApp } = await import('./tui/repl.mjs');
      const { renderSplashToString } = await import('./tui/splash.mjs');
      // narrow-terminal fallback: <60 cols falls back to v4
      if ((process.stdout.columns || 80) < 60) throw new Error('narrow-terminal');

      // Tool groups — read the v5 registry and collapse to one row per category.
      let toolGroups = [];
      try {
        const registry = await import('./mas/tools/registry.mjs');
        const byCat = registry.byCategory();
        toolGroups = Object.entries(byCat).map(([category, items]) => ({
          category,
          sensitive: items.some(t => t.sensitive),
          verbs: items.map(t => t.name.replace(/^[a-z]+_/, '')).slice(0, 6),
        })).sort((a, b) => a.category.localeCompare(b.category));
      } catch { /* registry unavailable → empty list */ }

      // Skill groups — group installed skills by filename hyphen-prefix
      // (canonical C5 fallback: <group>-<name>.md → group; bare names → 'general').
      let skillGroups = [];
      try {
        const { listSkills } = await import('./skills.mjs');
        // Use the resolved config dir, not the module default, so a
        // LAZYCLAW_CONFIG_DIR override surfaces that install's skills.
        const flat = listSkills(path.dirname(configPath()));
        const byGroup = new Map();
        for (const s of flat) {
          const i = s.name.indexOf('-');
          const group = i > 0 ? s.name.slice(0, i) : 'general';
          const sub = i > 0 ? s.name.slice(i + 1) : s.name;
          if (!byGroup.has(group)) byGroup.set(group, []);
          byGroup.get(group).push(sub);
        }
        skillGroups = [...byGroup.entries()]
          .map(([group, names]) => ({ group, names: names.slice(0, 6) }))
          .sort((a, b) => a.group.localeCompare(b.group));
      } catch { /* skills dir unavailable → empty list */ }

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
        const sb = await import('./sandbox.mjs');
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
        const { composePromptStack } = await import('./mas/prompt_stack.mjs');
        const stacked = composePromptStack({
          cfgDir: _inkCfgDir,
          agent: { name: 'chat', role: '' },
          workspace: _inkWorkspaceName,
        });
        if (stacked && stacked.trim()) _inkSysParts.push(stacked);
      } catch { /* never block chat start on stack composition */ }
      if (_inkWorkspaceName && !_inkMessages.some((m) => m.role === 'system')) {
        try {
          const ws = await import('./workspace.mjs');
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
          import('./memory.mjs').then((m) => {
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
      // v5.0.10: write streamed chunks straight to process.stdout. Ink
      // owns the screen, so interleaved stdout writes can produce some
      // visual jank — accepted trade for unblocking the chat loop. v5.1
      // TODO: route through a ref'd scrollback <Static/> region in
      // ReplApp so Ink owns all output.
      const _inkRunTurn = _chatRunTurnFactory({
        ctx: _inkCtx,
        writeFn: (chunk) => process.stdout.write(chunk),
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
        runTurn: _inkRunTurn,
        onSlashCommand: _inkSlashHandler,
        pickerRef: _inkPickerRef,
      }), { exitOnCtrlC: true, patchConsole: true });
      await ink.waitUntilExit();
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
    const sb = await import('./sandbox.mjs');
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
    const { composePromptStack } = await import('./mas/prompt_stack.mjs');
    const stacked = composePromptStack({
      cfgDir,
      agent: { name: 'chat', role: '' },
      workspace: workspaceName,
    });
    if (stacked && stacked.trim()) sysParts.push(stacked);
  } catch { /* never block chat start on stack composition */ }
  if (workspaceName && !messages.some(m => m.role === 'system')) {
    try {
      const ws = await import('./workspace.mjs');
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
      import('./memory.mjs').then((m) => {
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
      case '/reset': {
        messages = [];
        charsSent = 0;
        runningUsage = null;
        if (sessionId) {
          const sm = await import('./sessions.mjs');
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
            const { costFromUsage } = await import('./providers/rates.mjs');
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
            const sm = await import('./sessions.mjs');
            sm.resetSession(sessionId, cfgDir);
            for (const m of messages) sm.appendTurn(sessionId, m.role, m.content, cfgDir);
          }
          process.stdout.write('cleared system prompt (no active skills)\n');
          return true;
        }
        try {
          const sys = await (async () => {
            const mod = await import('./skills.mjs');
            return mod.composeSystemPrompt(names, cfgDir);
          })();
          if (!sys) {
            process.stdout.write('no skill content composed (empty input?)\n');
            return true;
          }
          if (sysIdx >= 0) messages[sysIdx] = { role: 'system', content: sys };
          else messages.unshift({ role: 'system', content: sys });
          if (sessionId) {
            const sm = await import('./sessions.mjs');
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
        const loopMod = await import('./loop-engine.mjs');
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
        const memMod = (parsed.useMemory || parsed.recall) ? await import('./memory.mjs') : null;
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
        const goalsMod = await import('./goals.mjs');
        const loopMod = await import('./loop-engine.mjs');
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
              try { await (await import('./commands/automation.mjs'))._attachGoalCron(name, cron); }
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
            try { await (await import('./commands/automation.mjs'))._detachGoalCron(name); }
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
        const memMod = await import('./memory.mjs');
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
        const memMod = await import('./memory.mjs');
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
        const agentsMod = await import('./agents.mjs');
        const loopMod = await import('./loop-engine.mjs');
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
        const teamsMod = await import('./teams.mjs');
        const loopMod = await import('./loop-engine.mjs');
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
          const { openThreads } = await import('./channels/threads.mjs');
          const { runHandoff } = await import('./channels/handoff.mjs');
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
        await (await import('./commands/config.mjs')).cmdPersonality(parts[0] || 'list', parts[1], parts[2]);
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
            const userModelPromise = import('./mas/user_modeler.mjs').then((m) =>
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
      default:
        process.stdout.write(`unknown slash: ${cmd} (try /help)\n`);
        return true;
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
async function cmdSetup(_sub, _positional, flags = {}) {
  await ensureRegistry();
  const accent = (s) => `\x1b[38;5;208m${s}\x1b[0m`;
  const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
  const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
  const ok     = (s) => `\x1b[32m${s}\x1b[0m`;
  const warn   = (s) => `\x1b[33m${s}\x1b[0m`;

  // Header.
  if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
  _renderBanner(readVersionFromRepo()).forEach((l) => process.stdout.write(l + '\n'));
  process.stdout.write('\n');
  process.stdout.write(`  ${bold('🔧 Setup wizard')}\n`);
  process.stdout.write(`  ${dim('Five short steps. Press Enter to accept the default; type "skip" or "n" to bypass an optional step.')}\n\n`);

  const cfg = readConfig();
  const cfgDir = path.dirname(configPath());

  // ── Step 1: Provider + model (mandatory) ────────────────────
  process.stdout.write(`  ${accent('Step 1/5 ·')} ${bold('Pick a provider + model')}\n`);
  process.stdout.write(`  ${dim('Opens the arrow-key picker. The list leads with gemini / openai / claude-cli — pick the one you have an account or login for.')}\n\n`);
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
  const cfgAfterOnboard = readConfig();
  if (!cfgAfterOnboard.provider) {
    process.stdout.write(`\n  ${warn('Setup not completed — provider was not configured.')}\n`);
    process.stdout.write(`  ${dim('Run `lazyclaw setup` again when ready, or pick "Onboard" from the menu for a single-step picker.')}\n\n`);
    return;
  }
  process.stdout.write(`\n  ${ok('✓ provider:')} ${cfgAfterOnboard.provider}  ${dim('model:')} ${cfgAfterOnboard.model || '(default)'}\n\n`);

  // ── Step 2: Optional workspace ──────────────────────────────
  process.stdout.write(`  ${accent('Step 2/5 ·')} ${bold('Initialise a workspace?')} ${dim('(optional)')}\n`);
  process.stdout.write(`  ${dim('A workspace is a folder of AGENTS.md / SOUL.md / TOOLS.md prompt files that auto-inject into chat / agent. Skip if you don\'t need project-specific personas yet.')}\n\n`);
  const wsName = (await _quickPrompt('  workspace name (Enter to skip): ')).trim();
  if (wsName && /^[A-Za-z0-9_.-]+$/.test(wsName)) {
    try {
      const ws = await import('./workspace.mjs');
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

  // ── Step 3: Optional skill bundle install ───────────────────
  process.stdout.write(`  ${accent('Step 3/5 ·')} ${bold('Install a skill bundle from GitHub?')} ${dim('(optional)')}\n`);
  process.stdout.write(`  ${dim('Format: <user>/<repo>[@<ref>]. Skills are .md prompt fragments that compose into the system prompt via --skill.')}\n\n`);
  const skillSpec = (await _quickPrompt('  github spec (Enter to skip): ')).trim();
  if (skillSpec) {
    try {
      const inst = await import('./skills_install.mjs');
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

  // ── Step 4: Optional outbound webhook ───────────────────────
  process.stdout.write(`  ${accent('Step 4/5 ·')} ${bold('Add an outbound webhook?')} ${dim('(optional)')}\n`);
  process.stdout.write(`  ${dim('Use with: lazyclaw message send <name> <text>. Slack / Discord Incoming Webhook URLs work as-is.')}\n\n`);
  const hookName = (await _quickPrompt('  webhook name (Enter to skip): ')).trim();
  if (hookName) {
    const hookUrl = (await _quickPrompt('  webhook URL: ')).trim();
    if (!hookUrl) {
      process.stdout.write(`  ${warn('skipped:')} URL required\n\n`);
    } else {
      try {
        const cf = await import('./config_features.mjs');
        const fresh = readConfig();
        cf.messageAdd(fresh, hookName, hookUrl);
        writeConfig(fresh);
        process.stdout.write(`  ${ok('✓ webhook saved:')} ${hookName}\n\n`);
      } catch (e) {
        process.stdout.write(`  ${warn('skipped:')} ${e?.message || e}\n\n`);
      }
    }
  } else {
    process.stdout.write(`  ${dim('— skipped —')}\n\n`);
  }

  // ── Step 5: Reachability check ──────────────────────────────
  process.stdout.write(`  ${accent('Step 5/5 ·')} ${bold('Verify the picked provider responds')}\n`);
  process.stdout.write(`  ${dim('Sends a 1-token "ping" via `lazyclaw providers test`. Confirms your key / subscription / local daemon is wired up.')}\n\n`);
  const wantPing = !flags['skip-test'] && (await _quickPrompt('  test now? [Y/n] ')).trim().toLowerCase() !== 'n';
  if (wantPing) {
    try {
      // Reuse the existing providers-test path so behaviour matches
      // a manual `lazyclaw providers test`.
      await (await import('./commands/providers.mjs')).cmdProviders('test', [cfgAfterOnboard.provider], {});
    } catch (e) {
      process.stdout.write(`  ${warn('test errored:')} ${e?.message || e}\n`);
      process.stdout.write(`  ${dim('Setup still completed; you can retry with:')} lazyclaw providers test ${cfgAfterOnboard.provider}\n`);
    }
  } else {
    process.stdout.write(`  ${dim('— skipped —')}\n`);
  }

  // ── Wrap up ─────────────────────────────────────────────────
  process.stdout.write('\n');
  process.stdout.write(`  ${ok(bold('🎉 Setup complete.'))}\n`);
  process.stdout.write(`  ${dim('Run')} ${bold('lazyclaw')} ${dim('any time to open the menu, or jump in directly:')}\n`);
  process.stdout.write(`    ${dim('•')} lazyclaw chat                ${dim('— REPL with the configured provider')}\n`);
  process.stdout.write(`    ${dim('•')} lazyclaw agent "..."          ${dim('— one-shot prompt')}\n`);
  process.stdout.write(`    ${dim('•')} lazyclaw doctor              ${dim('— diagnostic JSON')}\n`);
  process.stdout.write(`    ${dim('•')} lazyclaw setup               ${dim('— re-run this wizard any time')}\n\n`);
}

// First-run welcome panel + delegated onboard. Drawn once before the
// main launcher menu when the config has no provider yet. Walks the
// user through the same arrow-key picker that `lazyclaw onboard`
// uses; on success the launcher continues, on cancel the launcher
// exits politely instead of dropping into a menu where every option
// would error.
async function _runFirstTimeOnboard() {
  const accent = (s) => `\x1b[38;5;208m${s}\x1b[0m`;
  const dim    = (s) => `\x1b[2m${s}\x1b[0m`;
  const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
  process.stdout.write('\x1b[2J\x1b[H');
  _renderBanner(readVersionFromRepo()).forEach((l) => process.stdout.write(l + '\n'));
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
      case 'chat':         return await cmdChat({});
      case 'agent':        {
        if (AGENT_REG_SUBS.has(rest[0])) return await (await import('./commands/agents.mjs')).cmdAgentRegistry(rest[0], rest.slice(1), {});
        return await (await import('./commands/agents.mjs')).cmdAgent(rest[0] || '-', {});
      }
      case 'onboard':      return await cmdOnboard({});
      case 'setup':        return await cmdSetup(undefined, rest, {});
      case 'workspace':    return await (await import('./commands/auth_nodes.mjs')).cmdWorkspace(rest[0], rest.slice(1), {});
      case 'browse':       return await (await import('./commands/misc.mjs')).cmdBrowse(rest[0], {});
      case 'skills':       return await (await import('./commands/skills.mjs')).cmdSkills(rest[0], rest.slice(1), {});
      case 'sessions':     return await (await import('./commands/sessions.mjs')).cmdSessions(rest[0], rest.slice(1), {});
      case 'providers':    return await (await import('./commands/providers.mjs')).cmdProviders(rest[0], rest.slice(1), {});
      case 'cron':         return await (await import('./commands/automation.mjs')).cmdCron(rest[0], rest.slice(1), {});
      case 'loop':         return await (await import('./commands/automation.mjs')).cmdLoop(rest[0] || '', {});
      case 'loops':        return await (await import('./commands/automation.mjs')).cmdLoops(rest[0], rest.slice(1), {});
      case 'goal':         return await (await import('./commands/automation.mjs')).cmdGoal(rest[0], rest.slice(1), {});
      case 'memory':       return await (await import('./commands/sessions.mjs')).cmdMemory(rest[0], rest.slice(1), {});
      case 'slack':        return await (await import('./commands/channels.mjs')).cmdSlack(rest[0], rest.slice(1), {});
      case 'telegram':     return await (await import('./commands/channels.mjs')).cmdTelegram(rest[0], rest.slice(1), {});
      case 'matrix':       return await (await import('./commands/channels.mjs')).cmdMatrix(rest[0], rest.slice(1), {});
      case 'team':         return await (await import('./commands/agents.mjs')).cmdTeam(rest[0], rest.slice(1), {});
      case 'task':         return await (await import('./commands/agents.mjs')).cmdTask(rest[0], rest.slice(1), {});
      case 'auth':         return await (await import('./commands/auth_nodes.mjs')).cmdAuth(rest[0], rest.slice(1), {});
      case 'pairing':      return await (await import('./commands/auth_nodes.mjs')).cmdPairing(rest[0], rest.slice(1), {});
      case 'nodes':        return await (await import('./commands/auth_nodes.mjs')).cmdNodes(rest[0], rest.slice(1), {});
      case 'message':      return await (await import('./commands/auth_nodes.mjs')).cmdMessage(rest[0], rest.slice(1), {});
      case 'doctor':       return await (await import('./commands/config.mjs')).cmdDoctor();
      case 'status':       return await (await import('./commands/config.mjs')).cmdStatus();
      // v3.99.27 — fill the rest of the lazyclaw <subcommand> surface
      // so the no-arg launcher mirrors every entry in SUBCOMMANDS.
      case 'orchestrator': return await (await import('./commands/providers.mjs')).cmdOrchestrator(rest[0], rest.slice(1), {});
      case 'rates':        return await (await import('./commands/providers.mjs')).cmdRates(rest[0], rest.slice(1), {});
      case 'config':       {
        // Mirror the main switch's tiny dispatcher.
        const csub = rest[0];
        if (csub === 'list' || csub === undefined) return (await import('./commands/config.mjs')).cmdConfigGet(undefined);
        if (csub === 'get')   return (await import('./commands/config.mjs')).cmdConfigGet(rest[1]);
        if (csub === 'set')   return (await import('./commands/config.mjs')).cmdConfigSet(rest[1], rest.slice(2).join(' '));
        if (csub === 'path')  { process.stdout.write(configPath() + '\n'); return; }
        if (csub === 'edit')  return await (await import('./commands/config.mjs')).cmdConfigEdit();
        if (csub === 'validate') return await (await import('./commands/config.mjs')).cmdConfigValidate();
        process.stderr.write('Usage: lazyclaw config <get|set|list|delete|path|edit|validate>\n');
        return;
      }
      case 'inspect':      return await (await import('./commands/workflow.mjs')).dispatch('inspect', { positional: [rest[0]], flags: {} });
      case 'export':       return await (await import('./commands/sessions.mjs')).cmdExport({});
      case 'version':      return await (await import('./commands/config.mjs')).cmdVersion();
      // Phase G — persona compose subcommand (spec §9, decision C7).
      case 'personality':  return await (await import('./commands/config.mjs')).cmdPersonality(rest[0], rest[1], rest[2]);
      // help <cmd> is the safe fallback for commands that need real
      // arguments (run / resume / clear / validate / graph / daemon /
      // import / completion). Print the usage so the user can re-launch
      // with proper flags — the menu stays alive.
      case 'help':         return cmdHelp(rest[0]);
      case 'dashboard':    return await (await import('./commands/daemon.mjs')).cmdDashboard({});
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

async function cmdLauncher() {
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

  const accent = (s) => `\x1b[38;5;208m${s}\x1b[0m`;
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
      await cmdChat(rest.flags);
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
      await cmdSetup(undefined, rest.positional, rest.flags);
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
      await cmdOnboard(rest.flags);
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
      cmdHelp(rest.positional[0]);
      break;
    }
    case 'menu': {
      // v5.0.6 — explicit arrow-key launcher (was the no-arg default in v5.0.5-).
      await cmdLauncher();
      break;
    }
    default:
      console.error('Usage: lazyclaw <' + SUBCOMMANDS.join('|') + '> ...');
      console.error('Run `lazyclaw help` for a one-line summary of each subcommand.');
      process.exit(2);
  }
}

main().catch(e => { console.error(e?.stack || e?.message || String(e)); process.exit(1); });
