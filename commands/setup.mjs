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
  setup:      'Hermes-style phased first-run wizard (provider + verify chat + channel + workspace + skill + webhook)',
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
  setup: 'Usage: lazyclaw setup [--skip-test] [--only <steps>] [--skip <steps>]\n  --only/--skip take a comma list of: provider verify channel workspace skill webhook orchestrator (e.g. --only channel re-runs just that step).\n  Hermes-style phased first-run wizard — get one clean chat working first,\n  then optionally add the rest. Walks through:\n    1. Provider + model + api-key (delegates to onboard --pick; ≥64k-context tip)\n    2. Verify the provider responds (1-token ping; --skip-test bypasses)\n    3. Optional channel / gateway (Slack / Telegram / Matrix / HTTP built in;\n       Discord / Email / Signal / Voice / WhatsApp via plugin packages)\n    4. Optional workspace init  (AGENTS.md / SOUL.md / TOOLS.md)\n    5. Optional skill bundle install from GitHub\n    6. Optional outbound webhook (Slack / Discord)\n    7. Optional multi-agent orchestration (planner + workers)\n  Each optional step takes Enter or "skip" to bypass. Re-runnable safely.\n  Also fires automatically on first run when `lazyclaw` is invoked with no config.',
  dashboard: 'Usage: lazyclaw dashboard [--port <N>] [--no-open]\n  Launches the lazyclaw-only web UI on http://127.0.0.1:<port> (default 19600) and opens it in the default browser.\n  Wraps `lazyclaw daemon` + a static HTML; no Python / lazyclaude dashboard required.\n  See web/dashboard.html for the current tab set (v5: Chat / Sessions / Workflows / Skills / Providers / Rates / Metrics / Doctor / Config / Status / Agents / Teams / Tasks / Trainer / Recall / Sandbox / Channels).\n  --no-open keeps the browser closed (handy for SSH / headless / dev). The bound URL is always printed to stdout.',
  orchestrator: 'Usage: lazyclaw orchestrator <status | set-planner <provider[:model]> | workers add <spec> | workers remove <spec> | workers set <spec,spec,...> | workers clear | set-max-subtasks <N> | clear>\n  Read/write cfg.orchestrator without editing config.json by hand.\n  status               — print {planner, workers, maxSubtasks} as JSON; lists registered providers for reference.\n  set-planner          — replace the planner spec ("provider" or "provider:model"). "orchestrator" itself is rejected (self-recursion).\n  workers add          — append a worker (idempotent — duplicates skipped).\n  workers remove       — drop a worker by exact match. Idempotent.\n  workers set          — replace the whole list (comma-separated specs).\n  workers clear        — empty the workers list.\n  set-max-subtasks <N> — cap subtasks per request, clamped 1..10 (default 5).\n  clear                — delete the cfg.orchestrator block entirely.\n  Pair with: `lazyclaw config set provider orchestrator` to route chats through it.',
};

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

  // Context window — asked right after the model pick (optional; Enter keeps
  // defaults). Not a numbered step: it's part of the core model setup.
  await runContextStep({ prompt: _quickPrompt, colors });
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


