// tui/run_turn.mjs — shared chat-turn streaming closure (v5 Group C, C7).
//
// Single source of truth for the streaming + persist + post-task
// learning loop. The same factory backs:
//   - the ink REPL path (ReplApp.runTurn)
//   - the legacy readline path (cli.mjs's `for await (const line of rl)` body)
//
// One factory ⇒ one set of bugs. Both call sites get the same buffered
// writer (CJK-safe 30 ms coalescing), the same persistTurn dual-write
// (sessions + memory/recent), and the same fire-and-forget learning
// hook (queueMicrotask).
//
// `ctx` carries the chat-session state. Getter functions close over
// *current* bindings so a mid-session /provider switch takes effect on
// the very next turn without re-creating the closure.
//
// `writeFn` is the sink for streamed chunks — the legacy path passes
// `(s) => process.stdout.write(s)`; the ink path also writes to stdout
// for v5.0.10 (interleaves with Ink output; visual jank accepted in
// exchange for unblocking the chat loop). v5.1 TODO: route the ink
// writeFn through a scrollback ref in ReplApp.
//
// Errors are swallowed (matches v4 legacy behavior) — we write
// "error: ..." into writeFn but do not re-throw, so the caller's
// turn-completion logic (ReplApp onTurnComplete, legacy `rl.prompt`)
// runs unconditionally.

/**
 * @typedef {Object} RunTurnCtx
 * @property {Object} cfg                                  Active config.
 * @property {string} cfgDir                               Resolved configDir.
 * @property {Object|null} sandboxSpec                     Parsed --sandbox spec (or null).
 * @property {string} syntheticChatSessionId              Session-id fallback when --session not set.
 * @property {() => Array<{role:string,content:string}>} getMessages
 * @property {() => { sendMessage: Function, name?: string }} getProv
 * @property {() => string} getActiveProvName
 * @property {() => string|null} getActiveModel
 * @property {() => string|null} getSessionId
 * @property {(role: string, content: string) => void} persistTurn
 * @property {(u: any) => void} accumulateUsage
 * @property {(provider: string) => string} resolveAuthKey  Caller supplies; mirrors cli.mjs::_resolveAuthKey.
 * @property {(n: number) => void} [onCharsSent]            Optional observer (legacy path increments charsSent).
 */

/**
 * Build a runTurn(text, signal) closure that drives one provider turn
 * end-to-end.
 *
 * @param {{ ctx: RunTurnCtx, writeFn: (chunk: string) => void }} args
 * @returns {(text: string, signal?: AbortSignal) => Promise<void>}
 */
export function makeRunTurn({ ctx, writeFn }) {
  return async function runTurn(text, signal) {
    if (signal?.aborted) return;
    const messages = ctx.getMessages();
    messages.push({ role: 'user', content: text });
    try { ctx.onCharsSent && ctx.onCharsSent(text.length); }
    catch { /* observer is best-effort */ }
    ctx.persistTurn('user', text);

    let acc = '';
    let _writeBuf = '';
    let _writeTimer = null;
    const _flush = () => {
      if (_writeBuf) {
        try { writeFn(_writeBuf); }
        catch { /* sink failure must not kill the turn */ }
        _writeBuf = '';
      }
      _writeTimer = null;
    };
    const _writeChunk = (s) => {
      _writeBuf += s;
      if (!_writeTimer) _writeTimer = setTimeout(_flush, 30);
    };

    try {
      const sysMsg = messages.find((m) => m.role === 'system');
      const prov = ctx.getProv();
      const activeProvName = ctx.getActiveProvName();
      const activeModel = ctx.getActiveModel();
      // C8 — prompt-cache the static system prefix. The Anthropic
      // provider prefers `systemStatic` when present; non-Anthropic
      // providers ignore the field and fall back to the legacy
      // single-block path with `cache:true`.
      for await (const chunk of prov.sendMessage(messages, {
        apiKey: ctx.resolveAuthKey(activeProvName),
        model: activeModel,
        sandbox: ctx.sandboxSpec,
        signal,
        onUsage: ctx.accumulateUsage,
        cache: true,
        ...(sysMsg ? { systemStatic: sysMsg.content } : {}),
      })) {
        _writeChunk(chunk);
        acc += chunk;
      }
      if (_writeTimer) clearTimeout(_writeTimer);
      _flush();
      try { writeFn('\n'); }
      catch { /* sink failure must not kill the turn */ }
      messages.push({ role: 'assistant', content: acc });
      ctx.persistTurn('assistant', acc);
      // v5 Group A (C1): close the post-task learning loop on every
      // successful chat turn. Fire-and-forget via queueMicrotask so the
      // next prompt is never blocked on trajectory write / synth.
      try {
        queueMicrotask(() => {
          import('../mas/learning.mjs').then((mod) => mod.runLearning('post-task', {
            agent: { name: 'chat', provider: activeProvName, model: activeModel, role: '' },
            task: {
              id: ctx.getSessionId() || ctx.syntheticChatSessionId,
              title: '(chat turn)',
              turns: messages.slice(-2).map((m) => ({
                agent: m.role === 'user' ? 'user' : 'chat',
                text: m.content,
                ts: new Date().toISOString(),
              })),
            },
            configDir: ctx.cfgDir,
            cfg: ctx.cfg,
            transcript: acc.slice(0, 8000),
          })).catch(() => { /* learning loop is best-effort */ });
        });
      } catch { /* never let learning hook break the chat */ }
    } catch (err) {
      if (_writeTimer) clearTimeout(_writeTimer);
      _flush();
      // ABORT errors are user-initiated; drop the partial reply (don't
      // push an incomplete assistant message — next turn would treat
      // it as a complete reply and confuse the model).
      if (err?.code !== 'ABORT' && !signal?.aborted) {
        try { writeFn(`error: ${err?.message || String(err)}\n`); }
        catch { /* sink failure must not mask err */ }
      }
    }
  };
}
