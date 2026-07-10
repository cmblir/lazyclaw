// Cron — recurring `lazyclaw agent` runs.
//
// `lazyclaw cron add daily-summary "0 9 * * *" -- agent "Summarise
// today's TODOs"` schedules the agent invocation every weekday at
// 9 AM. On macOS we install a launchd plist; on Linux / WSL we
// append a crontab entry. Both backends carry a per-job marker so
// `cron list` / `cron remove` round-trip cleanly.
//
// Why this is built into the CLI:
// - Most "make this scheduled" recipes for AI agents devolve into
//   "add a crontab entry that pipes through a wrapper" — that's
//   what we generate here, but with the right env vars to land in
//   the user's lazyclaw config and a stable id for removal.
// - launchd plists on macOS don't honor `crontab -e`, so a
//   single-platform implementation would feel broken to half the
//   user base.
//
// The job spec lives in `cfg.cron[<name>]` so it survives
// uninstall/reinstall of the OS-level scheduler — `cron sync`
// reconciles. Schedule strings use 5-field cron syntax everywhere
// (the launchd backend internally translates to plist
// StartCalendarInterval entries).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const MARKER_PREFIX = '# lazyclaw-cron:';

class CronError extends Error {
  constructor(message, code) { super(message); this.name = 'CronError'; this.code = code || 'CRON_ERR'; }
}

// Absolute path to this package's CLI entrypoint. A scheduled job stores the
// logical `['lazyclaw', …]` command, but the OS scheduler can't rely on a
// `lazyclaw` shim being on its PATH: launchd runs with PATH=/usr/bin:/bin:
// /usr/sbin:/sbin and cron with PATH=/usr/bin:/bin — neither includes the
// Homebrew / npm-global / nvm bin dir where the shim lives. So at the moment we
// hand the command to launchd / crontab / exec we rewrite a leading `lazyclaw`
// into an absolute `<node> <abs cli.mjs>` launcher that resolves regardless of
// PATH. A non-lazyclaw command (the user's own binary) is passed through as-is.
const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url));

export function resolveCommand(command) {
  const argv = Array.isArray(command) ? command.slice() : [String(command)];
  if (argv.length && (argv[0] === 'lazyclaw' || path.basename(String(argv[0])) === 'lazyclaw')) {
    return [process.execPath, CLI_PATH, ...argv.slice(1)];
  }
  return argv;
}

// PATH for the scheduled job's environment. Even with an absolute launcher, the
// job itself shells out (e.g. lazyclaw spawning the `claude` CLI), so it needs a
// usable PATH that launchd/cron would not otherwise provide. Lead with the dir
// of the node binary that built the job, then the usual install locations.
function schedulerPath() {
  const dirs = [
    path.dirname(process.execPath),
    '/opt/homebrew/bin', '/usr/local/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  return [...new Set(dirs)].join(':');
}

// 5-field cron spec parser — minimal but strict enough that
// "every Tuesday at 14:30" doesn't silently land at "every minute".
// Supports: number, *, range a-b, list a,b,c, step */n.
const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour',   min: 0, max: 23 },
  { name: 'dom',    min: 1, max: 31 },
  { name: 'month',  min: 1, max: 12 },
  { name: 'dow',    min: 0, max: 6  },
];

// Day-of-week and month accept 3-letter names alongside numbers, and POSIX cron
// also lets 7 mean Sunday (an alias for 0). These are applied wherever a
// dow/month token is turned into a number, so a user pasting a normal crontab
// line (`0 9 * * MON-FRI`, `0 0 * * 7`, `0 0 1 JAN *`) is accepted rather than
// rejected with an out-of-range error.
const DOW_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MONTH_NAMES = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// Common @-macros expand to a 5-field spec. @reboot has no calendar-time
// meaning for the StartCalendarInterval / crontab-time model, so it is
// intentionally unsupported (rejected with a clear message).
const CRON_MACROS = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

function fieldNum(tok, name) {
  const t = String(tok).trim().toUpperCase();
  if (name === 'dow') {
    if (Object.prototype.hasOwnProperty.call(DOW_NAMES, t)) return DOW_NAMES[t];
    const n = Number(t);
    if (n === 7) return 0; // POSIX: 0 and 7 both mean Sunday
    return n;
  }
  if (name === 'month' && Object.prototype.hasOwnProperty.call(MONTH_NAMES, t)) return MONTH_NAMES[t];
  return Number(tok);
}

export function parseCronSpec(spec) {
  let raw = String(spec || '').trim();
  if (raw.startsWith('@')) {
    const expanded = CRON_MACROS[raw.toLowerCase()];
    if (!expanded) {
      throw new CronError(`unsupported cron macro "${raw}" — use 5-field syntax or one of: ${Object.keys(CRON_MACROS).join(', ')}`, 'CRON_BAD_MACRO');
    }
    raw = expanded;
  }
  const tokens = raw.split(/\s+/);
  if (tokens.length !== 5) {
    throw new CronError(`bad cron spec "${spec}" — need 5 fields, got ${tokens.length}`, 'CRON_BAD_SPEC');
  }
  const out = {};
  for (let i = 0; i < 5; i++) {
    const range = FIELD_RANGES[i];
    out[range.name] = parseField(tokens[i], range);
  }
  return out;
}

function parseField(field, { name, min, max }) {
  // Wildcard short-circuit.
  if (field === '*') return { kind: 'any' };
  // Step expressions: */N or RANGE/N.
  const slash = field.indexOf('/');
  if (slash >= 0) {
    const head = field.slice(0, slash);
    const step = Number(field.slice(slash + 1));
    if (!Number.isFinite(step) || step < 1) {
      throw new CronError(`bad step "${field}" in ${name}`, 'CRON_BAD_STEP');
    }
    if (head === '' || head === '*') return { kind: 'step', from: min, to: max, step };
    const dash = head.indexOf('-');
    if (dash < 0) throw new CronError(`bad step base "${head}" in ${name}`, 'CRON_BAD_STEP');
    const a = fieldNum(head.slice(0, dash), name), b = fieldNum(head.slice(dash + 1), name);
    expectInRange(a, min, max, name); expectInRange(b, min, max, name);
    return { kind: 'step', from: a, to: b, step };
  }
  // List a,b,c.
  if (field.includes(',')) {
    const items = field.split(',').map((p) => parseField(p, { name, min, max }));
    return { kind: 'list', items };
  }
  // Range a-b.
  const dash = field.indexOf('-');
  if (dash >= 0) {
    const a = fieldNum(field.slice(0, dash), name), b = fieldNum(field.slice(dash + 1), name);
    expectInRange(a, min, max, name); expectInRange(b, min, max, name);
    return { kind: 'range', from: a, to: b };
  }
  // Plain number (or a 3-letter dow/month name, or dow 7 == Sunday).
  const n = fieldNum(field, name);
  expectInRange(n, min, max, name);
  return { kind: 'value', value: n };
}

function expectInRange(n, min, max, fieldName) {
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new CronError(`${fieldName} value ${n} out of range ${min}–${max}`, 'CRON_OUT_OF_RANGE');
  }
}

// Expand a parsed field into the explicit list of values it
// matches. launchd needs explicit values, not patterns.
export function expandField(parsed, { min, max }) {
  if (!parsed) return [];
  switch (parsed.kind) {
    case 'any':   return null; // null === "every"
    case 'value': return [parsed.value];
    case 'range': return inclusive(parsed.from, parsed.to);
    case 'step': {
      const out = [];
      for (let i = parsed.from; i <= parsed.to; i += parsed.step) out.push(i);
      return out;
    }
    case 'list': {
      const out = new Set();
      for (const item of parsed.items) {
        const xs = expandField(item, { min, max });
        if (xs === null) return null;
        xs.forEach((v) => out.add(v));
      }
      return [...out].sort((a, b) => a - b);
    }
    default: return [];
  }
}

function inclusive(a, b) {
  const [from, to] = a <= b ? [a, b] : [b, a];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// ── id / shape ──────────────────────────────────────────────────

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function ensureValidName(name) {
  if (!name || !NAME_RE.test(name)) {
    throw new CronError(`name "${name}" must match ${NAME_RE}`, 'CRON_BAD_NAME');
  }
}

export function listJobs(cfg) {
  return Object.entries(cfg.cron || {}).map(([name, j]) => ({
    name,
    schedule: j.schedule,
    command: j.command,
    addedAt: j.addedAt,
  }));
}

export function getJob(cfg, name) {
  return (cfg.cron || {})[name] || null;
}

export function upsertJob(cfg, name, schedule, command) {
  ensureValidName(name);
  parseCronSpec(schedule); // throws on bad spec
  if (!command || (Array.isArray(command) && !command.length)) {
    throw new CronError('command is required', 'CRON_NO_COMMAND');
  }
  cfg.cron = cfg.cron || {};
  const existed = !!cfg.cron[name];
  cfg.cron[name] = {
    schedule,
    command: Array.isArray(command) ? command : [String(command)],
    addedAt: existed ? cfg.cron[name].addedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return existed ? 'updated' : 'created';
}

export function removeJob(cfg, name) {
  if (!cfg.cron || !cfg.cron[name]) throw new CronError(`no job "${name}"`, 'CRON_NO_JOB');
  delete cfg.cron[name];
}

// ── installer (system scheduler) ────────────────────────────────

export function pickBackend() {
  if (process.platform === 'darwin') return 'launchd';
  return 'crontab';
}

export function plistPath(name) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `com.lazyclaw.${name}.plist`);
}

export function buildPlist(name, schedule, command) {
  const parsed = parseCronSpec(schedule);
  const min   = expandField(parsed.minute, { min: 0,  max: 59 });
  const hour  = expandField(parsed.hour,   { min: 0,  max: 23 });
  const dom   = expandField(parsed.dom,    { min: 1,  max: 31 });
  const month = expandField(parsed.month,  { min: 1,  max: 12 });
  const dow   = expandField(parsed.dow,    { min: 0,  max: 6  });
  // launchd takes a single dict per fire-time. We expand the cron schedule
  // into the cartesian product of (Minute × Hour × Day × Month × Weekday);
  // each null field means "every" so we encode nothing for it.
  //
  // BUT cron treats day-of-month and day-of-week with OR semantics when BOTH
  // are restricted: `0 9 13 * 5` fires on the 13th OR on any Friday. A plain
  // cartesian product ANDs them (only when the 13th IS a Friday) — diverging
  // from crontab on Linux. So when both are restricted, emit the UNION of two
  // sets: one keyed on Day (Weekday=every) and one on Weekday (Day=every).
  // A wildcard minute must be enumerated to 0..59 rather than left as "every".
  // launchd has no "every minute" token: an interval dict with no keys is
  // treated as invalid and never fires, so `* * * * *` (all-wildcard) would
  // otherwise emit a single empty <dict/> that silently never runs. Enumerating
  // the minute guarantees every emitted dict carries at least a Minute key.
  const minuteSlot = min === null ? inclusive(0, 59) : min;
  let entries;
  if (dom !== null && dow !== null) {
    const byDom = cartesian([minuteSlot, minOrNull(hour), dom, minOrNull(month), [null]]);
    const byDow = cartesian([minuteSlot, minOrNull(hour), [null], minOrNull(month), dow]);
    entries = [...byDom, ...byDow];
  } else {
    entries = cartesian([
      minuteSlot, minOrNull(hour), minOrNull(dom), minOrNull(month), minOrNull(dow),
    ]);
  }
  const intervals = entries.map(([Minute, Hour, Day, Month, Weekday]) => {
    const dict = {};
    if (Minute  !== null) dict.Minute  = Minute;
    if (Hour    !== null) dict.Hour    = Hour;
    if (Day     !== null) dict.Day     = Day;
    if (Month   !== null) dict.Month   = Month;
    if (Weekday !== null) dict.Weekday = Weekday;
    return dict;
  });
  const programArguments = resolveCommand(command);
  const stdoutPath = path.join(os.homedir(), '.lazyclaw', 'logs', `cron-${name}.out.log`);
  const stderrPath = path.join(os.homedir(), '.lazyclaw', 'logs', `cron-${name}.err.log`);
  return renderPlist({
    label: `com.lazyclaw.${name}`,
    programArguments,
    intervals,
    stdoutPath,
    stderrPath,
    envPath: schedulerPath(),
  });
}

function minOrNull(arr) {
  return arr === null ? [null] : arr;
}

function cartesian(arrs) {
  return arrs.reduce((acc, arr) => acc.flatMap((row) => arr.map((v) => row.concat([v]))), [[]]);
}

function renderPlist({ label, programArguments, intervals, stdoutPath, stderrPath, envPath }) {
  const argLines = programArguments.map((a) => `      <string>${escapeXml(a)}</string>`).join('\n');
  const intervalDicts = intervals.map((i) => {
    const inner = Object.entries(i)
      .map(([k, v]) => `      <key>${k}</key>\n      <integer>${v}</integer>`).join('\n');
    return `    <dict>\n${inner}\n    </dict>`;
  }).join('\n');
  // launchd does not inherit the interactive shell PATH; without this the
  // scheduled job (and anything it shells out to) runs with a bare default
  // PATH. envPath is optional so older callers / tests still render.
  const envBlock = envPath
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${escapeXml(envPath)}</string>\n  </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
${envBlock}  <key>StartCalendarInterval</key>
  <array>
${intervalDicts}
  </array>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── crontab backend (Linux / WSL) ───────────────────────────────

export function buildCrontabLine(name, schedule, command) {
  // Resolve a bare `lazyclaw` to an absolute launcher (cron runs with
  // PATH=/usr/bin:/bin, which excludes Homebrew/npm-global/nvm bin dirs), then
  // prefix an explicit PATH= so anything the job shells out to is also found.
  const cmdStr = resolveCommand(command).map(shellQuote).join(' ');
  return `${schedule} PATH=${schedulerPath()} ${cmdStr} ${MARKER_PREFIX}${name}`;
}

function shellQuote(arg) {
  if (arg === '' || /[\s'"\\$`]/.test(arg)) return `'${String(arg).replace(/'/g, `'\\''`)}'`;
  return String(arg);
}

// Reads current crontab; ignores "no crontab" exit codes.
function readCrontab() {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout || '';
  // exit 1 + stderr "no crontab" === empty crontab; treat as ''.
  return '';
}

function writeCrontab(text) {
  const r = spawnSync('crontab', ['-'], { input: text, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new CronError(`crontab write failed: ${r.stderr || r.status}`, 'CRON_WRITE_FAIL');
  }
}

export function installCrontabJob(name, schedule, command) {
  const line = buildCrontabLine(name, schedule, command);
  const cur = readCrontab();
  // Drop any prior line for the same name so update == replace.
  const filtered = cur.split('\n').filter((ln) => !ln.endsWith(`${MARKER_PREFIX}${name}`));
  const next = [...filtered, line].filter(Boolean).join('\n') + '\n';
  writeCrontab(next);
  return line;
}

export function uninstallCrontabJob(name) {
  const cur = readCrontab();
  if (!cur) return false;
  const next = cur.split('\n').filter((ln) => !ln.endsWith(`${MARKER_PREFIX}${name}`)).join('\n');
  writeCrontab(next + (next.endsWith('\n') ? '' : '\n'));
  return cur !== next + (next.endsWith('\n') ? '' : '\n');
}

// ── launchd backend (macOS) ─────────────────────────────────────

export function installLaunchdJob(name, schedule, command) {
  const text = buildPlist(name, schedule, command);
  const dst = plistPath(name);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.mkdirSync(path.join(os.homedir(), '.lazyclaw', 'logs'), { recursive: true });
  fs.writeFileSync(dst, text);
  // Try to load the agent so it takes effect now. If launchctl
  // refuses (already loaded, no GUI session), surface the error
  // but leave the plist on disk — `launchctl load` later will
  // pick it up.
  spawnSync('launchctl', ['unload', dst], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['load', dst], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new CronError(`launchctl load failed: ${r.stderr || r.status}`, 'CRON_LAUNCHD_FAIL');
  }
  return dst;
}

export function uninstallLaunchdJob(name) {
  const dst = plistPath(name);
  if (fs.existsSync(dst)) spawnSync('launchctl', ['unload', dst], { stdio: 'ignore' });
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
}

// ── cron run (one-shot, fired by the system) ────────────────────

/**
 * Synchronous run path that the OS scheduler invokes via the
 * stored ProgramArguments. Reads the named job from the saved
 * config, resolves the command to its argv, and exec()s it.
 */
export function runJob(cfg, name) {
  const job = getJob(cfg, name);
  if (!job) throw new CronError(`no job "${name}"`, 'CRON_NO_JOB');
  const [bin, ...args] = resolveCommand(job.command);
  const r = spawnSync(bin, args, { stdio: 'inherit' });
  return r.status ?? 0;
}

export { CronError };
