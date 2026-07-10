// Per-skill efficacy stats — the compounding half of the confidence loop.
//
// skills_curator's .usage.json tracks *recall* counters (views / uses /
// lastUsedAt) for freshness/archival. This module tracks *efficacy*:
// cumulative { successes, trials, lastUsedAt } keyed by skill NAME, so a
// skill that was recalled for N tasks and helped M of them resolves to a
// real Wilson lower bound instead of being frozen at the 1/1 Laplace
// prior. It lives beside the usage store (<configDir>/skills/.stats.json)
// and mirrors its patterns exactly:
//   - null-prototype store (prototype-pollution boundary)
//   - atomic write (temp + rename)
//   - injected clock (never reads the wall-clock)
//
// A skill with no stats row resolves to a zeroed record, so a brand-new
// skill (seeded 1/1 at synthesis) and a legacy skill (no row) both keep
// their current behaviour. Additive + best-effort by construction.

import fs from 'node:fs';
import path from 'node:path';

import {
  defaultConfigDir,
  skillsDir,
  skillExists,
  loadSkill,
  installSkill,
  parseFrontmatter,
} from '../skills.mjs';
import * as confidence from './confidence.mjs';
import * as skillSynth from './skill_synth.mjs';
import * as indexDb from './index_db.mjs';

const STATS_FILENAME = '.stats.json';

// How many recalled skills to feed the efficacy loop per finished task.
const EFFICACY_RECALL_K = 5;

// Mirror skills_curator.assertFiniteNow: the store is deterministic only
// because `now` is injected; a NaN/Infinity would silently poison every
// lastUsedAt, so refuse it loudly.
function assertFiniteNow(now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError(`now must be a finite number (got ${String(now)})`);
  }
  return now;
}

// Mirror skills_curator.assertSkillKey: reserved prototype keys are safe
// on a null-prototype store, so we only insist on a non-empty string.
function assertSkillKey(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`skill name must be a non-empty string (got ${String(name)})`);
  }
  return name;
}

function statsPath(configDir = defaultConfigDir()) {
  return path.join(skillsDir(configDir), STATS_FILENAME);
}

// Read the whole stats map ({ <name>: { successes, trials, lastUsedAt } }).
// A missing or corrupt file is treated as empty so a single bad write
// never bricks the tracker. Only OWN enumerable keys of the parsed JSON
// are copied onto a null-prototype object — a hard prototype-pollution
// boundary against a hostile .stats.json.
function readStatsStore(configDir = defaultConfigDir()) {
  const p = statsPath(configDir);
  const store = Object.create(null);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return store;
  }
  if (!parsed || typeof parsed !== 'object') return store;
  for (const key of Object.keys(parsed)) {
    Object.defineProperty(store, key, {
      value: parsed[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return store;
}

// Atomic write: serialise to a sibling temp file then rename over the
// target so a crash mid-write can never leave a half-written store.
function writeStatsStore(store, configDir = defaultConfigDir()) {
  const dir = skillsDir(configDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = statsPath(configDir);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, p);
}

// Normalise a raw record into the full counter shape with sane zeros.
function normalizeRecord(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    successes: Number.isFinite(r.successes) ? r.successes : 0,
    trials: Number.isFinite(r.trials) ? r.trials : 0,
    lastUsedAt: Number.isFinite(r.lastUsedAt) ? r.lastUsedAt : 0,
  };
}

/**
 * Read a skill's efficacy counters. Returns a zeroed record (never
 * throws) when the skill has no recorded stats yet.
 *
 * @param {string} name
 * @param {string} [configDir]
 * @returns {{successes:number, trials:number, lastUsedAt:number}}
 */
export function statsOf(name, configDir = defaultConfigDir()) {
  const key = assertSkillKey(name);
  const store = readStatsStore(configDir);
  return normalizeRecord(Object.hasOwn(store, key) ? store[key] : undefined);
}

/**
 * Record one efficacy trial for a skill. Every call increments `trials`
 * by one; a successful task additionally increments `successes` by one
 * (a failed task is a miss — trials up, successes unchanged). lastUsedAt
 * is stamped with the injected `now`.
 *
 * @param {string} name
 * @param {boolean} success  true → +1 success and +1 trial; false → +1 trial only
 * @param {string} [configDir]
 * @param {number} now  epoch-ms, injected (never read from the clock)
 * @returns {{successes:number, trials:number, lastUsedAt:number}}
 */
export function recordOutcome(name, success, configDir = defaultConfigDir(), now) {
  assertFiniteNow(now);
  const key = assertSkillKey(name);
  const store = readStatsStore(configDir);
  const rec = normalizeRecord(Object.hasOwn(store, key) ? store[key] : undefined);
  rec.trials += 1;
  if (success) rec.successes += 1;
  rec.lastUsedAt = now;
  store[key] = rec;
  writeStatsStore(store, configDir);
  return rec;
}

/**
 * Seed a brand-new skill's stats at its creating outcome. A freshly
 * synthesised skill's task succeeded, so it seeds 1/1 (the Laplace prior
 * ~0.667) rather than starting at a zeroed 0/0 that reads as "unproven
 * failure". Overwrites any prior row for the name — a new synthesis
 * supersedes an archived same-name skill's stale counts.
 *
 * @param {string} name
 * @param {boolean} success  true → 1/1; false → 0/1
 * @param {string} [configDir]
 * @param {number} now  epoch-ms, injected
 * @returns {{successes:number, trials:number, lastUsedAt:number}}
 */
export function seedStats(name, success, configDir = defaultConfigDir(), now) {
  assertFiniteNow(now);
  const key = assertSkillKey(name);
  const store = readStatsStore(configDir);
  const rec = { successes: success ? 1 : 0, trials: 1, lastUsedAt: now };
  store[key] = rec;
  writeStatsStore(store, configDir);
  return rec;
}

// ── efficacy loop ────────────────────────────────────────────────────
//
// The compounding half of the confidence subsystem. For a finished task
// (done or failed) we:
//   1. recall the skills RELEVANT to the task's user message (top-K,
//      read-only, best-effort — an empty/throwing recall just skips);
//   2. seed the brand-new skill's stats at 1/1 (done tasks only) so a
//      fresh success starts sensibly;
//   3. per relevant skill: record one trial (+success on a done task),
//      recompute confidence from the REAL aggregated counts, and either
//      re-stamp the frontmatter or — when it falls below the archive
//      threshold on a failed task — archive it via the caller-supplied
//      active-recall-miss handler (no duplicated semantics).
//
// Every per-skill step is wrapped so one bad skill can't abort the rest.
// The onArchive callback is injected (learning._runActiveRecallMiss) to
// avoid an import cycle and to reuse its canonical remove/index cleanup.
//
// opts: { success, trainer?, seedName?, archiveMisses?, onArchive?, logger? }
export function runEfficacyLoop(ctx, opts = {}) {
  const configDir = ctx.configDir;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {};
  const summary = { seeded: null, updated: [], archived: [] };

  // Seed the freshly-installed skill FIRST (before recall aggregation) so
  // a done task's own new skill carries a sensible 1/1 baseline.
  if (opts.seedName) {
    try {
      seedStats(opts.seedName, opts.success, configDir, now);
      summary.seeded = opts.seedName;
    } catch (e) {
      logger(`[learning] efficacy seed failed for ${opts.seedName}: ${e?.message || e}\n`);
    }
  }

  const threshold = Number.isFinite(+ctx.archiveThreshold) ? +ctx.archiveThreshold : 0.3;
  for (const name of _recallRelevantSkills(ctx, logger)) {
    // Never double-count the just-seeded new skill as its own recall hit.
    if (name === opts.seedName) continue;
    try {
      const rec = recordOutcome(name, opts.success, configDir, now);
      const nextConf = _confidenceFromStats(ctx, name, rec, opts.trainer, now);
      if (opts.archiveMisses && nextConf < threshold) {
        if (typeof opts.onArchive === 'function') {
          opts.onArchive({ skill: { name }, configDir, cfg: ctx.cfg, archiveThreshold: threshold }, logger);
        }
        summary.archived.push(name);
      } else {
        _restampConfidence(name, nextConf, configDir);
        summary.updated.push({ name, confidence: nextConf });
      }
    } catch (e) {
      logger(`[learning] efficacy update failed for ${name}: ${e?.message || e}\n`);
    }
  }
  return summary;
}

// Query the recall index for the task's user message on the skills scope.
// Read-only, best-effort: a throwing/empty recall yields []. Returns a
// de-duplicated list of skill names.
//
// The user message is a natural-language sentence; FTS5's default AND
// semantics would make a full sentence match almost nothing, so we build
// an OR query over its significant terms (raw:true) — "which skills are
// relevant to ANY of these words" — and let bm25 + the confidence weight
// rank them. The top-K survive.
function _recallRelevantSkills(ctx, logger) {
  const query = _buildRecallQuery(ctx.task);
  if (!query) return [];
  let hits = [];
  try {
    const out = indexDb.recall(query, {
      configDir: ctx.configDir,
      scope: ['skills'],
      k: EFFICACY_RECALL_K,
      raw: true,
    });
    hits = Array.isArray(out?.hits) ? out.hits : [];
  } catch (e) {
    logger(`[learning] efficacy recall failed: ${e?.message || e}\n`);
    return [];
  }
  const names = [];
  const seen = new Set();
  for (const h of hits) {
    const n = h?.metadata?.skill_name;
    if (typeof n === 'string' && n && !seen.has(n)) { seen.add(n); names.push(n); }
  }
  return names;
}

// Build an OR-of-terms FTS5 query from the task's user turns. Extracts
// alphanumeric words ≥3 chars (drops FTS operators / punctuation / tiny
// stopwords), lowercases, de-dupes, caps the term count so a long turn
// can't blow up the MATCH, and joins with " OR ". Returns '' when the
// message has no usable terms.
function _buildRecallQuery(task) {
  const turns = Array.isArray(task?.turns) ? task.turns : [];
  const text = turns
    .filter((t) => t.agent === 'user')
    .map((t) => String(t.text || ''))
    .join(' ');
  const seen = new Set();
  const terms = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9]{3,}/g) || []) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= 20) break;
  }
  return terms.join(' OR ');
}

// Recompute a skill's confidence from its REAL aggregated stats. ageMs is
// derived from the skill's created_at frontmatter (falls back to 0 so a
// missing/unparsable date never decays). Cross-CLI dampening uses the
// trainer provider vs. the worker provider that executed the turn.
function _confidenceFromStats(ctx, name, rec, trainer, now) {
  let ageMs = 0;
  try {
    const created = _skillCreatedAtMs(name, ctx.configDir);
    if (Number.isFinite(created) && created > 0) ageMs = Math.max(0, now - created);
  } catch { /* best-effort — no decay on a missing date */ }
  return confidence.computeConfidence({
    successes: rec.successes,
    trials: rec.trials,
    ageMs,
    trainerProvider: trainer?.provider,
    workerProvider: ctx.agent?.provider || trainer?.provider,
    dampenFactor: confidence.resolveDampenFactor(ctx.cfg),
  });
}

// Parse the created_at (YYYY-MM-DD) frontmatter into epoch-ms. Returns
// NaN when the skill is missing or the date is unparsable.
function _skillCreatedAtMs(name, configDir) {
  if (!skillExists(name, configDir)) return NaN;
  const { meta } = parseFrontmatter(loadSkill(name, configDir));
  const raw = meta.created_at;
  if (!raw) return NaN;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : NaN;
}

// Re-emit a skill's SKILL.md with the recomputed confidence, preserving
// every other frontmatter field. Rebuilds through assembleSkillDoc so the
// frontmatter stays canonical (mirrors learning._runActiveRecallMiss's
// re-emit path).
function _restampConfidence(name, nextConf, configDir) {
  if (!skillExists(name, configDir)) return;
  const { meta, body } = parseFrontmatter(loadSkill(name, configDir));
  const updated = skillSynth.assembleSkillDoc({
    name,
    description: meta.description || '',
    body,
    createdBy: meta.created_by || 'agent',
    sourceTask: meta.source_task || '',
    version: Number(meta.version) || 1,
    trainedBy: meta.trained_by || null,
    trainedOnModel: meta.trained_on_model || null,
    trajectoryRef: meta.trajectory_ref || null,
    confidence: nextConf,
    outcome: meta.anti_pattern === true || meta.anti_pattern === 'true' ? 'failed' : 'done',
    group: meta.group || null,
  });
  installSkill(name, updated, configDir);
}
