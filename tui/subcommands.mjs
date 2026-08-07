// tui/subcommands.mjs — the pompos subcommand catalog, grouped. Pure data
// (no react/ink) so both the splash (tui/splash.mjs) and the in-chat command
// palette (/menu in tui/slash_dispatcher.mjs) can share it. The no-arg
// launcher menu used to be the home screen; defaulting to chat hid it behind
// `pompos menu`, so /menu brings the discoverable subcommand list back into
// the chat.

export const SUBCOMMAND_GROUPS = [
  ['core',     ['chat', 'agent', 'orchestrator', 'dashboard', 'menu']],
  ['workflow', ['run', 'resume', 'inspect', 'clear', 'validate', 'graph']],
  ['config',   ['config', 'auth', 'rates', 'providers', 'setup', 'onboard']],
  ['state',    ['sessions', 'skills', 'workspace', 'memory', 'status', 'doctor']],
  ['runtime',  ['daemon', 'cron', 'loop', 'loops', 'goal']],
  ['channels', ['slack', 'telegram', 'matrix', 'channels', 'message', 'pairing']],
  ['v5',       ['sandbox', 'personality', 'migrate', 'hermes', 'openclaw', 'trajectories']],
  ['utility',  ['browse', 'version', 'completion', 'help', 'export', 'import', 'nodes']],
];
