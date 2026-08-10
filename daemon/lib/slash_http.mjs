// daemon/lib/slash_http.mjs — run REPL slash commands over HTTP.
//
// The dispatcher is the single write path for the dashboard, so this file is
// a translation layer and nothing more: no command logic lives here, and
// tui/slash_dispatcher.mjs is not modified. What it translates:
//
//   · output   — handlers stream through write() and/or return a string; both
//                become `lines`, in the order they were produced. Over the
//                streaming entry point the SAME lines are also handed to
//                onLine as they are produced, instead of only at the end.
//   · sentinels— 'EXIT' and 'NEW' are things the REPL does to itself. Over
//                HTTP they are neither output nor errors — UNLESS the
//                handler also set one of FOREGROUND_ACTION_FLAGS below, which
//                means it wants an interactive step the REPL host runs after
//                unmounting (commands/chat.mjs:336-338). This adapter has no
//                such host, so that combination is reported as an honest
//                failure instead of a silent no-op success.
//   · ctx      — building the per-request ctx (config snapshot, picker
//                stand-in, persist-and-verify setters) is a separate concern,
//                split out to ./slash_ctx.mjs so this file stays about
//                deciding whether a line may run, not about ctx internals.
//   · danger   — destructive lines are intercepted BEFORE dispatch and
//                answered with a token; see daemon/lib/slash_destructive.mjs.
//   · session  — /skill and /goal's switch branch persist by mutating
//                ctx.getMessages()/setMessages() and ctx.getSessionId(), i.e.
//                "the active chat session" — a concept this stateless,
//                one-shot endpoint does not have. Rather than let the
//                dispatcher's success strings ("active skills: X", "✓
//                switched to goal: X") claim a change that evaporates the
//                moment this request ends, those are refused before dispatch
//                too. Contrast /provider <name> and /model <name>, which
//                persist to config.json (a real, global, disk-backed value)
//                via setActiveProvName/setActiveModel (./slash_ctx.mjs) —
//                those DO work.
//   · host     — /dashboard (whole command) and /gateway start|stop spawn or
//                kill a process on whatever machine is running THIS daemon,
//                not the caller's. Refused before dispatch (like /skill/
//                /goal above), by the named HOST_PROCESS_COMMANDS table, so
//                an HTTP caller can't make the daemon's host pop a browser
//                window or SIGTERM/pkill a process on it just by sending a
//                slash command. /gateway status and /gateway port are left
//                to reach dispatch — neither touches a process.
//   · streaming— every guard above applies IDENTICALLY whether the caller
//                used run() or runStreaming(): both call the SAME
//                prepareDispatch() to decide if a line may run and what ctx
//                it gets, and the SAME finalizeEnvelope() to decide the
//                outcome once dispatch returns. The only difference between
//                the two entry points is where the produced lines go (an
//                array vs. also an onLine callback) — see makeSlashRunner.
import { dispatchSlash as _dispatchSlash, parseSlashLine, SLASH_HANDLERS } from '../../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../../tui/slash_commands.mjs';
import { destructivePrompt } from './slash_destructive.mjs';
import { buildHttpCtx } from './slash_ctx.mjs';

export { buildHttpCtx };

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

// Commands that can run long enough that buffering their output would make
// the dashboard look hung. Checked, not assumed, against the real handlers
// in tui/slash_dispatcher.mjs (see the task-5 report, including fix round 1):
//   - /loop iterates a real provider call and streams through write() for as
//     long as the operator lets it run.
//   - /task tick runs one multi-agent router turn (mas/mention_router.mjs's
//     runTaskTurn), which can itself run several agent turns and streams its
//     logger output through write() the same way /loop streams its chunks.
//     Only the `tick` subcommand is long — list/show/start/abandon/done/
//     remove are single fast disk ops — but STREAMING is per top-level
//     command (same granularity /loop already used, which also has an
//     instant bare-args usage branch); the fast subcommands are unaffected
//     because a caller only sees SSE when it explicitly asks for it.
// /agent and /team are excluded: both are registry CRUD (list/show/add/edit/
// remove/member), each a single fast call, so buffering them is not the
// "looks hung" problem this set exists to fix. /workflow (task 14) IS a real
// SLASH_HANDLERS key now, but its handler (tui/slash_workflow.mjs) takes no
// `write` parameter at all — run/resume await one runNamedWorkflow() call and
// return a single string, the same shape as /agent's and /team's CRUD
// branches, not /loop's per-chunk provider stream or /task tick's per-turn
// logger. Nothing /workflow produces ever reaches `write`, so adding it here
// would upgrade the connection to SSE for a command that can never emit more
// than one line on it — the exact "STREAMING entry that cannot stream"
// mistake already found once in this phase.
export const STREAMING = new Set(['/loop', '/task']);

// /skill and /skills (which forwards to the same _skill body once it has an
// arg) persist a composed system prompt only via ctx.setMessages() and — if
// there is one — a session file keyed by ctx.getSessionId(). /goal's bare
// `/goal <name>` branch (as opposed to add|list|show|close, which persist
// through goals.mjs's own disk-backed store and are fine) persists the
// switch the same way. Neither has anything to persist INTO here: this
// endpoint has no notion of "the active chat" at all, so both would silently
// no-op and still report success. Their no-arg branches (list/usage text)
// are read-only and honest, so only a non-empty invocation is refused.
function needsLiveSession(cmd, args) {
  const a = String(args || '').trim();
  if (!a) return false;
  if (cmd === '/skill' || cmd === '/skills') return true;
  if (cmd === '/goal') {
    const first = a.split(/\s+/)[0].toLowerCase();
    return !['add', 'list', 'show', 'close'].includes(first);
  }
  return false;
}

// Rule: any slash command that would spawn, kill, or shell out to a process
// on the machine hosting THIS daemon — rather than merely reading status or
// writing a config value — is refused over this one-shot HTTP endpoint. The
// caller is a browser talking to the daemon, not a shell on the daemon's own
// host, so letting one of these reach dispatch would let a dashboard user
// make the SERVER pop a browser window or kill a process on it.
//
// This is a named table, not a literal chain, because the set is an audit
// finding, not an enumeration anyone should trust by inspection: it was
// built by grepping every module reachable from SLASH_HANDLERS for
// `child_process` (`grep -rn "from 'node:child_process'\|import('node:child_process')"
// tui/*.mjs commands/*.mjs`), which finds exactly tui/slash_dashboard.mjs
// (/dashboard) and tui/slash_gateway.mjs (/gateway start) — but /gateway
// stop reaches the same class one layer deeper, through
// commands/gateway.mjs's gatewayStop -> process.kill(pid, ...) on a real
// pidfile'd process, WITHOUT importing child_process itself, so the grep
// alone does not find it; it was added by reading the handler body. A
// future command that reaches process.kill/spawn/execFile through a helper
// rather than importing child_process directly needs the same read-the-body
// check, not just a repeat of this grep.
//
// null = every subcommand (or bare form) of a command is host-only.
// Set(...) = only these first-token subcommands are (e.g. /gateway status
// and /gateway port persist a config value / read status — no process is
// touched, so they are left to reach dispatch normally).
const HOST_PROCESS_COMMANDS = new Map([
  ['/dashboard', null],
  ['/gateway', new Set(['start', 'stop'])],
]);

function needsHostProcess(cmd, args) {
  if (!HOST_PROCESS_COMMANDS.has(cmd)) return false;
  const gatedSubs = HOST_PROCESS_COMMANDS.get(cmd);
  if (gatedSubs === null) return true;
  const first = String(args || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  return gatedSubs.has(first);
}

// Every ctx.request* flag a handler can set to ask the REPL host to run an
// interactive step AFTER it unmounts on 'EXIT' (commands/chat.mjs:336-338) —
// /setup's full wizard, /config's or /channels setup's single-item wizard
// step, and /login's (or /provider's) foreground CLI-login flow. This
// adapter has no REPL host, so none of those steps ever run — an 'EXIT'
// paired with any of these flags must NOT collapse to the ordinary
// {ok:true, lines:[]} envelope, or the caller is told a login/setup step
// succeeded when nothing happened.
//
// This list is not guessed: derived by grepping every module reachable from
// SLASH_HANDLERS for an assignment to ctx.request*,
//   grep -rn "ctx\.request[A-Za-z]*\s*=" tui/*.mjs commands/*.mjs
// which finds exactly these four sites — tui/slash_dispatcher.mjs's inline
// /setup handler (requestSetup), tui/config_picker.mjs (requestSetup and
// requestConfigStep), tui/slash_channels.mjs's /channels setup no-picker
// fallback (requestConfigStep), and tui/login_flow.mjs (requestLogin) — over
// these three distinct flag names. A handler that adds a FOURTH flag NAME
// and returns 'EXIT' needs to be added here too — re-run that grep and diff
// its output against this array.
const FOREGROUND_ACTION_FLAGS = ['requestSetup', 'requestConfigStep', 'requestLogin'];

// The ONE place that decides whether a line may run and what ctx it gets.
// Both run() and runStreaming() call this before touching dispatch — a guard
// added or fixed here applies to both entry points automatically, because
// neither has its own copy of this decision. Returns either
// { ok:false, envelope } to send straight back without dispatching, or
// { ok:true, cmd, args, ctx } ready to hand to dispatch.
function prepareDispatch({ line, confirm, cfgDir, confirmStore, workflowStateDir }) {
  const raw = typeof line === 'string' ? line.trim() : '';
  if (!raw.startsWith('/')) return { ok: false, envelope: fail('a slash command is required, e.g. /status') };

  const { cmd, args } = parseSlashLine(raw);

  if (needsLiveSession(cmd, args)) {
    return {
      ok: false,
      envelope: {
        ok: false,
        code: 'NO_SESSION',
        error: `${cmd} changes the active chat session, but this endpoint runs each command as a one-shot call with no session behind it — nothing was saved.`,
        hint: 'this command only works from an interactive chat session (the terminal REPL), not a one-shot HTTP call',
      },
    };
  }

  if (needsHostProcess(cmd, args)) {
    const sub = args.trim().split(/\s+/)[0];
    const label = sub ? `${cmd} ${sub}` : cmd;
    return {
      ok: false,
      envelope: {
        ok: false,
        code: 'NEEDS_TERMINAL',
        error: `${label} spawns or kills a process on the machine running this daemon, not on the machine making this HTTP request — refused before it could run.`,
        hint: `run \`pompos\` in a terminal on the machine you want this to act on, and use ${label} there`,
      },
    };
  }

  let autoApprove = false;
  const prompt = destructivePrompt(cmd, args);
  if (prompt) {
    if (!confirmStore.redeem(confirm, raw)) {
      return { ok: false, envelope: { ok: false, code: 'CONFIRM_REQUIRED', prompt, token: confirmStore.issue(raw) } };
    }
    autoApprove = true;
  }

  let ctx;
  try {
    ctx = buildHttpCtx({ cfgDir, autoApprove, workflowStateDir });
  } catch (err) {
    return { ok: false, envelope: fail(err?.message || err, 'CONFIG_DIR_MISMATCH') };
  }

  return { ok: true, cmd, args, ctx };
}

// The other shared decision: once dispatch has returned (lines already
// collected via the caller's own emit sink), what envelope does the caller
// get? Same for run() and runStreaming() — a persist failure or a stranded
// foreground-action flag is a refusal regardless of whether the output was
// streamed or buffered. `emit` is how the trailing return-value line (if any)
// joins `lines` — for run() that only pushes; for runStreaming() it also
// reaches onLine, exactly like every line produced during dispatch did.
function finalizeEnvelope({ cmd, ctx, lines, result, emit }) {
  if (ctx.__persistFailed) {
    // Set by setActiveProvName/setActiveModel (./slash_ctx.mjs) when
    // /provider or /model's setter ran but the value did not actually land
    // on disk. The handler already built and returned its "provider → X"
    // success string — we are refusing to let THAT out, not reporting a
    // dispatch error.
    return { ok: false, code: 'PERSIST_FAILED', error: ctx.__persistFailed };
  }
  if (result === 'EXIT' && FOREGROUND_ACTION_FLAGS.some((flag) => ctx[flag])) {
    // The dispatcher's own contract for this combination (see
    // commands/chat.mjs:336-338) is "unmount, then the REPL host runs an
    // interactive step". There is no REPL host here, so the step never
    // runs — collapsing this to the ordinary {ok:true, lines:[]} EXIT
    // envelope would report success for something that did nothing.
    return {
      ok: false,
      code: 'NEEDS_TERMINAL',
      error: `${cmd} needs an interactive step that only runs in the terminal REPL — this HTTP endpoint cannot run it.`,
      hint: 'run `pompos` in a terminal and use /setup, the matching /config item, or /login there',
    };
  }
  if (typeof result === 'string' && result !== 'EXIT' && result !== 'NEW' && result.length) emit(result);
  return { ok: true, lines };
}

export function makeSlashRunner({ cfgDir, confirmStore, dispatch = _dispatchSlash, workflowStateDir }) {
  return {
    async run({ line, confirm } = {}) {
      const prep = prepareDispatch({ line, confirm, cfgDir, confirmStore, workflowStateDir });
      if (!prep.ok) return prep.envelope;
      const { cmd, args, ctx } = prep;

      const lines = [];
      const emit = (chunk) => { lines.push(String(chunk)); };
      let result;
      try {
        result = await dispatch(cmd, args, ctx, emit);
      } catch (err) {
        return fail(err?.message || err);
      }
      return finalizeEnvelope({ cmd, ctx, lines, result, emit });
    },

    /**
     * Same contract as run(), but each line is handed to onLine the moment it
     * is produced — including the handler's trailing return value, so a
     * caller watching onLine sees the complete output as it happens, not
     * just the streamed-through-write() part. The envelope still carries the
     * full list, so a caller that missed the start is not left with a
     * partial record.
     */
    async runStreaming({ line, confirm, onLine } = {}) {
      const prep = prepareDispatch({ line, confirm, cfgDir, confirmStore, workflowStateDir });
      if (!prep.ok) return prep.envelope;
      const { cmd, args, ctx } = prep;

      const lines = [];
      const emit = (chunk) => { const s = String(chunk); lines.push(s); onLine?.(s); };
      let result;
      try {
        result = await dispatch(cmd, args, ctx, emit);
      } catch (err) {
        return fail(err?.message || err);
      }
      return finalizeEnvelope({ cmd, ctx, lines, result, emit });
    },
  };
}
