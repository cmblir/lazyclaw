// mas/trajectory_export.mjs — Phase H1.
//
// Trajectory exporter (spec §2.7). Read-only serialiser — never spawns
// a trainer, never touches weights. Reads JSONL records produced by
// mas/trajectory_store.mjs and emits one of four downstream formats:
//
//   jsonl     — raw transcripts (record verbatim, one per line)
//   atropos   — NousResearch/atropos: {messages, reward, metadata}
//   axolotl   — Axolotl ShareGPT: {conversations: [{from, value}]}
//   openai-ft — OpenAI fine-tune: {messages: [{role, content}]}
//
// Filters: --since <Nd|Nh|Nm> (relative window), --outcome <done|failed|abandoned>.
// `reward` for atropos is null by default per spec Appendix B.6 #22
// (reward signal undefined for v5.0 — `--reward none` is the default).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const FORMATS = Object.freeze(['atropos', 'axolotl', 'openai-ft', 'jsonl']);

function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.pompos');
}

function trajectoriesDir(configDir) {
  return path.join(configDir, 'trajectories');
}

// Parse "7d" / "12h" / "30m" into a millisecond window relative to now.
// Returns null if input is empty/undefined (no filter).
function parseSince(spec) {
  if (!spec) return null;
  const m = String(spec).match(/^(\d+)\s*([dhm])$/i);
  if (!m) throw new Error(`invalid --since: ${spec} (expected Nd|Nh|Nm)`);
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const mult = unit === 'd' ? 86400_000 : unit === 'h' ? 3600_000 : 60_000;
  return Date.now() - n * mult;
}

function* iterRecords(configDir) {
  const root = trajectoriesDir(configDir);
  if (!fs.existsSync(root)) return;
  const buckets = fs.readdirSync(root).sort();
  for (const bucket of buckets) {
    const bdir = path.join(root, bucket);
    let stat; try { stat = fs.statSync(bdir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const f of fs.readdirSync(bdir).sort()) {
      if (!f.endsWith('.jsonl')) continue;
      let raw;
      try { raw = fs.readFileSync(path.join(bdir, f), 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try { yield JSON.parse(s); } catch { /* skip corrupt */ }
      }
    }
  }
}

// Build a uniform message list from a TrajectoryRecord. The store's
// canonical shape carries systemPrompt + userMessages + turns; downstream
// formats all want a chronological role+content sequence so we synthesise
// one here.
function toMessages(rec) {
  const out = [];
  if (rec.systemPrompt) out.push({ role: 'system', content: String(rec.systemPrompt) });
  for (const u of rec.userMessages || []) {
    out.push({ role: 'user', content: String(u) });
  }
  for (const t of rec.turns || []) {
    if (!t || !t.role) continue;
    // turns may already include the user echo; keep them — downstream
    // trainers expect duplicates filtered at their own dedupe stage.
    out.push({ role: t.role, content: String(t.content || '') });
  }
  return out;
}

function formatAtropos(rec) {
  return {
    messages: toMessages(rec),
    reward: null,                     // §B.6 #22 default
    metadata: {
      id: rec.id,
      taskId: rec.taskId,
      agentName: rec.agentName,
      workerProvider: rec.workerProvider,
      workerModel: rec.workerModel,
      outcome: rec.outcome,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
    },
  };
}

function formatAxolotl(rec) {
  // ShareGPT role mapping: system→system, user→human, assistant→gpt,
  // tool→tool. Keeps the channel a downstream Axolotl recipe can filter.
  const FROM = { system: 'system', user: 'human', assistant: 'gpt', tool: 'tool' };
  return {
    conversations: toMessages(rec).map(m => ({
      from: FROM[m.role] || m.role,
      value: m.content,
    })),
  };
}

function formatOpenAIFT(rec) {
  return { messages: toMessages(rec) };
}

function serialise(rec, format) {
  switch (format) {
    case 'jsonl':     return JSON.stringify(rec);
    case 'atropos':   return JSON.stringify(formatAtropos(rec));
    case 'axolotl':   return JSON.stringify(formatAxolotl(rec));
    case 'openai-ft': return JSON.stringify(formatOpenAIFT(rec));
    default: throw new Error(`unknown format: ${format}`);
  }
}

// Public API. Returns { count, outFile, format }. Filesystem side effect
// is a single .jsonl under <outDir> named `trajectories-<format>-<ts>.jsonl`.
export async function exportTrajectories({
  format,
  configDir,
  outDir,
  since,
  filter = {},
} = {}) {
  if (!FORMATS.includes(format)) throw new Error(`unknown format: ${format}`);
  const cfgDir = configDir || defaultConfigDir();
  const dest = outDir || path.join(cfgDir, 'exports');
  fs.mkdirSync(dest, { recursive: true });

  const sinceMs = parseSince(since);
  const outcomeFilter = filter && filter.outcome;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(dest, `trajectories-${format}-${stamp}.jsonl`);
  const fd = fs.openSync(outFile, 'w');
  let count = 0;
  try {
    for (const rec of iterRecords(cfgDir)) {
      if (sinceMs !== null && (rec.startedAt || 0) < sinceMs) continue;
      if (outcomeFilter && rec.outcome !== outcomeFilter) continue;
      fs.writeSync(fd, serialise(rec, format) + '\n');
      count++;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { count, outFile, format };
}

// Parse `outcome=done` style key=value filter strings into a plain object.
// Exported so the CLI can share the parser.
export function parseFilterArg(str) {
  if (!str) return {};
  const out = {};
  for (const part of String(str).split(',')) {
    const [k, v] = part.split('=').map(s => s && s.trim());
    if (k && v) out[k] = v;
  }
  return out;
}
