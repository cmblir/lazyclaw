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

import { Chalk } from 'chalk';
import { chatAgenticGet, chatPlanModeGet, effectiveChatTools } from '../config_features.mjs';
import { defaultSandboxSpec } from '../sandbox/index.mjs';

// Force ANSI on these turn-status markers regardless of stdout TTY detection:
// the Ink path routes them through React state (Ink preserves embedded SGR
// and decides display), and the legacy stdout path always targets a terminal
// for chat. Without forcing, chalk's auto-level strips color under the
// non-TTY test/pipe sink and the red error / dim abort marker vanish.
const _statusChalk = new Chalk({ level: 1 });

// Classify a provider/turn error into a one-line actionable hint (or '' when
// none applies). Checked auth → model → network so one hint at most. Advisory
// only — rendered dim under the red error line.
function _errorHint(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status;
  const code = err?.code;
  if (status === 401 || status === 403 || /\b(401|403|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|authentication|no api key|missing api key)\b/i.test(msg)) {
    return 'hint: set a key with /provider, or `lazyclaw auth add <provider>`';
  }
  if (status === 404 || /\b(404|model[ _-]?not[ _-]?found|no such model|unknown model|model .* does not exist|not_found_error)\b/i.test(msg)) {
    return 'hint: run /model to pick a valid model';
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN'
      || /\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network|fetch failed|socket hang up|getaddrinfo)\b/i.test(msg)) {
    return 'hint: check your connection / base URL (/provider to review the endpoint)';
  }
  return '';
}

// Plan-mode addendum — instructs the model to propose, not mutate. Appended
// to the synthetic chat agent's system prompt only while plan mode is ON.
const PLAN_MODE_ADDENDUM = 'You are in PLAN mode. Propose a plan; do not mutate '
  + 'anything. List the steps you would take and the tools you would use, then stop.';

// Per-turn recall injection (roadmap #7). The streaming chat path sends a fixed
// system prompt, so it never surfaced context relevant to THIS message (only the
// agentic path, which rebuilds the prompt stack per turn, did). Prepend a fresh
// recall layer to the CURRENT user message — not the system — because a warm
// claude-cli persistent session fixes its system at spawn, and every provider
// reads the user turn. Transient: returns a COPY for the send; the stored
// session keeps the original message. recallLayer is injected (lazy-imported by
// the caller) so better-sqlite3 stays off this module's static graph.
export function _injectRecall(messages, cfgDir, recallLayerFn) {
  try {
    if (typeof recallLayerFn !== 'function' || !Array.isArray(messages)) return messages;
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') { idx = i; break; }
    }
    if (idx < 0) return messages;
    const layer = recallLayerFn(cfgDir, String(messages[idx].content || ''), 5);
    if (!layer || !String(layer).trim()) return messages;
    return messages.map((m, i) => (i === idx ? { ...m, content: `${layer}\n\n${m.content}` } : m));
  } catch { return messages; }
}

// Fire the post-task learning loop on every successful chat turn (v5 Group A
// C1). Fire-and-forget via queueMicrotask so the next prompt is never blocked
// on trajectory write / synth. Shared by the streaming and agentic paths.
// Decide whether a chat turn is worth a learning pass. The hook otherwise
// spawns TWO extra `claude` processes (skill synth + user-model) on EVERY turn,
// tripling per-message spawns and competing with the user's next turn for the
// subscription. Skip greetings/acks, trivially short exchanges, and empty
// (aborted/failed) replies — none warrant a durable SKILL.md or a user model.
export function _shouldLearn(messages) {
  const last2 = (messages || []).slice(-2);
  const user = String(last2.find((m) => m && m.role === 'user')?.content || '').trim();
  const reply = String(last2.find((m) => m && m.role !== 'user')?.content || '').trim();
  if (!reply) return false;
  if ((user + ' ' + reply).trim().length < 280) return false;
  if (/^(hi|hey|hello|yo|thanks|thank you|thx|ty|ok|okay|k|sure|nice|cool|got it|ㅇㅇ|ㄱㅅ|ㄳ|고마워|감사|안녕|넵|네)\b/i.test(user)) return false;
  return true;
}

function _fireLearningHook(ctx, messages, activeProvName, activeModel, transcript) {
  try {
    if (!_shouldLearn(messages)) return;
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
        transcript: String(transcript || '').slice(0, 8000),
      })).catch(() => { /* learning loop is best-effort */ });
    });
  } catch { /* never let learning hook break the chat */ }
}

// Drive one agentic chat turn through the MAS tool loop. Builds the synthetic
// chat agent record, renders compact tool-activity status lines + the final
// answer into writeChunk, and returns the final assistant text. The approval
// hook is taken from ctx.approve when present (Ink: _makeInkApprove, legacy:
// makeReadlineApprove) — when absent the fail-closed gate in tool_runner.mjs
// simply denies any sensitive tool (no silent ungated execution).
async function _runAgenticTurn({ ctx, messages, sysMsg, activeProvName, activeModel, planMode, writeChunk, signal }) {
  const runAgentTurn = ctx.runAgentTurnImpl
    || (await import('../mas/agent_turn.mjs')).runAgentTurn;
  const tools = effectiveChatTools(ctx.cfg, { planMode });
  let role = (sysMsg && sysMsg.content) || '';
  if (planMode) role = role ? `${role}\n\n${PLAN_MODE_ADDENDUM}` : PLAN_MODE_ADDENDUM;
  const agent = { name: 'chat', provider: activeProvName, model: activeModel, role, tools };
  // History excludes the just-pushed user message and the system slot (the
  // latter is threaded via agent.role); runAgentTurn appends userMessage.
  const history = messages
    .slice(0, -1)
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  const userMessage = messages[messages.length - 1]?.content || '';
  let result;
  try {
    result = await runAgentTurn({
      agent, userMessage, history,
      configDir: ctx.cfgDir,
      apiKey: ctx.resolveAuthKey(activeProvName),
      approve: ctx.approve,
      security: ctx.cfg?.security,
      // Default-on isolation: an explicit --sandbox spec wins; otherwise confine
      // by default (cwd-confined fs, secrets blocked, net allowed). Opt out via
      // cfg.sandbox.confine=false → defaultSandboxSpec returns null (bare).
      sandbox: ctx.sandboxSpec || defaultSandboxSpec(ctx.cfg, { cwd: process.cwd(), configDir: ctx.cfgDir }),
      cache: true,
      usePromptStack: false,
      signal,
    });
  } catch (err) {
    // No silent catch — surface as a status line; return empty so the caller
    // still completes the turn (persist + learning) without a half reply.
    try { writeChunk(`· agentic turn failed: ${err?.message || String(err)}\n`); } catch { /* sink */ }
    return '';
  }
  // Compact tool-activity status lines (dim, not the red provider-error style).
  for (const c of (result.toolCalls || [])) {
    const ok = c.ok ? '✓' : '⚠';
    try { writeChunk(`· ${ok} ${c.name}\n`); } catch { /* sink */ }
  }
  if (result.stoppedBy === 'budget') {
    try { writeChunk(`· stopped after ${result.iterations} tool step(s)\n`); } catch { /* sink */ }
  }
  const text = result.text || '';
  if (text) { try { writeChunk(text); } catch { /* sink */ } }
  return text;
}

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
      // Group 1 — agentic REPL. When cfg.chat.agentic (or plan mode) is ON,
      // route the turn through the MAS tool loop (runAgentTurn) instead of
      // the streaming sendMessage path. Plan mode forces agentic-on for the
      // turn (read-only). Everything else (persistTurn, the post-task
      // learning hook below) is shared. When OFF — the default — the
      // streaming path below runs UNCHANGED.
      const planMode = chatPlanModeGet(ctx.cfg);
      if (chatAgenticGet(ctx.cfg) || planMode) {
        const acc2 = await _runAgenticTurn({
          ctx, messages, sysMsg, activeProvName, activeModel, planMode,
          writeChunk: _writeChunk, signal,
        });
        if (_writeTimer) clearTimeout(_writeTimer);
        _flush();
        try { writeFn('\n'); } catch { /* sink failure must not kill the turn */ }
        messages.push({ role: 'assistant', content: acc2 });
        ctx.persistTurn('assistant', acc2);
        _fireLearningHook(ctx, messages, activeProvName, activeModel, acc2);
        return;
      }
      // Configurable max-output-tokens (config.json `maxTokens`). Only
      // thread it through when it's a positive finite number; otherwise
      // leave opts.maxTokens unset so each provider's DEFAULT_MAX_TOKENS
      // applies.
      const cfgMaxTokens = ctx.cfg?.maxTokens;
      const maxTokens = (typeof cfgMaxTokens === 'number' && Number.isFinite(cfgMaxTokens) && cfgMaxTokens > 0)
        ? cfgMaxTokens
        : undefined;
      // Roadmap #7 — per-turn recall: surface context relevant to THIS message
      // by prepending a fresh recall layer to the current user turn (off via
      // cfg.chat.recall=false). Best-effort + lazy-imported so an empty/missing
      // index never blocks a reply and better-sqlite3 stays off the static graph.
      let sendMessages = messages;
      if (ctx.cfg?.chat?.recall !== false) {
        try {
          const { recalledLayer } = await import('../mas/prompt_stack.mjs');
          sendMessages = _injectRecall(messages, ctx.cfgDir, recalledLayer);
        } catch { /* recall is best-effort — never block a turn */ }
      }
      // C8 — prompt-cache the static system prefix. The Anthropic
      // provider prefers `systemStatic` when present; non-Anthropic
      // providers ignore the field and fall back to the legacy
      // single-block path with `cache:true`.
      let truncated = false;
      for await (const chunk of prov.sendMessage(sendMessages, {
        apiKey: ctx.resolveAuthKey(activeProvName),
        model: activeModel,
        sandbox: ctx.sandboxSpec,
        signal,
        onUsage: ctx.accumulateUsage,
        // Streaming providers fire this when a turn hits the model's output-token
        // limit (finish_reason 'length' / MAX_TOKENS / stop_reason 'max_tokens' /
        // done_reason 'length'). Warn the user instead of presenting a truncated
        // answer as complete, mirroring the agentic path (mas/agent_turn.mjs).
        onTruncated: () => { truncated = true; },
        cache: true,
        // Opt-in (cfg.chat.persistentSession): reuse one warm `claude` per
        // conversation so the harness boots once, not every turn. claude-cli-
        // only opts (other providers ignore them); the provider falls back to
        // the one-shot spawn on any session failure.
        persistent: ctx.cfg?.chat?.persistentSession === true,
        sessionKey: (ctx.getSessionId && ctx.getSessionId()) || ctx.syntheticChatSessionId,
        ...(sysMsg ? { sessionSystem: sysMsg.content } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(sysMsg ? { systemStatic: sysMsg.content } : {}),
      })) {
        _writeChunk(chunk);
        acc += chunk;
      }
      if (_writeTimer) clearTimeout(_writeTimer);
      _flush();
      try { writeFn('\n'); }
      catch { /* sink failure must not kill the turn */ }
      if (truncated) {
        try { writeFn('[truncated — the model hit its output-token limit; raise maxTokens]\n'); }
        catch { /* sink failure must not kill the turn */ }
      }
      messages.push({ role: 'assistant', content: acc });
      ctx.persistTurn('assistant', acc);
      _fireLearningHook(ctx, messages, activeProvName, activeModel, acc);
    } catch (err) {
      if (_writeTimer) clearTimeout(_writeTimer);
      _flush();
      // ABORT errors are user-initiated; drop the partial reply (don't
      // push an incomplete assistant message — next turn would treat
      // it as a complete reply and confuse the model). Emit a visible dim
      // [aborted] marker so the output doesn't just silently stop (the
      // host onTurnComplete sees reason:'done' because we swallow ABORT).
      if (err?.code === 'ABORT' || signal?.aborted) {
        try { writeFn(`${_statusChalk.dim('[aborted]')}\n`); }
        catch { /* sink failure must not kill the turn */ }
      } else {
        // Provider errors render in the red error style (not normal amber
        // assistant text — the audit gap). The red SGR is embedded so the
        // Ink scrollback <Text> preserves it and the legacy stdout path shows it.
        try { writeFn(`${_statusChalk.red(`error: ${err?.message || String(err)}`)}\n`); }
        catch { /* sink failure must not mask err */ }
        const _hint = _errorHint(err);
        if (_hint) { try { writeFn(`${_statusChalk.dim(_hint)}\n`); } catch { /* sink */ } }
      }
    }
  };
}
