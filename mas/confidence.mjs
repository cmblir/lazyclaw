// Confidence calculator for v5 skills — spec §0.1 H2, §3.5.
//
// Pure functions, no I/O. Used by skill_synth v2 to stamp frontmatter
// and by trajectory_store recall ranking to weight near-duplicates.
//
//   wilsonLowerBound(s, n)           — 95% Wilson lower bound on success rate.
//   crossCliDampen(score, trainer, provider) — multiply by 0.85 when trainer
//                                      provider differs from worker provider
//                                      (canonical decision §0.1 H2).
//   recencyDecay(ageMs, halfLifeMs)  — exponential decay weight (0..1].
//   computeConfidence({successes, trials, ageMs, trainer, provider})
//                                    — composed score in [0, 1].

const Z = 1.96; // 95% confidence two-sided

export function wilsonLowerBound(successes, trials) {
  const s = Number(successes) || 0;
  const n = Number(trials) || 0;
  if (n <= 0) return 0;
  const phat = s / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = Z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const lb = (center - margin) / denom;
  return Math.max(0, Math.min(1, lb));
}

const PROVIDER_FAMILY = {
  'claude-cli': 'anthropic',
  'anthropic': 'anthropic',
  'codex-cli': 'openai',
  'openai': 'openai',
  'gemini-cli': 'gemini',
  'gemini': 'gemini',
  'ollama': 'ollama',
};

export function sameFamily(a, b) {
  if (!a || !b) return false;
  return PROVIDER_FAMILY[a] === PROVIDER_FAMILY[b];
}

export function crossCliDampen(score, trainerProvider, workerProvider) {
  if (!trainerProvider || !workerProvider) return score;
  if (sameFamily(trainerProvider, workerProvider)) return score;
  return score * 0.85;
}

export function recencyDecay(ageMs, halfLifeMs = 30 * 24 * 60 * 60 * 1000) {
  const t = Math.max(0, Number(ageMs) || 0);
  const hl = Math.max(1, Number(halfLifeMs) || 1);
  return Math.pow(0.5, t / hl);
}

export function computeConfidence({ successes = 0, trials = 0, ageMs = 0, trainerProvider = null, workerProvider = null, halfLifeMs } = {}) {
  const base = wilsonLowerBound(successes, trials);
  const decayed = base * recencyDecay(ageMs, halfLifeMs);
  const dampened = crossCliDampen(decayed, trainerProvider, workerProvider);
  return Math.max(0, Math.min(1, dampened));
}
