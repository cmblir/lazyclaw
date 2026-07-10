// commands/setup_permission.mjs — the setup-wizard "tool permissions" step,
// extracted from commands/setup.mjs to stay under the file-size gate (D8) and
// to match the other modular steps (runContextStep / runChannelStep / …).
//
// Asks how the claude-cli agent should handle tool permissions and stores the
// choice at cfg.chat.permissionMode. lib/permission_mode.resolvePermissionMode
// reads it for every claude spawn; unset defaults to bypass (no nagging).
//
// Returns 'BACK' when the user pressed Esc (the wizard re-runs the previous
// step), else 'NEXT'. A `backPrompt` (tui/prompt_back.promptWithBack) makes Esc
// reachable; without it we fall back to the plain string `prompt` (no Esc).

import { readConfig, writeConfig } from '../lib/config.mjs';
import { parsePermissionChoice } from '../lib/permission_mode.mjs';

export async function runPermissionStep({ prompt, backPrompt, colors, cfg } = {}) {
  const accent = (colors && colors.accent) || ((s) => s);
  const dim = (colors && colors.dim) || ((s) => s);
  const ok = (colors && colors.ok) || ((s) => s);
  const provider = String((cfg || readConfig()).provider || '');
  // Only relevant to the claude-cli agent path (the one that spawns `claude`).
  if (!/claude/.test(provider)) return 'NEXT';

  process.stdout.write(`  ${dim('Tool permissions — when the agent edits files or runs commands (interactive use):')}\n`);
  process.stdout.write(`  ${dim('    bypass = never ask (fast) · ask = prompt each time · acceptEdits = auto-accept edits only · plan = read-only')}\n`);
  process.stdout.write(`  ${dim('    Unattended surfaces (daemon/gateway answering inbound messages) are fail-closed to read-only')}\n`);
  process.stdout.write(`  ${dim('    regardless of this choice, unless you set security.unattendedExec=true.')}\n`);
  const label = `  ${accent('permission')} [bypass/ask/acceptEdits/plan] ${dim('(Esc = back · Enter = bypass)')}: `;
  let answer;
  if (typeof backPrompt === 'function') {
    const r = await backPrompt(label);
    if (r && r.back) return 'BACK';
    answer = r ? r.value : '';
  } else {
    answer = await prompt(label);
  }
  const mode = parsePermissionChoice(answer);
  if (mode) {
    const c = readConfig();
    c.chat = { ...(c.chat || {}), permissionMode: mode };
    writeConfig(c);
    process.stdout.write(`  ${ok('✓ permission mode:')} ${mode}\n\n`);
  } else {
    process.stdout.write(`  ${dim('(unrecognised — kept the current setting)')}\n\n`);
  }
  return 'NEXT';
}
