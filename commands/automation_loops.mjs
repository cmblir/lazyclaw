// Detached loop-worker management commands, extracted from
// commands/automation.mjs to keep that file under the size gate. Owns the
// _killLog/KILL_ESCALATE_MS loop-kill escalation state, which is private to
// cmdLoops.
import path from 'node:path';
import { configPath } from '../lib/config.mjs';

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
