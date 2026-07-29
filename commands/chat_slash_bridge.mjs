// commands/chat_slash_bridge.mjs — the Ink REPL's slash-command bridge,
// extracted out of commands/chat.mjs (file-size gate).
//
// Two responsibilities:
//   1. Translate /new, /reset and /clear into the 'NEW' sentinel tui/repl.mjs
//      acts on. _newReset itself returns a human string for the
//      string-rendering consumers, so the Ink path translates here (mirroring
//      the 'EXIT' sentinel) or the real /new never clears the screen.
//   2. Collect whatever the dispatcher streams instead of writing it straight
//      to the terminal, and return it so ReplApp commits it to scrollback.
import { dispatchSlash, parseSlashLine } from '../tui/slash_dispatcher.mjs';

/**
 * True for the reset commands that must reach tui/repl.mjs as 'NEW'.
 * Exported so the contract is unit-testable.
 */
export function _isInkResetCmd(cmd) {
  return /^\/(new|reset|clear)$/i.test(String(cmd || ''));
}

/**
 * Build ReplApp's onSlashCommand for the Ink path. Returns a string (rendered
 * to scrollback by ReplApp), 'NEW'/'EXIT' (sentinels the REPL acts on), or void.
 *
 * @param {object} ctx the in-REPL slash context (cmdChat's _inkCtx)
 */
export function makeInkSlashHandler(ctx) {
  return async (line, signal) => {
    const { cmd, args } = parseSlashLine(line);
    // Thread the REPL's abort signal so Esc/Ctrl-C can stop a /loop.
    ctx.loopSignal = signal || null;
    // Ink owns the screen: a raw process.stdout.write here lands inside the
    // live frame, and Ink cannot erase bytes it did not draw (stale rows).
    // Collect what the handler streams and let ReplApp commit it to
    // scrollback along with the handler's own return value.
    const streamed = [];
    const result = await dispatchSlash(cmd, args, ctx, (chunk) => {
      streamed.push(String(chunk));
    });
    if (_isInkResetCmd(cmd)) return 'NEW';
    if (streamed.length > 0) {
      const pre = streamed.join('');
      return typeof result === 'string' && result.length > 0 ? `${pre}${result}` : pre;
    }
    return result;
  };
}
