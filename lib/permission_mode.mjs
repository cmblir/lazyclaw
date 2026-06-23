// lib/permission_mode.mjs — the claude-cli permission mode lazyclaw passes to
// the spawned `claude` (`--permission-mode <mode>`).
//
// lazyclaw is an autonomous-agent CLI: the agentic / team path already runs the
// agent with bypassPermissions so it doesn't stop to ask before every tool. The
// interactive chat path historically passed no flag, so claude fell back to its
// own "default" mode and prompted on each tool — annoying when you just want it
// to run. This centralises the choice: `cfg.chat.permissionMode` (asked at
// setup) drives every claude spawn; unset defaults to bypassPermissions so the
// out-of-the-box experience doesn't nag. Cautious users pick 'default' (prompt
// each time), 'acceptEdits' (auto-accept edits, prompt for the rest), or 'plan'.

export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

export const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

// Resolve the effective mode from config. An unset or unrecognised value falls
// back to the default rather than handing claude an invalid --permission-mode.
export function resolvePermissionMode(cfg) {
  const m = cfg && cfg.chat && cfg.chat.permissionMode;
  return PERMISSION_MODES.includes(m) ? m : DEFAULT_PERMISSION_MODE;
}

// Map a setup-wizard answer to a permission mode. Empty (Enter) → the default
// (bypass). Returns null for an unrecognised answer so the caller can keep the
// current value rather than guess.
const CHOICE_MAP = {
  '': DEFAULT_PERMISSION_MODE, bypass: 'bypassPermissions', b: 'bypassPermissions',
  ask: 'default', default: 'default', d: 'default', prompt: 'default',
  acceptedits: 'acceptEdits', accept: 'acceptEdits', edits: 'acceptEdits', e: 'acceptEdits',
  plan: 'plan', p: 'plan',
};
export function parsePermissionChoice(answer) {
  const k = String(answer ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CHOICE_MAP, k) ? CHOICE_MAP[k] : null;
}
