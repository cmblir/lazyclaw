// CLI argument parsing + shell-completion generation, extracted from cli.mjs.
// Pure leaf module: no imports, no side effects — just the subcommand inventory
// and the parseArgs/completion functions that main() and `pompos completion`
// share.

// Subcommand inventory used by `pompos completion`. Single source of
// truth so adding a subcommand updates the completion script too. The
// dispatcher in main() is the runtime authority; this list mirrors it.
export const SUBCOMMANDS = [
  'run', 'resume', 'inspect', 'clear', 'validate', 'graph',
  'workflow',
  'config', 'chat', 'agent',
  'doctor', 'status', 'onboard', 'login',
  'sessions', 'skills', 'providers',
  'daemon', 'version', 'completion', 'help',
  'export', 'import',
  'rates',
  // v5.0 — sandbox 6-backend (Phase D)
  'sandbox',
  // OpenClaw-parity subsurfaces (v3.93–v3.98)
  'auth', 'pairing', 'nodes', 'message', 'workspace', 'browse', 'cron',
  // v3.99.6 — multi-step setup wizard + pompos-only dashboard
  'setup', 'dashboard',
  // v3.99.22 — multi-agent orchestrator config
  'orchestrator',
  // v3.99.30 — /loop and /goal slash commands (in-session + detached)
  'loop', 'loops', 'goal', 'memory',
  // v4.0.0 — Slack Socket Mode listener (inbound DM / @-mention)
  'slack',
  // v4.3.0 — Telegram long-poll listener (zero-install mobile control)
  'telegram',
  // v4.3.0 — Matrix /sync long-poll listener
  'matrix',
  // v5.0 — channels plugin loader (Phase F)
  'channels',
  // v4.1.0 — multi-agent slack system (Phase 9+); 'agent' already listed above
  'team', 'task',
  // v5.0 Phase G — persona compose + cross-tool import (spec §9, §10)
  'personality', 'migrate', 'hermes', 'openclaw',
  // v5.0.6 — arrow-key launcher menu (was the no-arg default in v5.0.5-)
  'menu',
  // v5.0 Phase H1 — trajectory exporter (spec §2.7)
  'trajectories',
  // FTS index maintenance — `index rebuild` is the documented recovery
  // surface (mas/index_db.mjs, doctor failure-log) for a stale/corrupt index.
  'index',
  // MCP — read-only inspection of configured/connected MCP servers. The
  // servers themselves boot from cfg.mcp.servers at daemon start.
  'mcp',
];

export const SUBCOMMAND_SUBS = {
  config:    ['get', 'set', 'list', 'delete', 'unset', 'path', 'edit', 'validate'],
  sessions:  ['list', 'show', 'clear', 'export', 'search'],
  skills:    ['list', 'show', 'install', 'remove', 'search', 'curate', 'classify'],
  providers: ['list', 'info', 'test', 'add', 'remove', 'models'],
  rates:     ['list', 'set', 'delete', 'shape', 'validate', 'copy'],
  sandbox:   ['list', 'test', 'add', 'use'],
  completion: ['bash', 'zsh'],
  auth:      ['list', 'add', 'remove', 'use', 'rotate'],
  pairing:   ['list', 'add', 'remove'],
  nodes:     ['list', 'register', 'remove', 'pending', 'approve', 'revoke', 'rotate', 'devices'],
  message:   ['list', 'add', 'remove', 'send'],
  workspace: ['list', 'init', 'show', 'remove', 'path'],
  cron:      ['list', 'add', 'remove', 'show', 'sync', 'run'],
  orchestrator: ['status', 'set-planner', 'workers', 'set-max-subtasks', 'clear'],
  loops:     ['list', 'show', 'kill', 'tail'],
  goal:      ['add', 'list', 'show', 'close', 'switch', 'tick', 'channel'],
  memory:    ['show', 'dream', 'edit'],
  slack:     ['listen'],
  telegram:  ['listen'],
  matrix:    ['listen'],
  agent:     ['add', 'list', 'show', 'edit', 'remove'],
  team:      ['add', 'list', 'show', 'edit', 'remove'],
  task:      ['start', 'list', 'show', 'abandon', 'done', 'remove'],
  trajectories: ['export'],
  index:     ['rebuild', 'embed'],
  workflow:  ['list', 'show', 'add', 'remove', 'run'],
  mcp:       ['list', 'add', 'remove', 'call'],
};

// Flags whose presence is the signal — they don't consume the next arg
// even when one is available. Without this allow-list,
// `pompos run --parallel demo wf.mjs` would set `flags.parallel='demo'`
// and silently lose the session id; the user would only see a
// "missing positional" error after the dispatcher rejected it.
export const BOOLEAN_FLAGS = new Set([
  'parallel',
  'parallel-persistent',
  'once',
  'non-interactive',
  'include-secrets',
  'include-sessions',
  'overwrite-skills',
  'no-overwrite-config',
  'import-sessions',
  'show-thinking',
  'usage',
  'cost',
  'response-cache',
  'help',         // also handled as a subcommand alias
  'version',
  'summary',      // inspect: trim per-node detail
  'regex',        // sessions search: treat query as a regex
  'lr',           // graph: emit Mermaid `graph LR` (left-right)
  'force',        // rates copy: overwrite existing destination
  'aggregate',    // inspect (list mode): per-node stats across sessions
  'all',          // providers test: run all providers in parallel
  'with-turn-count', // sessions list: include turn count per session
  'no-probe',     // providers add: skip the /v1/models reachability probe
  'pick',         // onboard / chat: force the interactive picker even when provider already set
  'detach',       // loop: fork worker and return immediately
  'use-memory',   // loop: prepend core memory to each iteration
  'force',        // goal tick --force: bypass schedule when invoked manually
]);

// Levenshtein edit distance — small iterative DP, no allocation per char
// beyond two rows. Used by nearest() to power the "did you mean" suggestion
// on an unknown subcommand. Kept here (pure leaf) so cli.mjs and tests share it.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Closest known subcommand for `input`, or null when nothing is close enough.
// "Close" = a clear (unambiguous) prefix match, OR edit distance <= 2 with a
// single best candidate. Returns the exact entry from `candidates` so callers
// can echo a canonical spelling in the suggestion.
export function nearest(input, candidates) {
  if (!input) return null;
  const word = String(input).toLowerCase();
  // Exact prefix wins when it's unambiguous (e.g. "provid" -> "providers").
  const prefixHits = candidates.filter(c => c.toLowerCase().startsWith(word) && c.toLowerCase() !== word);
  if (prefixHits.length === 1) return prefixHits[0];
  let best = null, bestDist = Infinity, tie = false;
  for (const c of candidates) {
    const d = editDistance(word, c.toLowerCase());
    if (d < bestDist) { bestDist = d; best = c; tie = false; }
    else if (d === bestDist) tie = true;
  }
  // Gate on distance <= 2 and require a unique winner to avoid a misleading
  // suggestion when several commands are equidistant from the typo.
  if (best && bestDist <= 2 && !tie) return best;
  return null;
}

// One-line usage hint for a known subcommand, built from the inventory we
// already own here (SUBCOMMANDS + SUBCOMMAND_SUBS). cli.mjs uses this as the
// fallback for `pompos help <name>` when the subcommand has no rich entry in
// commands/setup.mjs's HELP_DETAILS — so help never errors on a real command.
// Returns null for an unknown name (the caller then offers a did-you-mean).
export function usageHint(name) {
  if (!SUBCOMMANDS.includes(name)) return null;
  const subs = SUBCOMMAND_SUBS[name];
  return subs
    ? `Usage: pompos ${name} <${subs.join('|')}> ...`
    : `Usage: pompos ${name} ...`;
}

export function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // POSIX `--`: everything after is positional verbatim. Used by
    // `cron add <name> "<spec>" -- <cmd> [args...]` so a recurring
    // command with --flag of its own doesn't get parsed as our flag.
    if (a === '--') {
      for (let j = i + 1; j < argv.length; j++) out.positional.push(argv[j]);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        if (BOOLEAN_FLAGS.has(name)) {
          // Known boolean — never consumes the next arg.
          out.flags[name] = true;
          continue;
        }
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          // Unknown flag at end-of-args or before another --flag: still boolean.
          out.flags[name] = true;
        } else {
          out.flags[name] = next;
          i += 1;
        }
      }
    } else out.positional.push(a);
  }
  return out;
}

export function bashCompletion() {
  // Standard bash COMPREPLY pattern. We split COMP_WORDS into:
  //   [0] = pompos, [1] = subcommand, [2+] = subcommand args.
  // Two-level completion: word index 1 → top subcommands; index 2 → the
  // sub-subcommand list (if defined for that subcommand). Beyond index 2
  // we don't try to enumerate dynamic items (session ids etc.) — that
  // would require running the CLI on every <Tab>, which is too slow.
  const subs = SUBCOMMANDS.join(' ');
  const subSubsCases = Object.entries(SUBCOMMAND_SUBS)
    .map(([name, list]) => `      ${name})\n        COMPREPLY=( $(compgen -W "${list.join(' ')}" -- "$cur") )\n        ;;`)
    .join('\n');
  return `# pompos bash completion. Source from your shell:
#   eval "$(node /path/to/cli.mjs completion bash)"
_pompos_completion() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    cword=$COMP_CWORD
  }
  if [ "$cword" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${subs}" -- "$cur") )
    return 0
  fi
  if [ "$cword" -eq 2 ]; then
    case "\${COMP_WORDS[1]}" in
${subSubsCases}
    esac
    return 0
  fi
  return 0
}
complete -F _pompos_completion pompos
`;
}

export function zshCompletion() {
  // _arguments-style. We list subcommands then dispatch on the first
  // positional via a single `_describe`. Sub-subcommands handled by a
  // case inside the function. Same coverage rationale as bash.
  const subs = SUBCOMMANDS.map(s => `    '${s}'`).join('\n');
  const subSubsCases = Object.entries(SUBCOMMAND_SUBS)
    .map(([name, list]) => `      (${name}) _values 'sub' ${list.map(v => `'${v}'`).join(' ')} ;;`)
    .join('\n');
  return `#compdef pompos
# pompos zsh completion. Add to fpath, or eval inline:
#   eval "$(node /path/to/cli.mjs completion zsh)"
_pompos() {
  local subs=(
${subs}
  )
  if (( CURRENT == 2 )); then
    _values 'subcommand' \${subs[@]}
    return
  fi
  if (( CURRENT == 3 )); then
    case \${words[2]} in
${subSubsCases}
    esac
    return
  fi
}
compdef _pompos pompos
_pompos "$@"
`;
}

// Subcommand-classifier sets for the multi-agent surfaces. cli.mjs uses
// AGENT_REG_SUBS to decide whether a bare `agent <sub>` routes to the agent
// registry vs a one-shot agent run. TEAM_SUBS/TASK_SUBS mirror their command's
// subcommands for the same disambiguation pattern.
export const AGENT_REG_SUBS = new Set(['add', 'list', 'show', 'edit', 'remove', 'rm', 'delete', 'memory', 'reflect', 'skill-synth', 'set-avatar']);
export const TEAM_SUBS = new Set(['add', 'list', 'show', 'edit', 'remove', 'rm', 'delete']);
export const TASK_SUBS = new Set(['start', 'tick', 'list', 'show', 'abandon', 'done', 'transcript', 'remove', 'rm', 'delete']);
