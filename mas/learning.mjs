// mas/learning.mjs — v5.0 spec §3.6 / canonical decision C2.
//
// Canonical funnel for the five post-task learning triggers. Every
// learning signal (a finished task, an active-recall miss, a periodic
// curation pass, etc.) lands in `runLearning(trigger, ctx)` so the
// orchestra hub has exactly one fan-out site rather than five scattered
// `import x.synthesize`/`y.persist` call chains.
//
// Triggers (frozen list — caller-side enum):
//   post-task            — a task finished successfully. Persist the
//                          trajectory, synthesise a SKILL.md, update the
//                          USER.md dialectic model, stamp confidence.
//   post-failure         — a task failed. Synthesise an anti-pattern
//                          skill so a future agent avoids the same trap.
//   nudge                — a nudge cluster accumulated enough evidence
//                          to be worth distilling. Phase 2 fully wires
//                          this; v5.0.10 keeps the dispatch hook so
//                          callers can opt in early.
//   active-recall-miss   — a skill was recalled but failed to apply.
//                          Decrement its confidence; archive when it
//                          falls below the activation threshold.
//   periodic-curation    — cron-driven skills_curator replay. Phase 2
//                          full implementation; v5.0.10 emits a warning
//                          and returns a no-op result so a cron entry
//                          configured today does not crash.
//
// Hard contract: a single broken handler MUST NOT poison the others.
// Each sub-routine is wrapped in its own try/catch so e.g. a missing
// trainer api-key won't block the trajectory write.

import * as trajectoryStore from './trajectory_store.mjs';
import * as skillSynth from './skill_synth.mjs';
import * as userModeler from './user_modeler.mjs';
import * as confidence from './confidence.mjs';
import * as skills from '../skills.mjs';
import { resolveTrainer } from '../providers/registry.mjs';
import { hasClaudeCliSession } from '../providers/claude_cli_detect.mjs';

export const TRIGGERS = Object.freeze([
  'post-task',
  'post-failure',
  'nudge',
  'active-recall-miss',
  'periodic-curation',
]);

export class LearningError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LearningError';
    this.code = code || 'LEARNING_ERR';
  }
}

// Public entry point. Returns { trigger, results, errors }; never throws
// for a known trigger — the caller (orchestrator microtask, mention
// router) expects best-effort semantics. Unknown triggers return an
// `{ error: 'UNKNOWN_TRIGGER' }` envelope so a typo in config surfaces
// loudly without taking down the calling stream.
export async function runLearning(trigger, ctx = {}) {
  if (!TRIGGERS.includes(trigger)) {
    return { trigger, error: 'UNKNOWN_TRIGGER', known: TRIGGERS.slice() };
  }
  const logger = typeof ctx.logger === 'function' ? ctx.logger : () => {};
  switch (trigger) {
    case 'post-task':           return await _runPostTask(ctx, logger);
    case 'post-failure':        return await _runPostFailure(ctx, logger);
    case 'nudge':               return await _runNudge(ctx, logger);
    case 'active-recall-miss':  return await _runActiveRecallMiss(ctx, logger);
    case 'periodic-curation':   return await _runPeriodicCuration(ctx, logger);
    default:
      return { trigger, error: 'UNKNOWN_TRIGGER' };
  }
}

// ── post-task ────────────────────────────────────────────────────────
//
// ctx: { agent, task, configDir, cfg, transcript?, trajectoryRef?,
//        apiKey?, baseUrl?, fetchImpl? }
//
// Runs four sub-routines independently:
//   1. trajectory_store.put       — durable evidence (FTS5 mirror too).
//   2. synthesizeSkill            — distil a reusable SKILL.md.
//   3. updateUserModel            — Honcho-style dialectic USER.md.
//   4. computeConfidence          — stamp on the trained skill record.
export async function _runPostTask(ctx, logger) {
  const errors = [];
  const results = {};
  const trainer = _safeResolveTrainer(ctx.cfg, ctx.agent);

  // 1. trajectory_store.put
  try {
    const rec = _buildTrajectoryRecord(ctx, 'done');
    // Stamp the trainer provider/model on the trajectory so a later
    // recall + cross-CLI dampening lookup can see who synthesised the
    // signal vs. who executed the turn (canonical decision H2).
    rec.trainerProvider = trainer.provider || '';
    rec.trainerModel = trainer.model || '';
    results.trajectory = await trajectoryStore.put(rec, { configDir: ctx.configDir });
  } catch (e) {
    errors.push({ step: 'trajectory', error: String(e?.message || e) });
    logger(`[learning] trajectory put failed: ${e?.message || e}\n`);
  }

  // 2. computeConfidence — pure function, no I/O. We hoist this above
  //    synthesizeSkill so the v5 frontmatter actually gets the
  //    confidence value (M1). Without the hoist, synthesise wrote
  //    `confidence: null` even though the loop computed the score
  //    afterwards.
  try {
    results.confidence = confidence.computeConfidence({
      successes: 1,
      trials: 1,
      ageMs: 0,
      trainerProvider: trainer.provider,
      workerProvider: ctx.agent?.provider || trainer.provider,
      dampenFactor: confidence.resolveDampenFactor(ctx.cfg),
    });
  } catch (e) {
    errors.push({ step: 'confidence', error: String(e?.message || e) });
  }

  // 3. synthesizeSkill (best-effort — needs an agent + provider key).
  //    All v5 frontmatter fields land here (trained_by, confidence,
  //    trajectory_ref) so the produced SKILL.md is ready for recall +
  //    cross-CLI dampening without a follow-up patch.
  if (ctx.agent && ctx.task) {
    try {
      results.skill = await skillSynth.synthesizeSkill({
        agent: { ...ctx.agent, provider: trainer.provider, model: trainer.model },
        task: ctx.task,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        fetchImpl: ctx.fetchImpl,
        outcome: 'done',
        trainedBy: trainer.provider,
        trainedOnModel: trainer.model,
        trajectoryRef: results.trajectory?.id || null,
        confidence: results.confidence,
      });
      // Persist the produced SKILL.md into the shared skills/ dir so the
      // next agent turn's recall surfaces it. installSynthesized forwards
      // every v5 frontmatter field (see Group A — C6 fix in skill_synth).
      if (results.skill && ctx.configDir) {
        try {
          results.installed = skillSynth.installSynthesized({
            name: results.skill.name,
            description: results.skill.description,
            body: results.skill.body,
            sourceTask: ctx.task.id || '',
            createdBy: 'agent',
            trainedBy: trainer.provider,
            trainedOnModel: trainer.model,
            trajectoryRef: results.trajectory?.id || null,
            confidence: results.confidence,
            outcome: 'done',
          }, ctx.configDir);
        } catch (e) {
          errors.push({ step: 'skillInstall', error: String(e?.message || e) });
          logger(`[learning] skill install failed: ${e?.message || e}\n`);
        }
      }
    } catch (e) {
      errors.push({ step: 'skill', error: String(e?.message || e) });
      logger(`[learning] skill synth failed: ${e?.message || e}\n`);
    }
  }

  // 4. updateUserModel — needs session turns (any normalised
  //    [{role, content}] list). Falls back to task.turns translated.
  if (ctx.sessionTurns || ctx.task?.turns) {
    try {
      results.userModel = await userModeler.updateUserModel({
        sessionTurns: ctx.sessionTurns || _toSessionTurns(ctx.task.turns),
        provider: trainer.provider,
        model: trainer.model,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        fetchImpl: ctx.fetchImpl,
        configDir: ctx.configDir,
      });
    } catch (e) {
      errors.push({ step: 'userModel', error: String(e?.message || e) });
      logger(`[learning] user model update failed: ${e?.message || e}\n`);
    }
  }

  return { trigger: 'post-task', results, errors };
}

// ── post-failure ─────────────────────────────────────────────────────
//
// Same shape as post-task but synthesizeSkill runs with outcome:
// 'failed' so the resulting SKILL.md is tagged anti_pattern: true and
// grouped under 'anti-pattern'.
export async function _runPostFailure(ctx, logger) {
  const errors = [];
  const results = {};
  const trainer = _safeResolveTrainer(ctx.cfg, ctx.agent);

  try {
    const rec = _buildTrajectoryRecord(ctx, 'failed');
    results.trajectory = await trajectoryStore.put(rec, { configDir: ctx.configDir });
  } catch (e) {
    errors.push({ step: 'trajectory', error: String(e?.message || e) });
    logger(`[learning] failure trajectory put failed: ${e?.message || e}\n`);
  }

  if (ctx.agent && ctx.task) {
    try {
      results.skill = await skillSynth.synthesizeSkill({
        agent: { ...ctx.agent, provider: trainer.provider, model: trainer.model },
        task: ctx.task,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        fetchImpl: ctx.fetchImpl,
        outcome: 'failed',
        trainedBy: trainer.provider,
        trainedOnModel: trainer.model,
        trajectoryRef: results.trajectory?.id || null,
      });
    } catch (e) {
      errors.push({ step: 'skill', error: String(e?.message || e) });
      logger(`[learning] anti-pattern synth failed: ${e?.message || e}\n`);
    }
  }

  return { trigger: 'post-failure', results, errors };
}

// ── nudge ────────────────────────────────────────────────────────────
//
// A nudge cluster is a group of low-confidence signals that, taken
// together, are worth a skill. v5.0.10 wires the dispatch path and
// runs synthesizeSkill against the cluster's representative task; the
// full cluster-collapse engine lands in Phase 2.
export async function _runNudge(ctx, logger) {
  const errors = [];
  const results = {};
  const cluster = ctx.cluster;
  if (!cluster || !Array.isArray(cluster.items) || cluster.items.length === 0) {
    return { trigger: 'nudge', results: {}, errors: [{ step: 'cluster', error: 'empty cluster' }] };
  }
  const trainer = _safeResolveTrainer(ctx.cfg, ctx.agent);
  const representative = cluster.items[cluster.items.length - 1];
  try {
    results.skill = await skillSynth.synthesizeSkill({
      agent: { ...(ctx.agent || {}), provider: trainer.provider, model: trainer.model },
      task: representative,
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      fetchImpl: ctx.fetchImpl,
      outcome: 'done',
      trainedBy: trainer.provider,
      trainedOnModel: trainer.model,
    });
  } catch (e) {
    errors.push({ step: 'skill', error: String(e?.message || e) });
    logger(`[learning] nudge synth failed: ${e?.message || e}\n`);
  }
  return { trigger: 'nudge', results, errors };
}

// ── active-recall-miss ───────────────────────────────────────────────
//
// A skill was loaded into context but failed to apply. Decrement its
// confidence (frontmatter); archive (remove) the skill when confidence
// drops below 0.3 so it stops bloating future system prompts.
//
// ctx: { skill: { name }, configDir, cfg, archiveThreshold? }
export async function _runActiveRecallMiss(ctx, logger) {
  const errors = [];
  const results = {};
  const name = ctx.skill?.name;
  if (!name) {
    return { trigger: 'active-recall-miss', results: {}, errors: [{ step: 'input', error: 'skill.name required' }] };
  }
  const threshold = Number.isFinite(+ctx.archiveThreshold) ? +ctx.archiveThreshold : 0.3;
  try {
    if (!skills.skillExists(name, ctx.configDir)) {
      return { trigger: 'active-recall-miss', results: { skipped: 'not found' }, errors };
    }
    const raw = skills.loadSkill(name, ctx.configDir);
    const { meta, body } = skills.parseFrontmatter(raw);
    const priorConf = Number(meta.confidence);
    const baseConf = Number.isFinite(priorConf) ? priorConf : 0.5;
    const nextConf = Math.max(0, baseConf - 0.1);
    if (nextConf < threshold) {
      skills.removeSkill(name, ctx.configDir);
      results.action = 'archived';
      results.priorConfidence = baseConf;
      results.nextConfidence = nextConf;
    } else {
      // Re-emit the file with the decremented confidence. We rebuild
      // through assembleSkillDoc so the frontmatter stays canonical.
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
      skills.installSkill(name, updated, ctx.configDir);
      results.action = 'decremented';
      results.priorConfidence = baseConf;
      results.nextConfidence = nextConf;
    }
  } catch (e) {
    errors.push({ step: 'decrement', error: String(e?.message || e) });
    logger(`[learning] active-recall-miss handler failed: ${e?.message || e}\n`);
  }
  return { trigger: 'active-recall-miss', results, errors };
}

// ── periodic-curation ────────────────────────────────────────────────
//
// Phase 2 full implementation. v5.0.10 emits a structured warning so a
// cron entry created today returns a stable shape and operators can see
// the hook fired without blowing up.
export async function _runPeriodicCuration(_ctx, logger) {
  logger('[learning] periodic-curation is a Phase 2 hook — no-op for now.\n');
  return { trigger: 'periodic-curation', results: { stub: true }, errors: [] };
}

// ── helpers ──────────────────────────────────────────────────────────

let _trainerNoticed = false;

function _safeResolveTrainer(cfg, agent) {
  try {
    const c = cfg || { provider: agent?.provider, model: agent?.model };
    // Use real claude-cli session detection in production (the resolver's own
    // default stub only checked an env var that `claude login` never sets).
    const resolved = resolveTrainer(c, { detectClaudeCli: hasClaudeCliSession });
    // Honesty: if the user asked for trainer.provider:'auto' but no claude-cli
    // session was found, the learning loop bills the chat provider — say so once
    // so the "$0 on Claude Pro" promise never fails silently.
    if (!_trainerNoticed && c && c.trainer && c.trainer.provider === 'auto' && resolved.provider !== 'claude-cli') {
      _trainerNoticed = true;
      try {
        process.stderr.write(`[trainer] no claude-cli session detected → learning will use "${resolved.provider || 'the chat provider'}" (billed per token). Run 'claude login', or set trainer.provider explicitly, to control cost.\n`);
      } catch { /* stderr closed */ }
    }
    return resolved;
  } catch {
    return { provider: agent?.provider || '', model: agent?.model || '' };
  }
}

function _toSessionTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.map((t) => ({
    role: t.agent === 'user' ? 'user' : 'assistant',
    content: String(t.text || ''),
  }));
}

function _buildTrajectoryRecord(ctx, outcome) {
  const task = ctx.task || {};
  const agent = ctx.agent || {};
  const turns = Array.isArray(task.turns) ? task.turns : [];
  return {
    taskId: task.id || '',
    agentName: agent.name || 'agent',
    workerProvider: agent.provider || '',
    workerModel: agent.model || '',
    startedAt: ctx.trajectoryRef?.startedAt || Date.now(),
    endedAt: Date.now(),
    systemPrompt: agent.role || '',
    userMessages: turns.filter(t => t.agent === 'user').map(t => String(t.text || '')),
    turns: turns.map((t, i) => ({
      turnIdx: i,
      role: t.agent === 'user' ? 'user' : 'assistant',
      content: String(t.text || ''),
      toolCalls: Array.isArray(t.toolCalls) ? t.toolCalls : [],
    })),
    finalAnswer: turns.length ? String(turns[turns.length - 1].text || '') : '',
    outcome,
  };
}
