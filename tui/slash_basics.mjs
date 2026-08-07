// tui/slash_basics.mjs — the four read-only info slash handlers (/help,
// /status, /version, /usage), extracted verbatim from slash_dispatcher.mjs.
//
// They were the smallest self-contained group in that file and moving them
// keeps the dispatcher under its file-size ratchet so new commands can be
// registered there. Behavior is unchanged: each takes (args, ctx) and
// returns the string the REPL appends to scrollback.

import { SLASH_COMMANDS } from './slash_commands.mjs';
import { _mod } from './slash_helpers.mjs';

export async function _help() {
  const lines = ['slash commands:'];
  for (const c of SLASH_COMMANDS) lines.push(`  ${c.cmd.padEnd(14)} — ${c.help}`);
  return lines.join('\n');
}

export async function _status(_args, ctx) {
  const registry = await _mod(ctx, 'registryMod', () => import('../providers/registry.mjs'));
  const provider = ctx.getActiveProvName();
  const model = ctx.getActiveModel() || '(default)';
  const keyMasked = registry.maskApiKey(ctx.cfg && ctx.cfg['api-key']);
  const messageCount = ctx.getMessages().length;
  const sessionId = ctx.getSessionId() || '(none — in-memory)';
  return [
    'status:',
    `  provider:  ${provider}`,
    `  model:     ${model}`,
    `  api key:   ${keyMasked}`,
    `  messages:  ${messageCount}`,
    `  session:   ${sessionId}`,
  ].join('\n');
}

export async function _version(_args, ctx) {
  const v = ctx.version || '0.0.0';
  return `pompos ${v} (node ${process.version}, ${process.platform})`;
}

export async function _usage(_args, ctx) {
  const msgs = ctx.getMessages();
  const runningUsage = ctx.getRunningUsage && ctx.getRunningUsage();
  const charsSent = (ctx.getCharsSent && ctx.getCharsSent()) || 0;
  const lines = [
    'usage:',
    `  messages:  ${msgs.length}`,
    `  chars sent: ${charsSent.toLocaleString('en-US')}`,
  ];
  if (runningUsage) {
    lines.push(
      `  tokens in:  ${(runningUsage.inputTokens || 0).toLocaleString('en-US')}`,
      `  tokens out: ${(runningUsage.outputTokens || 0).toLocaleString('en-US')}`,
      `  tokens tot: ${(runningUsage.totalTokens || 0).toLocaleString('en-US')}`,
      `  turns:      ${runningUsage.turnsWithUsage || 0}`,
    );
    if (ctx.cfg && ctx.cfg.rates && typeof ctx.cfg.rates === 'object') {
      try {
        const { costFromUsage } = await import('../providers/rates.mjs');
        const r = costFromUsage(
          { provider: ctx.getActiveProvName(), model: ctx.getActiveModel(), usage: runningUsage },
          ctx.cfg.rates,
        );
        if (r && r.totalUsd != null) {
          lines.push(`  cost (USD): $${Number(r.totalUsd).toFixed(4)}`);
        }
      } catch { /* never let cost-card lookup fail the slash */ }
    }
  }
  return lines.join('\n');
}
