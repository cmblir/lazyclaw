// mas/index_rank.mjs — pure ranking + frontmatter helpers for index_db.
//
// Extracted verbatim from index_db.mjs (behavior-preserving split) to keep
// that file under the size gate. These are pure functions: a mini frontmatter
// splitter used by reindexAll, and the confidence-aware skill-rank weighting
// used by recall(). No SQLite handle / recall core lives here.

import fs from 'node:fs';
import path from 'node:path';
import { crossCliDampen } from './confidence.mjs';

// Floor for a valid-but-low-confidence skill's ranking weight. A skill that
// scored e.g. 0.05 should be demoted hard but NOT erased from recall (the fix
// is a re-rank, not a filter). Clamping the multiplier at this floor keeps the
// worst legitimate skill just behind an unconfident 0.5 default rather than
// collapsing its relevance to ~0. Absent confidence defaults to 0.5.
export const SKILL_CONFIDENCE_FLOOR = 0.1;
export const SKILL_CONFIDENCE_DEFAULT = 0.5;

// Read the ranking-relevant frontmatter (confidence + trained_by) for a skill
// straight off disk. Best-effort: a missing file / unparseable frontmatter
// yields the default confidence and no trainer, so the skill still ranks (at
// the unconfident default) instead of being dropped. Not a strict loader —
// only the two keys the ranker weights are extracted.
export function _readSkillRankMeta(skillName, configDir) {
  const fallback = { confidence: SKILL_CONFIDENCE_DEFAULT, trainedBy: null };
  if (!skillName) return fallback;
  try {
    const filePath = path.join(configDir, 'skills', `${skillName}.md`);
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return fallback;
    const fm = m[1];
    const cm = fm.match(/^\s*confidence:\s*([0-9.]+)\s*$/m);
    const tm = fm.match(/^\s*trained_by:\s*['"]?([\w.-]+)['"]?\s*$/m);
    const conf = cm ? Number(cm[1]) : NaN;
    return {
      confidence: Number.isFinite(conf) ? conf : SKILL_CONFIDENCE_DEFAULT,
      trainedBy: tm ? tm[1] : null,
    };
  } catch { return fallback; }
}

// Confidence-aware ranking weight for a skills-scope hit (Phase 0). Multiplies
// a base relevance by the skill's frontmatter confidence (floored so a valid
// low-confidence skill is demoted, not erased) AND by confidence.crossCliDampen
// when the trainer provider family differs from the worker provider family.
// The confidence multiply always applies to skills; the cross-CLI dampen is a
// no-op (crossCliDampen returns the score unchanged) when workerProvider is
// unset or in the same family. The math lives in mas/confidence.mjs.
export function _skillRankWeight(skillName, configDir, workerProvider) {
  const { confidence, trainedBy } = _readSkillRankMeta(skillName, configDir);
  const conf = Number.isFinite(confidence) ? confidence : SKILL_CONFIDENCE_DEFAULT;
  const floored = Math.max(SKILL_CONFIDENCE_FLOOR, Math.min(1, conf));
  return crossCliDampen(floored, trainedBy, workerProvider);
}

// Minimal frontmatter splitter (trained_by / group are the only keys reindex
// needs); avoids importing skills.mjs and risking an import cycle.
export function _miniFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(raw || ''));
  if (!m) return { meta: {}, body: String(raw || '') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}
