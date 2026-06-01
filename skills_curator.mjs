// Skill lifecycle curator — usage tracking, freshness classification and
// recoverable archival layered over the <configDir>/skills/ store from
// skills.mjs.
//
// Skills accrete: agents synthesise new ones on the fly (created_by:
// agent) and most are never touched again. Left unchecked the recall
// index (skillsIndex) bloats the system prompt with dead weight. This
// module ages skills out: it counts how often each is recalled, marks
// them active / stale / archived by idle time, and physically moves the
// long-idle *agent-authored* skills into <configDir>/skills/.archive/
// where they no longer appear in listSkills but remain recoverable.
//
// Human-authored skills are NEVER archived — they're curated by people,
// not garbage to be collected.
//
// Determinism: every time-dependent function takes an injected `now`
// (epoch-ms). The core logic never reads the wall-clock, so the 30d /
// 90d boundaries are exactly reproducible in tests.

import fs from 'node:fs';
import path from 'node:path';

import {
  defaultConfigDir,
  skillsDir,
  skillPath,
  listSkills,
  parseFrontmatter,
} from './skills.mjs';

// Freshness windows, measured in idle time since lastUsedAt.
//   active   : used within the last 30 days
//   stale    : 30..90 days idle
//   archived : 90+ days idle (and, for curate(), agent-authored)
const DAY_MS = 24 * 60 * 60 * 1000;
export const STALE_MS = 30 * DAY_MS;
export const ARCHIVE_MS = 90 * DAY_MS;

const USAGE_FILENAME = '.usage.json';
const ARCHIVE_DIRNAME = '.archive';
const SKILL_EXT = '.md';

// Guard for the injected clock. The whole module is deterministic only
// because `now` is supplied by the caller; a NaN / Infinity / non-number
// would make every idle comparison false and silently classify all
// skills as 'archived', so we refuse it loudly instead.
function assertFiniteNow(now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new TypeError(`now must be a finite number (got ${String(now)})`);
  }
  return now;
}

// Validate a skill identifier used as a key into the usage store.
// Reserved prototype keys ('__proto__' etc.) are NOT rejected here:
// the store is a null-prototype object, so they round-trip safely as
// ordinary own properties. We only insist on a non-empty string so a
// number / undefined / object can never become a phantom key.
function assertSkillKey(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`skill name must be a non-empty string (got ${String(name)})`);
  }
  return name;
}

function usagePath(configDir = defaultConfigDir()) {
  return path.join(skillsDir(configDir), USAGE_FILENAME);
}

function archiveDir(configDir = defaultConfigDir()) {
  return path.join(skillsDir(configDir), ARCHIVE_DIRNAME);
}

// Read the whole usage map ({ <name>: { views, uses, lastUsedAt } }).
// A missing or corrupt file is treated as empty so a single bad write
// never bricks the tracker.
//
// The returned map is a null-prototype object, and only OWN enumerable
// keys of the parsed JSON are copied in. This is a hard prototype-
// pollution boundary: a hostile usage file carrying a `__proto__` /
// `constructor` payload can neither poison Object.prototype nor leak an
// inherited counter into an unrelated skill's read.
function readUsageStore(configDir = defaultConfigDir()) {
  const p = usagePath(configDir);
  const store = Object.create(null);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return store;
  }
  if (!parsed || typeof parsed !== 'object') return store;
  for (const key of Object.keys(parsed)) {
    // JSON.parse already refuses to set a real `__proto__` accessor, but
    // a literal "__proto__" string key still arrives as an own property;
    // copy it onto the null-prototype map as plain data.
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
function writeUsageStore(store, configDir = defaultConfigDir()) {
  const dir = skillsDir(configDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = usagePath(configDir);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, p);
}

// Normalise a raw record into the full counter shape with sane zeros so
// callers never have to null-check individual fields.
function normalizeRecord(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    views: Number.isFinite(r.views) ? r.views : 0,
    uses: Number.isFinite(r.uses) ? r.uses : 0,
    lastUsedAt: Number.isFinite(r.lastUsedAt) ? r.lastUsedAt : 0,
  };
}

/**
 * Bump a skill's usage counters and stamp lastUsedAt with the injected
 * `now`. Both `views` and `uses` increment on each call — they're kept
 * separate so a future "viewed the index but didn't pull the body"
 * signal can diverge from a real recall without a schema change.
 *
 * @param {string} name
 * @param {string} [configDir]
 * @param {number} now  epoch-ms, injected (never read from the clock)
 * @returns {{views:number, uses:number, lastUsedAt:number}}
 */
export function recordUsage(name, configDir = defaultConfigDir(), now) {
  assertFiniteNow(now);
  const key = assertSkillKey(name);
  const store = readUsageStore(configDir);
  // store is null-prototype, so store[key] never reaches the prototype
  // chain even for reserved names like '__proto__'; Object.hasOwn keeps
  // reads explicit regardless.
  const rec = normalizeRecord(Object.hasOwn(store, key) ? store[key] : undefined);
  rec.views += 1;
  rec.uses += 1;
  rec.lastUsedAt = now;
  store[key] = rec;
  writeUsageStore(store, configDir);
  return rec;
}

/**
 * Read a skill's counters. Returns a zeroed record (never throws) when
 * the skill has no recorded usage yet.
 *
 * @param {string} name
 * @param {string} [configDir]
 * @returns {{views:number, uses:number, lastUsedAt:number}}
 */
export function usageOf(name, configDir = defaultConfigDir()) {
  const key = assertSkillKey(name);
  const store = readUsageStore(configDir);
  // Object.hasOwn guards against pulling an inherited value out of a
  // hostile usage file; the store is null-prototype anyway, but this
  // keeps the read intent explicit and prototype-safe.
  return normalizeRecord(Object.hasOwn(store, key) ? store[key] : undefined);
}

/**
 * Classify a skill by how long it has been idle relative to the
 * injected `now`. A skill that has never been used (lastUsedAt 0) is
 * treated as maximally idle, so at any real epoch it classifies as
 * 'archived'.
 *
 *   idle < 30d            → 'active'
 *   30d <= idle < 90d     → 'stale'
 *   idle >= 90d           → 'archived'
 *
 * @param {string} skillName
 * @param {string} [configDir]
 * @param {number} now  epoch-ms, injected
 * @returns {'active'|'stale'|'archived'}
 */
export function classify(skillName, configDir = defaultConfigDir(), now) {
  assertFiniteNow(now);
  const { lastUsedAt } = usageOf(skillName, configDir);
  const idle = now - lastUsedAt;
  if (idle < STALE_MS) return 'active';
  if (idle < ARCHIVE_MS) return 'stale';
  return 'archived';
}

// Read a skill's created_by frontmatter without surfacing read errors —
// an unreadable skill is treated as having no author, which keeps it out
// of the agent-only archival path (we never auto-archive what we can't
// positively identify as agent-authored).
function createdByOf(name, configDir) {
  try {
    const { meta } = parseFrontmatter(fs.readFileSync(skillPath(name, configDir), 'utf8'));
    return meta.created_by || '';
  } catch {
    return '';
  }
}

/**
 * Sweep the live skills store and age skills out by freshness. Skills
 * that have been idle for 90+ days AND were agent-authored
 * (created_by: agent) are physically moved into
 * <configDir>/skills/.archive/<name>.md — recoverable, but no longer
 * surfaced by listSkills/skillsIndex. Human-authored skills are never
 * touched, even when long idle (they're reported under `stale` so the
 * caller can still see them).
 *
 * Each skill's body runs in its own try/catch so a single malformed
 * entry (e.g. a leading-dot name that skillPath rejects) is skipped and
 * collected under `invalid` rather than aborting the whole sweep.
 *
 * @param {string} [configDir]
 * @param {number} now  epoch-ms, injected
 * @returns {{archived:string[], stale:string[], active:string[], invalid:string[]}}
 */
export function curate(configDir = defaultConfigDir(), now) {
  assertFiniteNow(now);
  const result = { archived: [], stale: [], active: [], invalid: [] };

  // listSkills already filters to top-level .md files, so the archive
  // subdir is naturally excluded from this sweep.
  for (const skill of listSkills(configDir)) {
    try {
      const bucket = classify(skill.name, configDir, now);
      if (bucket === 'active') {
        result.active.push(skill.name);
        continue;
      }
      if (bucket === 'stale') {
        result.stale.push(skill.name);
        continue;
      }
      // bucket === 'archived': only physically archive agent-authored
      // skills. Human-authored idle skills are reported as stale instead
      // of being moved — people curate those, we don't.
      const createdBy = skill.createdBy || createdByOf(skill.name, configDir);
      if (createdBy !== 'agent') {
        result.stale.push(skill.name);
        continue;
      }
      moveToArchive(skill.name, configDir, now);
      // Drop the stale usage record so a later same-name skill starts
      // from a clean slate instead of inheriting this lastUsedAt (which
      // would get it re-archived before its first real use).
      dropUsageRecord(skill.name, configDir);
      result.archived.push(skill.name);
    } catch {
      // A single bad skill (invalid name, unreadable file, failed move)
      // must never abort curation of the rest. Collect it and move on.
      result.invalid.push(skill.name);
    }
  }

  return result;
}

// Move a single skill file from the live store into .archive/, creating
// the archive dir on demand. rename is atomic on the same filesystem;
// fall back to copy+unlink for cross-device stores (e.g. tmpfs vs disk).
//
// On a destination collision (a prior archived copy of the same name)
// the new copy is disambiguated as <name>.<archivedAtMs>.md so the
// earlier, recoverable archive is never clobbered.
function moveToArchive(name, configDir, archivedAtMs) {
  const src = skillPath(name, configDir);
  const destDir = archiveDir(configDir);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = pickArchiveDest(destDir, name, archivedAtMs);
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
  return dest;
}

// Choose a non-colliding archive destination. The preferred path is
// <name>.md; if that already holds a prior archive, fall back to
// <name>.<archivedAtMs>.md, and if even that is taken (same name
// archived twice at the same instant) append an incrementing suffix.
function pickArchiveDest(destDir, name, archivedAtMs) {
  const preferred = path.join(destDir, `${name}${SKILL_EXT}`);
  if (!fs.existsSync(preferred)) return preferred;
  const stampBase = `${name}.${archivedAtMs}`;
  let candidate = path.join(destDir, `${stampBase}${SKILL_EXT}`);
  for (let i = 1; fs.existsSync(candidate) && i < 1000; i++) {
    candidate = path.join(destDir, `${stampBase}.${i}${SKILL_EXT}`);
  }
  // Never return a path that still exists — clobbering a prior archived
  // copy would break the "recoverable" guarantee. curate() surfaces this
  // skill under `invalid` instead.
  if (fs.existsSync(candidate)) {
    throw new Error(`archive destination exhausted for "${name}"`);
  }
  return candidate;
}

// Remove a skill's usage record (used after archival so a re-created
// same-name skill does not inherit a stale lastUsedAt). No-op when the
// skill has no recorded usage.
function dropUsageRecord(name, configDir) {
  const key = assertSkillKey(name);
  const store = readUsageStore(configDir);
  if (!Object.hasOwn(store, key)) return;
  delete store[key];
  writeUsageStore(store, configDir);
}
