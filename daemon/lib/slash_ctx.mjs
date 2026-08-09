// daemon/lib/slash_ctx.mjs — builds the slash-command ctx for HTTP callers.
//
// Split out of slash_http.mjs (which was carrying three concerns: config
// guard, ctx build, and envelope routing) to keep that file under the size
// gate. This file owns the first two: making sure ctx.cfg reflects the real,
// current config.json for the directory the caller asked for, and nothing
// else. Envelope routing (which lines may even reach dispatch, and what
// happens to the result) stays in slash_http.mjs.
import fs from 'node:fs';
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
