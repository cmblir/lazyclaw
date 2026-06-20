// Automation commands: cron schedules, detached loop workers, and goals,
// extracted from cli.mjs (Phase D3). Owns the _killLog/KILL_ESCALATE_MS
// loop-kill escalation state.
import path from 'node:path';
import { configPath, readConfig, writeConfig, _resolveAuthKey } from '../lib/config.mjs';
import { ensureRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { attachGoalCron as _attachGoalCronCore, detachGoalCron as _detachGoalCronCore } from '../goals_cron.mjs';
import { loadDotenvIfAny as _loadDotenvShared } from '../dotenv_min.mjs';

// Thin .env loader wrapper kept local so the module stays self-contained.
export function _loadDotenvIfAny(cfgDir) { return _loadDotenvShared(cfgDir); }

// Build the detached loop-worker argv. Pure + exported so the flag-forwarding
// contract is unit-testable: --use-memory / --recall MUST reach the worker, or
// `loop --detach --use-memory` silently runs with no memory (the worker only
// builds a system message when it sees the flags).
export function buildDetachArgv(worker, { loopId, prompt, max, provName, cfgDir, until, requestedSession, model, useMemory, recall } = {}) {
  const argv = [worker, '--loop-id', loopId, '--prompt', prompt,
    '--max', String(max), '--provider', provName, '--cfg-dir', cfgDir];
  if (until) { argv.push('--until', String(until)); }
  if (requestedSession) { argv.push('--session-existing', requestedSession); }
  if (model) { argv.push('--model', String(model)); }
  if (useMemory) { argv.push('--use-memory'); }
  if (recall) { argv.push('--recall', String(recall)); }
  return argv;
}

export async function cmdCron(sub, positional, flags = {}) {
  const cron = await import('../cron.mjs');
  const cfg = readConfig();
  const backend = cron.pickBackend();
  switch (sub) {
    case undefined:
    case 'list': {
      const jobs = cron.listJobs(cfg);
      console.log(JSON.stringify({ backend, jobs }, null, 2));
      return;
    }
    case 'show': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw cron show <name>'); process.exit(2); }
      const job = cron.getJob(cfg, name);
      if (!job) { console.error(`error: no job "${name}"`); process.exit(1); }
      console.log(JSON.stringify({ backend, name, ...job }, null, 2));
      return;
    }
    case 'add': {
      // Shape: lazyclaw cron add <name> "<cron-spec>" -- <cmd> [args...]
      // The `--` separator was already consumed by parseArgs, but
      // the spec is the second positional and the command is
      // everything after it. parseArgs preserves order, so:
      //   positional[0] = name
      //   positional[1] = "0 9 * * *"
      //   positional[2..] = cmd argv
      const [name, schedule, ...cmd] = positional;
      if (!name || !schedule || !cmd.length) {
        console.error('Usage: lazyclaw cron add <name> "<cron-spec>" -- <cmd> ...');
        process.exit(2);
      }
      try {
        cron.upsertJob(cfg, name, schedule, cmd);
      } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      writeConfig(cfg);
      // Install to system scheduler — failure here doesn't roll
      // back the config write because the job is "scheduled in
      // intent". `cron sync` reconciles.
      try {
        if (backend === 'launchd') cron.installLaunchdJob(name, schedule, cmd);
        else                       cron.installCrontabJob(name, schedule, cmd);
      } catch (e) {
        console.error(`warn: backend install failed: ${e.message} — config saved; run \`cron sync\` to retry`);
        process.exit(1);
      }
      console.log(JSON.stringify({ ok: true, backend, name, schedule, command: cmd }, null, 2));
      return;
    }
    case 'remove': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw cron remove <name>'); process.exit(2); }
      try { cron.removeJob(cfg, name); } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      writeConfig(cfg);
      try {
        if (backend === 'launchd') cron.uninstallLaunchdJob(name);
        else                       cron.uninstallCrontabJob(name);
      } catch (e) {
        console.error(`warn: backend uninstall failed: ${e.message}`);
      }
      console.log(JSON.stringify({ ok: true, backend, removed: name }));
      return;
    }
    case 'sync': {
      // Re-install every job in cfg.cron — useful after a fresh
      // OS image where the launchd plists / crontab were wiped.
      const out = [];
      for (const [name, job] of Object.entries(cfg.cron || {})) {
        try {
          if (backend === 'launchd') cron.installLaunchdJob(name, job.schedule, job.command);
          else                       cron.installCrontabJob(name, job.schedule, job.command);
          out.push({ name, ok: true });
        } catch (e) {
          out.push({ name, ok: false, error: e.message });
        }
      }
      console.log(JSON.stringify({ backend, results: out }, null, 2));
      return;
    }
    case 'run': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw cron run <name>'); process.exit(2); }
      try {
        const code = cron.runJob(cfg, name);
        process.exit(code || 0);
      } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
      return;
    }
    default:
      console.error('Usage: lazyclaw cron <list|add|remove|show|sync|run> ...');
      process.exit(2);
  }
}

// `lazyclaw loop <prompt> [--max N] [--until "<regex>"] [--session ID]
//                 [--detach] [--provider NAME] [--model NAME]`
//
// Without --detach: runs the loop in the foreground using the engine
// from loop-engine.mjs and streams chunks to stdout (mirrors the REPL
// /loop UX but with no surrounding chat REPL).
//
// With --detach: forks scripts/loop-worker.mjs in its own process group
// (`detached: true`), prints `{loopId, pid, statePath}` and returns
// immediately. The worker persists state under `<configDir>/loops/<id>/`.
export async function cmdLoop(prompt, flags = {}) {
  await ensureRegistry();
  const cfg = readConfig();
  const cfgDir = path.dirname(configPath());
  const loopEng = await import('../loop-engine.mjs');
  const loopsMod = await import('../loops.mjs');

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    console.error('Usage: lazyclaw loop <prompt> [--max N] [--until "<regex>"] [--session ID] [--detach]');
    process.exit(2);
  }
  const max = flags.max !== undefined ? Number(flags.max) : loopEng.LOOP_MAX_DEFAULT;
  if (!Number.isInteger(max) || max <= 0) {
    console.error(`loop: --max must be a positive integer, got "${flags.max}"`);
    process.exit(2);
  }
  if (max > loopEng.LOOP_MAX_CEILING) {
    console.error(`loop: --max ${max} exceeds ceiling ${loopEng.LOOP_MAX_CEILING} (runaway guard)`);
    process.exit(2);
  }
  let untilRe = null;
  try { untilRe = loopEng.compileUntil(flags.until); }
  catch (e) { console.error(`loop: ${e?.message || e}`); process.exit(2); }

  const provName = flags.provider || cfg.provider || 'mock';
  const prov = getRegistry().PROVIDERS[provName];
  if (!prov) { console.error(`unknown provider: ${provName}`); process.exit(2); }
  const model = flags.model || cfg.model;

  const loopId = loopsMod.newLoopId();
  const requestedSession = flags.session ? String(flags.session) : null;
  const sessionId = requestedSession || `loop:${loopId}`;
  const statePath = loopsMod.loopDir(loopId, cfgDir);

  // Seed meta before forking so `loops list` can see the job even if the
  // worker hasn't reached its first iteration yet.
  loopsMod.writeMeta(loopId, {
    prompt,
    max,
    until: flags.until || null,
    sessionId,
    sessionMode: requestedSession ? 'shared' : 'fresh',
    provider: provName,
    model: model || null,
    status: 'pending',
    startedAt: new Date().toISOString(),
    pid: null,
  }, cfgDir);

  if (flags.detach) {
    const { spawn } = await import('node:child_process');
    // This module lives in commands/, so the worker sits one level up at
    // <repo>/scripts/loop-worker.mjs (was a sibling when cmdLoop was in cli.mjs).
    const here = path.dirname(new URL(import.meta.url).pathname);
    const worker = path.join(here, '..', 'scripts', 'loop-worker.mjs');
    const argv = buildDetachArgv(worker, {
      loopId, prompt, max, provName, cfgDir,
      until: flags.until, requestedSession, model,
      useMemory: flags['use-memory'], recall: flags.recall,
    });
    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir },
    });
    child.unref();
    loopsMod.patchMeta(loopId, { pid: child.pid, pgid: child.pid, status: 'running' }, cfgDir);
    process.stdout.write(JSON.stringify({ loopId, pid: child.pid, statePath }) + '\n');
    return;
  }

  // Foreground path — same engine, streaming chunks live to stdout.
  const sessionsMod = await import('../sessions.mjs');
  const messages = requestedSession
    ? sessionsMod.loadTurns(sessionId, cfgDir).map(t => ({ role: t.role, content: t.content }))
    : [];
  loopsMod.patchMeta(loopId, { pid: process.pid, status: 'running' }, cfgDir);

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  const sendOnce = async (msgs, signal) => {
    let acc = '';
    for await (const chunk of prov.sendMessage(msgs, {
      apiKey: _resolveAuthKey(cfg, provName),
      model,
      signal,
    })) {
      process.stdout.write(chunk);
      acc += chunk;
    }
    process.stdout.write('\n');
    return acc;
  };
  const persist = (role, content) => sessionsMod.appendTurn(sessionId, role, content, cfgDir);
  const onIteration = ({ i, max: m, reply }) => {
    process.stderr.write(`  ↻ loop iteration ${i}/${m}\n`);
    loopsMod.appendIteration(loopId, { iteration: i, of: m, bytes: reply.length, preview: reply.slice(0, 200) }, cfgDir);
  };

  // Detached/foreground both honor --use-memory and --recall by
  // rebuilding the system message before each iteration. The
  // computation lives in memory.mjs so the same logic powers
  // `/loop --use-memory` in the REPL.
  const memMod = (flags['use-memory'] || flags.recall) ? await import('../memory.mjs') : null;
  const buildSystem = memMod ? (() => {
    const parts = [];
    if (flags['use-memory']) {
      const core = memMod.loadCore(cfgDir);
      if (core && core.trim()) parts.push(core);
    }
    if (flags.recall) {
      const text = memMod.recall(String(flags.recall), { topN: 3 }, cfgDir);
      if (text && text.trim()) parts.push(text);
    }
    return parts.join('\n\n---\n\n');
  }) : null;

  try {
    const result = await loopEng.runLoop({ prompt, max, until: untilRe, messages, sendOnce, persist, onIteration, signal: ac.signal, buildSystem });
    const finalStatus = result.stoppedBy === 'abort' ? 'killed' : 'completed';
    loopsMod.patchMeta(loopId, { status: finalStatus, finishedAt: new Date().toISOString() }, cfgDir);
    loopsMod.writeResult(loopId, result, cfgDir);
    process.stdout.write(JSON.stringify({ loopId, ...result }) + '\n');
  } catch (err) {
    loopsMod.patchMeta(loopId, { status: 'failed', finishedAt: new Date().toISOString() }, cfgDir);
    loopsMod.writeResult(loopId, { error: err?.message || String(err) }, cfgDir);
    console.error(`loop error: ${err?.message || err}`);
    process.exit(1);
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

// Kill registry — `lazyclaw loops kill <id>` SIGTERMs once and SIGKILLs
// on a second invocation within KILL_ESCALATE_MS. Module-scoped so two
// rapid invocations of `cmd loops kill <id>` from the same process see
// each other; for separate processes the worker also handles SIGKILL by
// the OS, so the escalation is a UX nicety rather than a correctness gate.
const _killLog = new Map();
const KILL_ESCALATE_MS = 5000;

export async function cmdLoops(sub, positional, flags = {}) {
  const loopsMod = await import('../loops.mjs');
  const cfgDir = path.dirname(configPath());
  switch (sub) {
    case undefined:
    case 'list': {
      const items = loopsMod.listLoops(cfgDir).map(loopsMod.reconcileStatus);
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    case 'show': {
      const id = positional[0];
      if (!id) { console.error('Usage: lazyclaw loops show <id>'); process.exit(2); }
      const meta = loopsMod.reconcileStatus(loopsMod.readMeta(id, cfgDir));
      if (!meta) { console.error(`no loop "${id}"`); process.exit(1); }
      const iterations = loopsMod.readIterations(id, cfgDir);
      const result = loopsMod.readResult(id, cfgDir);
      console.log(JSON.stringify({ id, meta, iterations, result }, null, 2));
      return;
    }
    case 'kill': {
      const id = positional[0];
      if (!id) { console.error('Usage: lazyclaw loops kill <id>'); process.exit(2); }
      const meta = loopsMod.readMeta(id, cfgDir);
      if (!meta) { console.error(`no loop "${id}"`); process.exit(1); }
      if (!meta.pid) { console.error(`loop "${id}" has no pid`); process.exit(1); }
      const last = _killLog.get(id) || 0;
      const now = Date.now();
      const escalate = (now - last) < KILL_ESCALATE_MS && last > 0;
      const sig = escalate ? 'SIGKILL' : 'SIGTERM';
      try { process.kill(meta.pid, sig); }
      catch (e) {
        if (e?.code !== 'ESRCH') throw e;
        // Already gone — reconcile and report.
        loopsMod.patchMeta(id, { status: 'killed', finishedAt: new Date().toISOString() }, cfgDir);
        console.log(JSON.stringify({ id, pid: meta.pid, signal: sig, status: 'already_gone' }));
        return;
      }
      _killLog.set(id, now);
      console.log(JSON.stringify({ id, pid: meta.pid, signal: sig, escalated: escalate }));
      return;
    }
    case 'tail': {
      const id = positional[0];
      if (!id) { console.error('Usage: lazyclaw loops tail <id>'); process.exit(2); }
      const dir = loopsMod.loopDir(id, cfgDir);
      const logPath = path.join(dir, 'iterations.log');
      const fs = await import('node:fs');
      if (!fs.existsSync(dir)) { console.error(`no loop "${id}"`); process.exit(1); }
      // Print everything already on disk first, then poll for new lines
      // until the worker exits / status is no longer "running".
      let offset = 0;
      if (fs.existsSync(logPath)) {
        const buf = fs.readFileSync(logPath, 'utf8');
        process.stdout.write(buf);
        offset = buf.length;
      }
      const pollMs = Number(flags['poll-ms']) || 250;
      const maxMs = Number(flags['max-wait-ms']) || 0; // 0 = wait indefinitely
      const startedAt = Date.now();
      while (true) {
        await new Promise(r => setTimeout(r, pollMs));
        let cur = '';
        try { cur = fs.readFileSync(logPath, 'utf8'); } catch { /* file may briefly not exist */ }
        if (cur.length > offset) {
          process.stdout.write(cur.slice(offset));
          offset = cur.length;
        }
        const meta = loopsMod.reconcileStatus(loopsMod.readMeta(id, cfgDir));
        if (!meta || meta.status !== 'running') break;
        if (maxMs > 0 && Date.now() - startedAt > maxMs) break;
      }
      return;
    }
    default:
      console.error('Usage: lazyclaw loops <list|show|kill|tail> ...');
      process.exit(2);
  }
}

// Install (or refresh) the system scheduler entry that fires
// `lazyclaw goal tick <name>` on a schedule. Writes to cfg.cron and to
// the OS backend (launchd / crontab). Tests set
// LAZYCLAW_SKIP_CRON_INSTALL=1 to skip the OS-side mutation but keep
// the config-side wiring so `cron list` still reflects the entry.
export async function _attachGoalCron(name, schedule) {
  const cron = await import('../cron.mjs');
  return _attachGoalCronCore({ readConfig, writeConfig, cron, name, schedule });
}

// Mirror of _attachGoalCron's removal path. Returns true when an entry
// was actually present; false when the goal had no cron attached
// (already-clean state, safe to call unconditionally during `close`).
export async function _detachGoalCron(name) {
  const cron = await import('../cron.mjs');
  return _detachGoalCronCore({ readConfig, writeConfig, cron, name });
}

// Builds the user-side prompt the scheduler sends on every tick. Memory
// (core + episodic matches) lands in the system slot via Phase 6's
// buildSystem path, not here — that way a parallel writer touching
// core.md mid-loop is reflected on the next iteration without us
// having to rebuild this string.
export function _composeTickPrompt(goal) {
  const parts = [];
  parts.push(`Goal: ${goal.description || goal.name}`);
  const recent = (goal.checkIns || []).slice(-3);
  if (recent.length) {
    parts.push('Recent check-ins:');
    for (const c of recent) parts.push(`- ${c.at}: ${c.summary}`);
  }
  parts.push("What's the next concrete step?");
  return parts.join('\n\n');
}

// `lazyclaw goal <add|list|show|close|switch|tick|channel> ...`
//
// Pure registration in Phase 3 (no cron install, no channel delivery —
// those land in Phase 4 / Phase 8). `switch` is a no-op for the
// detached CLI surface; it exists for symmetry with the REPL command
// (where it changes the chat's working session) and writes nothing
// special when invoked here — the user gets a hint pointing at /goal.
export async function cmdGoal(sub, positional, flags = {}) {
  const goalsMod = await import('../goals.mjs');
  const cfgDir = path.dirname(configPath());
  switch (sub) {
    case 'add': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw goal add <name> [--desc "..."] [--cron "<spec>"] [--channel slack:<target>]'); process.exit(2); }
      let g;
      const channels = flags.channel ? [String(flags.channel)] : [];
      try {
        g = goalsMod.registerGoal({
          name,
          description: flags.desc || '',
          schedule: flags.cron || null,
          channels,
        }, cfgDir);
      } catch (e) { console.error(e?.message || e); process.exit(2); }
      if (flags.cron) {
        try { await _attachGoalCron(name, String(flags.cron)); }
        catch (e) { console.error(`error attaching cron: ${e?.message || e}`); process.exit(1); }
      }
      console.log(JSON.stringify(g, null, 2));
      return;
    }
    case undefined:
    case 'list': {
      const items = goalsMod.listGoals(cfgDir);
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    case 'show': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw goal show <name>'); process.exit(2); }
      const g = goalsMod.getGoal(name, cfgDir);
      if (!g) { console.error(`no goal "${name}"`); process.exit(1); }
      console.log(JSON.stringify(g, null, 2));
      return;
    }
    case 'close': {
      const name = positional[0];
      const outcome = positional[1] || 'done';
      if (!name) { console.error('Usage: lazyclaw goal close <name> [done|abandoned]'); process.exit(2); }
      let g;
      try { g = goalsMod.closeGoal(name, outcome, cfgDir); }
      catch (e) { console.error(e?.message || e); process.exit(1); }
      // Best-effort cron detach. If the goal had no cron attached this
      // is a no-op; if it did, both cfg.cron and the OS scheduler are
      // cleaned in tandem so a follow-up `cron list` is empty.
      try { await _detachGoalCron(name); }
      catch (e) { console.error(`warn: cron detach failed: ${e?.message || e}`); }
      console.log(JSON.stringify(g, null, 2));
      return;
    }
    case 'tick': {
      // Internal subcommand fired by the cron scheduler (or manually
      // with --force). Exits 0 silently when the goal is not active so
      // a stale cron entry doesn't crash the scheduler.
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw goal tick <name> [--force]'); process.exit(2); }
      const g = goalsMod.getGoal(name, cfgDir);
      if (!g) {
        // No goal file at all — exit 0 silently. The scheduler may be
        // chasing a deleted goal; we don't want to noisy-log the cron
        // path. Setting LAZYCLAW_DEBUG=1 surfaces it.
        if (process.env.LAZYCLAW_DEBUG) console.error(`tick: no goal "${name}"`);
        return;
      }
      if (g.status !== 'active') {
        if (process.env.LAZYCLAW_DEBUG) console.error(`tick: goal "${name}" is ${g.status}, skipping`);
        return;
      }
      await ensureRegistry();
      const cfg = readConfig();
      const provName = flags.provider || cfg.provider || 'mock';
      const prov = getRegistry().PROVIDERS[provName];
      if (!prov) { console.error(`unknown provider: ${provName}`); process.exit(2); }
      const model = flags.model || cfg.model;

      const memoryMod = await import('../memory.mjs');
      const tickPrompt = _composeTickPrompt(g);
      // Memory flows into the system slot. Per-iter rebuild is a no-op
      // here (max=1) but matches Phase 6's contract so a future tick
      // with max>1 behaves the same as `/loop --use-memory`.
      const tickBuildSystem = () => memoryMod.getMemoryForGoal(g.name, g.description || '', cfgDir);
      const loopEng = await import('../loop-engine.mjs');
      const sessionsMod = await import('../sessions.mjs');
      const sessionId = g.sessionId;
      // Rehydrate prior turns so the model has full context. Tick
      // appends the user prompt and assistant reply to this session
      // just like `/loop --max 1` would.
      const messages = sessionsMod.loadTurns(sessionId, cfgDir).map(t => ({ role: t.role, content: t.content }));

      const sendOnce = async (msgs, signal) => {
        let acc = '';
        for await (const chunk of prov.sendMessage(msgs, {
          apiKey: _resolveAuthKey(cfg, provName),
          model,
          signal,
        })) {
          acc += chunk;
        }
        return acc;
      };
      const persist = (role, content) => sessionsMod.appendTurn(sessionId, role, content, cfgDir);

      let result;
      try {
        result = await loopEng.runLoop({
          prompt: tickPrompt,
          max: 1,
          until: null,
          messages,
          sendOnce,
          persist,
          onIteration: undefined,
          signal: undefined,
          buildSystem: tickBuildSystem,
        });
      } catch (e) {
        console.error(`tick error: ${e?.message || e}`);
        process.exit(1);
      }
      goalsMod.appendCheckIn(name, result.lastReply, cfgDir);
      // Fan-out the check-in to every registered channel. We re-read
      // the goal to capture the freshly-appended checkIn count so the
      // fan-out body has the canonical timestamp.
      const refreshed = goalsMod.getGoal(name, cfgDir);
      const channels = Array.isArray(refreshed?.channels) ? refreshed.channels : [];
      const slackTargets = channels.filter(c => typeof c === 'string' && c.startsWith('slack:'));
      const fanoutResults = [];
      if (slackTargets.length > 0) {
        // Lazy import so plain non-slack tick paths don't pay the cost.
        const slackMod = await import('../channels/slack.mjs');
        let slack;
        try {
          slack = new slackMod.SlackChannel({ requireInbound: false });
          // Validate env BEFORE start() so a missing-secrets environment
          // does not silently skip — instead the operator sees a clear
          // warning and tick still succeeds (the check-in is on disk).
          await slack.start(async () => '', { gate: null });
        } catch (e) {
          console.error(`warn: skipping Slack fan-out: ${e?.message || e}`);
          slack = null;
        }
        if (slack) {
          for (const target of slackTargets) {
            const channel = target.slice('slack:'.length);
            try {
              await slack.send(channel, result.lastReply);
              fanoutResults.push({ channel: target, ok: true });
            } catch (e) {
              fanoutResults.push({ channel: target, ok: false, error: e?.message || String(e) });
            }
          }
          try { await slack.stop(); } catch { /* best-effort */ }
        }
      }
      console.log(JSON.stringify({ ok: true, name, iterations: result.iterations, reply: result.lastReply, fanout: fanoutResults }));
      return;
    }
    case 'switch': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw goal switch <name>'); process.exit(2); }
      const g = goalsMod.getGoal(name, cfgDir);
      if (!g) { console.error(`no goal "${name}"`); process.exit(1); }
      // Non-interactive surface: print the session id so a caller can
      // pipe it into `lazyclaw chat --session <id>`. The REPL slash form
      // is what mutates state in a live chat.
      console.log(JSON.stringify({ name: g.name, sessionId: g.sessionId, status: g.status }));
      return;
    }
    case 'channel': {
      const op = positional[0];
      const name = positional[1];
      const target = positional[2];
      if (!op || !name) { console.error('Usage: lazyclaw goal channel <add|remove> <name> [target]'); process.exit(2); }
      const g = goalsMod.getGoal(name, cfgDir);
      if (!g) { console.error(`no goal "${name}"`); process.exit(1); }
      const cur = Array.isArray(g.channels) ? g.channels : [];
      let next;
      if (op === 'add') {
        if (!target) { console.error('Usage: lazyclaw goal channel add <name> <target>'); process.exit(2); }
        next = Array.from(new Set([...cur, target]));
      } else if (op === 'remove') {
        if (!target) { console.error('Usage: lazyclaw goal channel remove <name> <target>'); process.exit(2); }
        next = cur.filter(t => t !== target);
      } else {
        console.error('Usage: lazyclaw goal channel <add|remove> <name> <target>'); process.exit(2);
        return;
      }
      const updated = goalsMod.patchGoal(name, { channels: next }, cfgDir);
      console.log(JSON.stringify({ name: updated.name, channels: updated.channels }));
      return;
    }
    default:
      console.error('Usage: lazyclaw goal <add|list|show|close|switch> ...');
      process.exit(2);
  }
}
