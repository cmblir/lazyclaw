// commands/setup_permission.mjs — the setup-wizard "tool permissions" step,
// extracted from commands/setup.mjs to stay under the file-size gate (D8) and
// to match the other modular steps (runContextStep / runChannelStep / …).
//
// Asks how the claude-cli agent should handle tool permissions and stores the
// choice at cfg.chat.permissionMode. lib/permission_mode.resolvePermissionMode
// reads it for every claude spawn; unset defaults to bypass (no nagging).

import { readConfig, writeConfig } from '../lib/config.mjs';
import { parsePermissionChoice } from '../lib/permission_mode.mjs';

export async function runPermissionStep({ prompt, colors, cfg } = {}) {
  const accent = (colors && colors.accent) || ((s) => s);
  const dim = (colors && colors.dim) || ((s) => s);
  const ok = (colors && colors.ok) || ((s) => s);
  const provider = String((cfg || readConfig()).provider || '');
  // Only relevant to the claude-cli agent path (the one that spawns `claude`).
  if (!/claude/.test(provider)) return;

  process.stdout.write(`  ${dim('Tool permissions — when the agent edits files or runs commands:')}\n`);
  process.stdout.write(`  ${dim('    bypass = never ask (fast) · ask = prompt each time · acceptEdits = auto-accept edits only · plan = read-only')}\n`);
  const mode = parsePermissionChoice(await prompt(`  ${accent('permission')} [bypass/ask/acceptEdits/plan] ${dim('(Enter = bypass)')}: `));
  if (mode) {
    const c = readConfig();
    c.chat = { ...(c.chat || {}), permissionMode: mode };
    writeConfig(c);
    process.stdout.write(`  ${ok('✓ permission mode:')} ${mode}\n\n`);
  } else {
    process.stdout.write(`  ${dim('(unrecognised — kept the current setting)')}\n\n`);
  }
}
