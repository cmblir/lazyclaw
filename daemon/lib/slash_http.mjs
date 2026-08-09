// daemon/lib/slash_http.mjs — run REPL slash commands over HTTP.
//
// The dispatcher is the single write path for the dashboard, so this file is
// a translation layer and nothing more: no command logic lives here, and
// tui/slash_dispatcher.mjs is not modified. What it translates:
//
//   · output   — handlers stream through write() and/or return a string; both
//                become `lines`, in the order they were produced.
//   · sentinels— 'EXIT' and 'NEW' are things the REPL does to itself. Over
//                HTTP they are neither output nor errors — UNLESS the
//                handler also set ctx.requestSetup/requestConfigStep, which
//                means it wants an interactive wizard step the REPL host runs
//                after unmounting (commands/chat.mjs:336-338). This adapter
//                has no such host, so that combination is reported as an
//                honest failure instead of a silent no-op success.
//   · pickers  — every ctx.openPicker call site in the dispatcher is guarded
//                by `typeof ctx.openPicker === 'function'`, so OMITTING it is
//                what selects each handler's text fallback. The one exception
//                is a redeemed confirmation, where we supply an approving
//                picker so _promptConfirm (which returns false without one)
//                does not turn a confirmed delete into "cancelled".
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
//                via setActiveProvName/setActiveModel below — those DO work.
//   · host     — /dashboard (whole command) and /gateway start|stop spawn or
//                kill a process on whatever machine is running THIS daemon,
//                not the caller's. Refused before dispatch (like /skill/
//                /goal above), by the named HOST_PROCESS_COMMANDS table, so
//                an HTTP caller can't make the daemon's host pop a browser
//                window or SIGTERM/pkill a process on it just by sending a
//                slash command. /gateway status and /gateway port are left
//                to reach dispatch — neither touches a process.
import fs from 'node:fs';
import { dispatchSlash as _dispatchSlash, parseSlashLine, SLASH_HANDLERS } from '../../tui/slash_dispatcher.mjs';
import { SLASH_COMMANDS } from '../../tui/slash_commands.mjs';
import { destructivePrompt } from './slash_destructive.mjs';
import { readConfig, writeConfig, persistActiveProvider, persistActiveModel, configPath } from '../../lib/config.mjs';

// readConfig() (lib/config.mjs) prints a multi-line stderr diagnostic every
// time it is called against a present-but-corrupt config.json — reasonable
// for a rare, one-off CLI invocation, but this ctx is rebuilt on every HTTP
// request, so an operator running with a corrupt config would get that block
// logged once per request — even for a command like /help that never ends up
// needing it — until they fix the file. Remember the outcome per (path,
// mtime) so the diagnostic only fires again once the file actually changes.
// Only the FAILURE is cached: an Error is safe to share read-only across
// requests, but a successful parse is NOT cached here — lib/config.mjs
// already caches that internally (by the same path+mtime key) and a fresh
// call returns an independent clone, so sharing one object across requests
// would risk one request's ctx.writeConfig mutating another's ctx.cfg.
const _lastCorruptAttempt = new Map(); // configPath() -> { mtimeMs, error }
function loadConfigOrThrow() {
  const p = configPath();
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(p).mtimeMs; } catch { /* missing file — readConfig() below just returns {} */ }
  const cached = _lastCorruptAttempt.get(p);
  if (cached && cached.mtimeMs === mtimeMs) throw cached.error;
  try {
    return readConfig();
  } catch (err) {
    _lastCorruptAttempt.set(p, { mtimeMs, error: err });
    throw err;
  }
}

// readConfig()/writeConfig() (lib/config.mjs) resolve the config directory
// from process.env.POMPOS_CONFIG_DIR internally — cfgDir is never passed
// into them, so it is NOT what makes them operate on cfgDir. (cfgDir IS
// load-bearing for every handler that reads/writes disk state off ctx.cfgDir
// directly instead — memory.mjs, agents.mjs, teams.mjs, tasks.mjs, goals.mjs,
// skills.mjs, the personalities dir, … — just not for config.json.) The only
// thing that makes readConfig/writeConfig agree with cfgDir is the caller
// keeping POMPOS_CONFIG_DIR in sync with it before calling run(). Fail loudly
// on drift rather than silently reading/writing config.json in one directory
// while every other handler reads/writes cfgDir in another — the same "wrote
// to the wrong place but reported success" shape as the /skill bug this file
// used to have.
function assertCfgDirMatchesEnv(cfgDir) {
  const active = process.env.POMPOS_CONFIG_DIR;
  if (cfgDir && active !== cfgDir) {
    throw new Error(
      `slash_http: cfgDir (${cfgDir}) does not match POMPOS_CONFIG_DIR (${active}) — ` +
      'readConfig/writeConfig would read or write the wrong directory. The caller must ' +
      'set process.env.POMPOS_CONFIG_DIR = cfgDir before calling run().',
    );
  }
}

/**
 * The slash ctx for HTTP callers.
 *
 * @param {{cfgDir: string, autoApprove?: boolean}} opts
 *   autoApprove is set only when replaying a confirmed line.
 */
export function buildHttpCtx({ cfgDir, autoApprove = false }) {
  assertCfgDirMatchesEnv(cfgDir);
  // One real config snapshot for the life of this request — not a getter
  // that re-reads disk on every access. Handlers mutate it in place (the
  // same "mirror onto ctx.cfg" pattern commands/chat.mjs relies on, e.g.
  // tui/slash_dispatcher.mjs:156-158) and ctx.writeConfig (below) re-syncs it
  // with whatever was just persisted, so a later read in the SAME request —
  // even from a handler that wrote via its own fresh readConfig() copy
  // instead of mutating this object, e.g. providers/auth_store.mjs — never
  // sees stale data. Without this, /status prints a blank api-key line on a
  // config that has one (tui/slash_basics.mjs:22 reads ctx.cfg unconditionally).
  //
  // A PRESENT-BUT-CORRUPT config.json makes readConfig() throw ConfigError
  // (lib/config.mjs) — this is caught HERE, separately from the cfgDir/env
  // check above, for two reasons: (1) a command that never touches config at
  // all (e.g. /help) must still work — it must not be held hostage by a file
  // it never reads — and (2) when a command DOES need config, the resulting
  // failure must say the FILE is unparseable (ConfigError's own message
  // already names the path and the parse error), not be mislabelled as a
  // cfgDir/env mismatch that never happened. So a load failure here does not
  // throw out of buildHttpCtx; it is deferred to the specific accessors that
  // actually need a successfully-parsed config, re-thrown at the point of use.
  let cfg = null;
  let configLoadError = null;
  try {
    cfg = loadConfigOrThrow();
  } catch (err) {
    configLoadError = err;
  }
  const ctx = {
    cfgDir,
    // Guarded reads throughout the dispatcher (`ctx.cfg && ...`) degrade the
    // same way they already do for a MISSING config.json — undefined, not a
    // crash. Only the accessors below, which represent an explicit "give me
    // the config" request, surface the real parse error.
    cfg: cfg || undefined,
    readConfig: () => readConfig(), // always a live re-read; still throws the real ConfigError if still corrupt
    writeConfig: (next) => {
      writeConfig(next);
      if (cfg) { // nothing to keep in sync if the initial read never produced an object
        for (const k of Object.keys(cfg)) delete cfg[k];
        Object.assign(cfg, next);
      }
    },
    // /status, /usage, /provider, /model and /skill call these unconditionally
    // (no `typeof` guard, unlike ctx.openPicker), so omitting them would turn
    // an ordinary status/info command into a crash rather than a text
    // fallback. Backed by the SAME `cfg` object above, not a fresh disk read,
    // so an in-place ctx.cfg mutation elsewhere is reflected here too. When
    // the initial load failed, these re-throw that SAME error rather than
    // reporting "no provider configured" — that would be a different, untrue
    // claim (we don't know the provider; we know the file is broken).
    getActiveProvName: () => { if (configLoadError) throw configLoadError; return cfg.provider || null; },
    getActiveModel: () => { if (configLoadError) throw configLoadError; return cfg.model || null; },
    getMessages: () => [],
    getSessionId: () => null,
    // /provider <name> and /model <name> only take effect through these
    // (tui/slash_dispatcher.mjs:203-204,238,252-253,256); without them the
    // dispatcher's own "provider → X" / "model → X" strings claim a switch
    // that never reaches disk. persistActiveProvider/persistActiveModel are
    // the SAME functions commands/chat.mjs wires its own ctx to, so a switch
    // made over HTTP is visible to a later /status exactly as it would be
    // from the terminal — WHEN it lands. See persistAndVerify below for what
    // happens when it doesn't.
    setActiveProvName: (name) => persistAndVerify(ctx, cfg, 'provider', name, persistActiveProvider, explainProviderMismatch),
    setActiveModel: (name) => persistAndVerify(ctx, cfg, 'model', name, persistActiveModel),
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

// persistActiveProvider/persistActiveModel (lib/config.mjs:92-117) are
// best-effort: each does its OWN readConfig()/writeConfig() and swallows any
// failure internally (`catch { /* best-effort */ }`), returning nothing to
// signal it — reasonable for the terminal REPL, where the in-memory
// activeProvName/activeModel updates regardless (commands/chat.mjs:224,226)
// and disk persistence is just "stick across a restart". Here there IS no
// in-memory session to fall back on — cfg.provider/cfg.model on disk is the
// ONLY thing getActiveProvName/getActiveModel read — so a swallowed failure
// here is a straight false claim: tui/slash_dispatcher.mjs calls the setter
// and unconditionally returns "provider → X" / "model → X"
// (:203-204,214,238,252-253,256-257) with no outcome to check, and that file
// cannot be modified to check one.
//
// The fix does not try to enumerate every reason a write might not land
// (corrupt JSON, a permissions error, persistActiveProvider's own
// orchestrator-routing guard, a race with a concurrent writer) — it compares
// the claimed new value against a FRESH, independent read afterward. Whatever
// the reason a write silently fails to land, the disk copy will not equal
// what was asked for, so this cannot be defeated by a different failure mode
// than the one that surfaced it: it does not check WHY, only WHETHER.
//
// "Whether" is not the whole story, though: a mismatch is not always a
// config.json problem. `explainMismatch`, when given, gets first look at a
// detected mismatch and can name a KNOWN, deliberate reason a write of this
// specific kind never lands — see explainProviderMismatch below — so the
// generic "check that config.json is valid JSON and writable" is reserved
// for when nothing already explains it, rather than guessed every time.
function persistAndVerify(ctx, cfg, field, value, persistFn, explainMismatch) {
  persistFn(cfg || {}, value);
  let disk;
  try {
    disk = readConfig();
  } catch (err) {
    ctx.__persistFailed = `${field} was not saved — config.json could not be read back to confirm it: ${err.message}`;
    return;
  }
  if (disk[field] !== value) {
    const known = explainMismatch && explainMismatch(cfg, value, disk);
    ctx.__persistFailed = known
      || `${field} was not saved (config.json still has ${JSON.stringify(disk[field] ?? null)}) — check that config.json is valid JSON and writable`;
  }
}

// persistActiveProvider (lib/config.mjs:108-117) has two deliberate no-op
// guards, read directly from its source rather than guessed: it never writes
// the literal name "orchestrator" (that routing is owned by /orchestrator
// on|off, not a provider switch — lib/config.mjs:104-107's comment), and it
// never overwrites an ALREADY-active "orchestrator" provider with anything
// else (protecting that routing from a plain /provider switch). Either one
// produces a mismatch persistAndVerify would otherwise blame on config.json,
// which has nothing wrong with it in this case.
function explainProviderMismatch(cfg, requested) {
  if (requested === 'orchestrator') {
    return 'provider was not saved — "orchestrator" is not set via /provider; orchestrator routing is controlled by /orchestrator on|off';
  }
  if ((cfg || {}).provider === 'orchestrator') {
    return 'provider was not saved — the active provider is "orchestrator", which /provider deliberately leaves alone; run /orchestrator off first, then /provider <name>';
  }
  return null;
}

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

export function makeSlashRunner({ cfgDir, confirmStore, dispatch = _dispatchSlash }) {
  return {
    async run({ line, confirm } = {}) {
      const raw = typeof line === 'string' ? line.trim() : '';
      if (!raw.startsWith('/')) return fail('a slash command is required, e.g. /status');

      const { cmd, args } = parseSlashLine(raw);

      if (needsLiveSession(cmd, args)) {
        return {
          ok: false,
          code: 'NO_SESSION',
          error: `${cmd} changes the active chat session, but this endpoint runs each command as a one-shot call with no session behind it — nothing was saved.`,
          hint: 'this command only works from an interactive chat session (the terminal REPL), not a one-shot HTTP call',
        };
      }

      if (needsHostProcess(cmd, args)) {
        const sub = args.trim().split(/\s+/)[0];
        const label = sub ? `${cmd} ${sub}` : cmd;
        return {
          ok: false,
          code: 'NEEDS_TERMINAL',
          error: `${label} spawns or kills a process on the machine running this daemon, not on the machine making this HTTP request — refused before it could run.`,
          hint: `run \`pompos\` in a terminal on the machine you want this to act on, and use ${label} there`,
        };
      }

      let autoApprove = false;
      const prompt = destructivePrompt(cmd, args);
      if (prompt) {
        if (!confirmStore.redeem(confirm, raw)) {
          return { ok: false, code: 'CONFIRM_REQUIRED', prompt, token: confirmStore.issue(raw) };
        }
        autoApprove = true;
      }

      const lines = [];
      let ctx;
      try {
        ctx = buildHttpCtx({ cfgDir, autoApprove });
      } catch (err) {
        return fail(err?.message || err, 'CONFIG_DIR_MISMATCH');
      }
      let result;
      try {
        result = await dispatch(cmd, args, ctx, (chunk) => { lines.push(String(chunk)); });
      } catch (err) {
        return fail(err?.message || err);
      }
      if (ctx.__persistFailed) {
        // Set by persistAndVerify (above) when /provider or /model's setter
        // ran but the value did not actually land on disk. The handler
        // already built and returned its "provider → X" success string — we
        // are refusing to let THAT out, not reporting a dispatch error.
        return { ok: false, code: 'PERSIST_FAILED', error: ctx.__persistFailed };
      }
      if (result === 'EXIT' && (ctx.requestSetup || ctx.requestConfigStep)) {
        // The dispatcher's own contract for this combination (see
        // commands/chat.mjs:336-338) is "unmount, then the REPL host runs an
        // interactive wizard step". There is no REPL host here, so the step
        // never runs — collapsing this to the ordinary {ok:true, lines:[]}
        // EXIT envelope would report success for something that did nothing.
        return {
          ok: false,
          code: 'NEEDS_TERMINAL',
          error: `${cmd} needs an interactive setup step that only runs in the terminal REPL — this HTTP endpoint cannot run it.`,
          hint: 'run `pompos` in a terminal and use /setup (or the matching /config item) there',
        };
      }
      if (typeof result === 'string' && result !== 'EXIT' && result !== 'NEW' && result.length) {
        lines.push(result);
      }
      return { ok: true, lines };
    },
  };
}
