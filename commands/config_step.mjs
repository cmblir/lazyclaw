// commands/config_step.mjs — run ONE setup step outside the full wizard.
//
// Backs the in-chat `/config` picker: credential steps (channel tokens,
// outbound webhook) need raw readline prompts that can't run inside the Ink
// REPL, so the REPL unmounts with ctx.requestConfigStep set, chat.mjs calls
// runConfigStep(step) here, and then re-enters chat — the user changes one
// value (e.g. a webhook URL) without re-walking every wizard step.

import path from 'node:path';
import { configPath } from '../lib/config.mjs';
import { _quickPrompt } from '../tui/pickers.mjs';
import { runChannelStep, runWebhookStep } from './setup_channels.mjs';

const COLORS = {
  accent: (s) => `\x1b[38;2;217;179;90m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
  ok:     (s) => `\x1b[32m${s}\x1b[0m`,
  warn:   (s) => `\x1b[33m${s}\x1b[0m`,
};

export async function runConfigStep(step, deps = {}) {
  const prompt = deps.prompt || _quickPrompt;
  const colors = deps.colors || COLORS;
  const write = deps.write || ((s) => process.stdout.write(s));
  const cfgDir = deps.cfgDir || path.dirname(configPath());

  write(`\n  ${colors.bold(`⚙ config — ${step}`)}\n`);
  if (step === 'channel') {
    await runChannelStep({ cfgDir, prompt, colors, write });
    return true;
  }
  if (step === 'webhook') {
    await runWebhookStep({ prompt, colors, write });
    return true;
  }
  write(`  ${colors.warn(`unknown config step: ${step}`)}\n`);
  return false;
}
