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
  ['/team', { sub: /^(remove|rm|delete)$/i, prompt: (t) => `Remove team ${t || '(unnamed)'}? Its members stay, the team does not.` }],
  ['/agent', { sub: /^(remove|rm|delete)$/i, prompt: (t) => `Remove agent ${t || '(unnamed)'}? Any team referencing it keeps the dangling name.` }],
  ['/skill', { sub: /^(clear|unset)$/i, prompt: () => `Clear the system prompt? Any active skills are unset.` }],
  ['/task', { sub: /^(abandon|remove|rm|delete)$/i, prompt: (t) => `Abandon task ${t || '(unnamed)'}? It stops and cannot be resumed.` }],
  ['/personality', { sub: /^(remove|rm|delete)$/i, prompt: (t) => `Remove personality ${t || '(unnamed)'}? The file is deleted from disk.` }],
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
  // /skill clear|unset tests the entire args string (no subcommand, no target).
  // All other rules test only the FIRST token (later tokens are data, not verbs).
  if (key === '/skill') {
    const trimmed = String(args || '').trim();
    if (!rule.sub.test(trimmed)) return null;
    return rule.prompt('');
  }
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !rule.sub.test(tokens[0])) return null;
  return rule.prompt(tokens[1] || '');
}
