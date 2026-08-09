// daemon/lib/slash_destructive.mjs — which slash lines must be confirmed
// before they run over HTTP.
//
// The REPL prompts inline via ctx.openPicker. Over HTTP there is no turn to
// block on, and tui/slash_helpers.mjs's _promptConfirm returns FALSE when
// openPicker is absent — so an unintercepted destructive command would report
// "cancelled" rather than asking. This table is checked before dispatch, so
// the question reaches the operator.
//
// Explicit rather than inferred: reviewing a list of subcommands is something
// a human can do; guessing intent from a picker's item shape is not.

// cmd -> { sub: RegExp on the FIRST token only, prompt(target) }
const RULES = new Map([
  ['/team', { sub: /^(remove|delete)$/i, prompt: (t) => `Remove team ${t || '(unnamed)'}? Its members stay, the team does not.` }],
  ['/agent', { sub: /^(remove|delete)$/i, prompt: (t) => `Remove agent ${t || '(unnamed)'}? Any team referencing it keeps the dangling name.` }],
  ['/skill', { sub: /^(remove|delete|uninstall)$/i, prompt: (t) => `Uninstall skill ${t || '(unnamed)'}? The file is deleted from disk.` }],
  ['/task', { sub: /^(abandon|cancel|delete|remove)$/i, prompt: (t) => `Abandon task ${t || '(unnamed)'}? It stops and cannot be resumed.` }],
  ['/workflow', { sub: /^(clear|delete|remove|stop)$/i, prompt: (t) => `Clear workflow state for ${t || '(all)'}? Saved progress is discarded.` }],
  ['/config', { sub: /^(unset|delete|remove)$/i, prompt: (t) => `Unset config key ${t || '(unnamed)'}?` }],
]);

// Commands whose whole purpose is discarding, so there is no subcommand to
// inspect.
const ALWAYS = new Map([
  ['/new', 'Start a new conversation? The current transcript is discarded.'],
  ['/reset', 'Reset the conversation? The current transcript is discarded.'],
  ['/clear', 'Clear the conversation? The current transcript is discarded.'],
]);

/**
 * @param {string} cmd  the slash command, e.g. '/team'
 * @param {string} args everything after it
 * @returns {string|null} the confirmation prompt, or null when safe
 */
export function destructivePrompt(cmd, args) {
  const key = String(cmd || '').toLowerCase();
  const always = ALWAYS.get(key);
  if (always) return always;
  const rule = RULES.get(key);
  if (!rule) return null;
  // Only the FIRST token is the subcommand; a later "remove" is data, not verb.
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !rule.sub.test(tokens[0])) return null;
  return rule.prompt(tokens[1] || '');
}
