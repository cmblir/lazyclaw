// tui/slash_commands.mjs — single source of truth for the REPL slash-command
// catalog. Imported by both cli.mjs (legacy ghost-autocomplete + /help dump)
// and tui/slash_popup.mjs (Ink popup chooser). Keeping the list here avoids
// a tui/ → cli.mjs circular import.
//
// Schema:
//   { cmd: string, help: string }
//
// Order matters — it is the order shown in the popup and in /help. New
// commands should be appended unless there is a UX reason to slot them in.

export const SLASH_COMMANDS = [
  { cmd: '/help',        help: 'list available slash commands' },
  { cmd: '/status',      help: 'print current provider, model, masked key' },
  { cmd: '/version',     help: 'print version + node + platform' },
  { cmd: '/new',         help: 'clear conversation and start over' },
  { cmd: '/clear',       help: 'alias for /new — clear conversation' },
  { cmd: '/reset',       help: 'alias for /new' },
  { cmd: '/usage',       help: 'show message count + chars sent so far' },
  { cmd: '/skills',      help: 'list and activate skills (alias /skill)' },
  { cmd: '/skill',       help: 'switch active skills: /skill review,style (no arg → clear)' },
  { cmd: '/tools',       help: 'list available tool registry verbs' },
  { cmd: '/provider',    help: 'pick provider from a list (or pass a name: /provider openai)' },
  { cmd: '/login',       help: 'connect a keyless CLI provider (codex-cli / gemini-cli): browser, API key, or install' },
  { cmd: '/model',       help: 'pick a model from a list (or pass a name: /model gpt-4.1)' },
  { cmd: '/hud',         help: 'toggle the HUD status row (usage · models · cost): /hud on|off' },
  { cmd: '/trainer',     help: 'view or set trainer provider/model: /trainer show|set <p:m>|clear' },
  { cmd: '/personality', help: 'pick a personality (or sub: list|show|install|remove|use)' },
  { cmd: '/dashboard',   help: 'open the lazyclaw web UI in your browser' },
  { cmd: '/menu',        help: 'browse the full subcommand catalog (command palette)' },
  { cmd: '/setup',       help: 'first-run / full re-setup: leave chat and run every wizard step' },
  { cmd: '/config',      help: 'change ONE setting: provider, model, context, channel creds, webhook, …' },
  { cmd: '/channels',    help: 'view configured channels; /channels <name> on|off to toggle' },
  { cmd: '/orchestrator', help: 'multi-agent: status | on | off | planner <spec> | worker add|remove <spec>' },
  { cmd: '/context',      help: 'chat history window: status | turns <N> | tokens <N>' },
  { cmd: '/loop',        help: 'repeat one prompt: /loop "fix lint" [--max N] [--until "<regex>"]' },
  { cmd: '/goal',        help: 'register/switch goal: /goal add NAME | /goal list' },
  { cmd: '/memory',      help: 'show layered memory: /memory [core|recent|episodic [topic]]' },
  { cmd: '/recall',      help: 'FTS5 recall across sessions and memory' },
  { cmd: '/dream',       help: 'consolidate recent memory into per-topic episodic files' },
  { cmd: '/agent',       help: 'spawn or switch agent: /agent NAME (edit <name> picks provider/model)' },
  { cmd: '/team',        help: 'list, create, or join a team' },
  { cmd: '/task',        help: 'multi-agent tasks: start/tick/list/show/transcript/abandon/done/remove' },
  { cmd: '/handoff',     help: 'hand current task off to another agent' },
  { cmd: '/exit',        help: 'leave the chat' },
  { cmd: '/quit',        help: 'alias for /exit' },
];
