// daemon/lib/slash_http.mjs — run REPL slash commands over HTTP.
//
// The dispatcher is the single write path for the dashboard, so this file is
// a translation layer and nothing more: no command logic lives here, and
// tui/slash_dispatcher.mjs is not modified. What it translates:
//
//   · output   — handlers stream through write() and/or return a string; both
//                become `lines`, in the order they were produced.
//   · sentinels— 'EXIT' and 'NEW' are things the REPL does to itself. Over
//                HTTP they are neither output nor errors.
//   · pickers  — every ctx.openPicker call site in the dispatcher is guarded
//                by `typeof ctx.openPicker === 'function'`, so OMITTING it is
//                what selects each handler's text fallback. The one exception
//                is a redeemed confirmation, where we supply an approving
//                picker so _promptConfirm (which returns false without one)
//                does not turn a confirmed delete into "cancelled".
//   · danger   — destructive lines are intercepted BEFORE dispatch and
//                answered with a token; see daemon/lib/slash_destructive.mjs.
import { dispatchSlash as _dispatchSlash, parseSlashLine, SLASH_HANDLERS } from '../../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../../tui/slash_commands.mjs';
import { destructivePrompt } from './slash_destructive.mjs';
import { readConfig, writeConfig } from '../../lib/config.mjs';

/**
 * The slash ctx for HTTP callers.
 *
 * @param {{cfgDir: string, autoApprove?: boolean}} opts
 *   autoApprove is set only when replaying a confirmed line.
 */
export function buildHttpCtx({ cfgDir, autoApprove = false }) {
  const ctx = {
    cfgDir,
    // readConfig/writeConfig resolve the directory from POMPOS_CONFIG_DIR
    // themselves (see lib/config.mjs) rather than taking one as an argument —
    // same call shape commands/chat.mjs uses for its ctx.
    readConfig: () => readConfig(),
    writeConfig: (next) => writeConfig(next),
    // /status, /usage, /provider, /model and /skill call these unconditionally
    // (no `typeof` guard, unlike ctx.openPicker), so omitting them would turn
    // an ordinary status/info command into a crash rather than a text
    // fallback. A one-shot HTTP call has no live chat turn behind it, so the
    // honest values are the persisted provider/model and an empty session —
    // same source commands/chat.mjs seeds activeProvName/activeModel from.
    getActiveProvName: () => readConfig().provider || null,
    getActiveModel: () => readConfig().model || null,
    getMessages: () => [],
    getSessionId: () => null,
  };
  if (autoApprove) {
    // The operator already answered this question at the HTTP layer; the
    // handler's own prompt is the second half of the same decision.
    ctx.openPicker = async ({ items } = {}) => {
      const approve = (items || []).find((i) => i && i.id === 'approve');
      return approve || (items && items[0]) || { id: 'approve' };
    };
  }
  return ctx;
}

/** The command list the dashboard's autocomplete reads. */
export function listCommands() {
  // SLASH_COMMANDS entries are { cmd, help } (see tui/slash_commands.mjs) —
  // built from SLASH_HANDLERS' keys rather than the other way round, so a
  // command missing from the catalog just gets an empty description instead
  // of dropping out of the list the dashboard needs to mirror exactly.
  const described = new Map((SLASH_COMMANDS || []).map((c) => [c.cmd, c.help || '']));
  return [...SLASH_HANDLERS.keys()].map((name) => ({
    name,
    description: described.get(name) || '',
  }));
}

function fail(error, code = 'SLASH_ERR') {
  return { ok: false, error: String(error), code };
}

export function makeSlashRunner({ cfgDir, confirmStore, dispatch = _dispatchSlash }) {
  return {
    async run({ line, confirm } = {}) {
      const raw = typeof line === 'string' ? line.trim() : '';
      if (!raw.startsWith('/')) return fail('a slash command is required, e.g. /status');

      const { cmd, args } = parseSlashLine(raw);
      let autoApprove = false;

      const prompt = destructivePrompt(cmd, args);
      if (prompt) {
        if (!confirmStore.redeem(confirm, raw)) {
          return { ok: false, code: 'CONFIRM_REQUIRED', prompt, token: confirmStore.issue(raw) };
        }
        autoApprove = true;
      }

      const lines = [];
      const ctx = buildHttpCtx({ cfgDir, autoApprove });
      let result;
      try {
        result = await dispatch(cmd, args, ctx, (chunk) => { lines.push(String(chunk)); });
      } catch (err) {
        return fail(err?.message || err);
      }
      if (typeof result === 'string' && result !== 'EXIT' && result !== 'NEW' && result.length) {
        lines.push(result);
      }
      return { ok: true, lines };
    },
  };
}
