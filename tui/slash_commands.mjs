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
  { cmd: '/reset',       help: 'alias for /new' },
  { cmd: '/usage',       help: 'show message count + chars sent so far' },
  { cmd: '/skills',      help: 'list and activate skills (alias /skill)' },
  { cmd: '/skill',       help: 'switch active skills: /skill review,style (no arg → clear)' },
  { cmd: '/tools',       help: 'list available tool registry verbs' },
  { cmd: '/provider',    help: 'switch provider: /provider openai (no arg → print current)' },
  { cmd: '/model',       help: 'switch model: /model gpt-4.1 or anthropic/claude-opus-4-7' },
  { cmd: '/trainer',     help: 'configure trainer provider/model for learning loop' },
  { cmd: '/personality', help: 'switch agent personality preset' },
  { cmd: '/loop',        help: 'repeat one prompt: /loop "fix lint" [--max N] [--until "<regex>"]' },
  { cmd: '/goal',        help: 'register/switch goal: /goal add NAME | /goal list' },
  { cmd: '/memory',      help: 'show layered memory: /memory [core|recent|episodic [topic]]' },
  { cmd: '/recall',      help: 'FTS5 recall across sessions and memory' },
  { cmd: '/dream',       help: 'consolidate recent memory into per-topic episodic files' },
  { cmd: '/agent',       help: 'spawn or switch agent: /agent NAME' },
  { cmd: '/team',        help: 'list, create, or join a team' },
  { cmd: '/task',        help: 'create, list, or manage tasks' },
  { cmd: '/handoff',     help: 'hand current task off to another agent' },
  { cmd: '/exit',        help: 'leave the chat' },
  { cmd: '/quit',        help: 'alias for /exit' },
];
