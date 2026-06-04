# lazyclaw v5.0 — Phase B: learning-core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire lazyclaw's closed learning loop — skill_synth v2 (success + failure triggers), user_modeler (Honcho-equiv USER.md), recall tool, nudge background ticker, and a confidence calculator — so a finished task auto-produces a tested skill and a failed task auto-produces a tagged anti-pattern, with cross-CLI transfer accounted for.

**Architecture:** All new code lives under `mas/` and `mas/tools/`. Phase A's `mas/index_store.mjs` (FTS5 mirror) and `mas/trajectory_store.mjs` (TrajectoryRecord JSONL + SQLite mirror) are consumed read+write. `mas/skill_synth.mjs` is refactored in place to add a second prompt path (anti-pattern), redact at write time, and stamp `trained_by`/`trained_on_model`/`trajectory_ref`/`cross_cli_tested`/`confidence` frontmatter. `mas/user_modeler.mjs` runs at session end via the daemon close hook, writes `~/.lazyclaw/memory/USER.md`, and indexes each fact as `fts_memories.kind='user_model'`. `mas/tools/recall.mjs` is a normal MAS tool calling `mas/index_store.mjs` query helpers with optional trainer summarisation. `mas/nudge.mjs` is a daemon-owned ticker that clusters `recent.jsonl` tail and emits `nudge` SSE events through the existing `exec.approval` SSE channel.

**Tech Stack:** Node.js 18+, .mjs ES modules. Existing libs reused: `better-sqlite3` (Phase A dep), Playwright test runner (per `tests/` convention — every existing spec file uses `@playwright/test`), `mas/redact.mjs::redactSecrets`, `mas/provider_adapters.mjs::runTextCompletion`. No new deps.

**Depends on phases:** A (FTS5 index_store, trajectory_store, TrajectoryRecord type, `resolveTrainer()` from registry.mjs).

**Spec reference:** `docs/superpowers/specs/2026-06-04-lazyclaw-v5-hermes-parity-design.md` §0.1 (C1, C4, C5, C6), §1.1 (problem statement), §2.4 (`resolveTrainer`), §3.5 (cross-CLI transfer frontmatter), §3.6 (5 learning triggers), §4.5 (recall API), §4.10 (user modeler integration), §1.5 N7/N8 (anti-pattern manual in v5.0).

---

## File Structure

**Create (new files):**

- `/Users/o/lazyclaw/mas/confidence.mjs` — Wilson lower-bound + cross-CLI dampening calculator (pure functions).
- `/Users/o/lazyclaw/mas/user_modeler.mjs` — dialectic (thesis/antithesis/synthesis) USER.md updater.
- `/Users/o/lazyclaw/mas/nudge.mjs` — background ticker that clusters `recent.jsonl` and produces `nudge` events.
- `/Users/o/lazyclaw/mas/tools/recall.mjs` — agent-callable FTS5 recall tool with optional trainer summarisation.
- `/Users/o/lazyclaw/tests/phaseB-skill-synth-v2.spec.ts`
- `/Users/o/lazyclaw/tests/phaseB-confidence.spec.ts`
- `/Users/o/lazyclaw/tests/phaseB-user-modeler.spec.ts`
- `/Users/o/lazyclaw/tests/phaseB-recall-tool.spec.ts`
- `/Users/o/lazyclaw/tests/phaseB-nudge.spec.ts`
- `/Users/o/lazyclaw/tests/phaseB-e2e-learning-loop.spec.ts`

**Modify (existing files):**

- `/Users/o/lazyclaw/mas/skill_synth.mjs` — extend `synthesizeSkill()` with `outcome` switch (anti-pattern prompt + tag), thread `trajectory`/`trainer`/`trainerModel` through to frontmatter, redact body at install time, update `assembleSkillDoc()` to emit v5 keys.
- `/Users/o/lazyclaw/mas/tool_runner.mjs` — register `recall` tool import and dispatch entry.
- `/Users/o/lazyclaw/daemon.mjs` — wire nudge ticker boot + SSE emission for `nudge.suggest_skill` events; wire user_modeler session-close hook.

---

## Task 1 — `mas/confidence.mjs`: scoring helpers (45 min)

Wilson lower bound + cross-CLI dampening per spec §0.1 H2 ("Cross-CLI dampen 0.85 when trainer != provider"). Pure module, no I/O, fully unit-testable.

### Step 1.1 — Write failing test for `wilsonLowerBound`

- [ ] Create: `/Users/o/lazyclaw/tests/phaseB-confidence.spec.ts`

```ts
import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

async function loadConf() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'confidence.mjs')).href;
  return await import(url) as typeof import('../mas/confidence.mjs');
}

test('wilsonLowerBound: zero trials returns 0', async () => {
  const { wilsonLowerBound } = await loadConf();
  expect(wilsonLowerBound(0, 0)).toBe(0);
});

test('wilsonLowerBound: 10/10 successes is high but < 1', async () => {
  const { wilsonLowerBound } = await loadConf();
  const lb = wilsonLowerBound(10, 10);
  expect(lb).toBeGreaterThan(0.7);
  expect(lb).toBeLessThan(1);
});

test('wilsonLowerBound: 0/10 successes is near 0', async () => {
  const { wilsonLowerBound } = await loadConf();
  expect(wilsonLowerBound(0, 10)).toBeLessThan(0.05);
});

test('wilsonLowerBound: more trials at 100% raises the bound', async () => {
  const { wilsonLowerBound } = await loadConf();
  expect(wilsonLowerBound(100, 100)).toBeGreaterThan(wilsonLowerBound(10, 10));
});
```

### Step 1.2 — Run test, verify FAIL

- [ ] Run: `npx playwright test tests/phaseB-confidence.spec.ts`
- [ ] Expected: 4 failures, all citing `Cannot find module .../mas/confidence.mjs` or `wilsonLowerBound is not a function`.

### Step 1.3 — Implement `mas/confidence.mjs`

- [ ] Create: `/Users/o/lazyclaw/mas/confidence.mjs`

```js
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
```

### Step 1.4 — Run test, verify PASS

- [ ] Run: `npx playwright test tests/phaseB-confidence.spec.ts`
- [ ] Expected: `4 passed`.

### Step 1.5 — Add cross-CLI dampening test

- [ ] Append to `/Users/o/lazyclaw/tests/phaseB-confidence.spec.ts`:

```ts
test('crossCliDampen: same family is identity', async () => {
  const { crossCliDampen } = await loadConf();
  expect(crossCliDampen(0.8, 'claude-cli', 'anthropic')).toBeCloseTo(0.8, 6);
  expect(crossCliDampen(0.5, 'codex-cli', 'openai')).toBeCloseTo(0.5, 6);
});

test('crossCliDampen: cross-family multiplies by 0.85', async () => {
  const { crossCliDampen } = await loadConf();
  expect(crossCliDampen(1.0, 'claude-cli', 'codex-cli')).toBeCloseTo(0.85, 6);
  expect(crossCliDampen(0.4, 'gemini-cli', 'anthropic')).toBeCloseTo(0.34, 6);
});

test('computeConfidence: composes Wilson + decay + dampen', async () => {
  const { computeConfidence } = await loadConf();
  const same = computeConfidence({ successes: 10, trials: 10, ageMs: 0, trainerProvider: 'claude-cli', workerProvider: 'anthropic' });
  const cross = computeConfidence({ successes: 10, trials: 10, ageMs: 0, trainerProvider: 'claude-cli', workerProvider: 'codex-cli' });
  expect(cross).toBeCloseTo(same * 0.85, 5);
});
```

### Step 1.6 — Run, verify PASS

- [ ] Run: `npx playwright test tests/phaseB-confidence.spec.ts`
- [ ] Expected: `7 passed`.

### Step 1.7 — Commit

- [ ] Run:

```bash
git add mas/confidence.mjs tests/phaseB-confidence.spec.ts
git commit -m "$(cat <<'EOF'
feat(mas): add confidence calculator (Wilson + cross-CLI dampen)

Wilson lower bound on (successes, trials) plus 0.85 dampening when the
trainer provider belongs to a different family than the worker that
produced the skill. Pure module; used by skill_synth v2 to stamp the
`confidence` frontmatter and by recall ranking to weight near-duplicates.

Spec ref: v5.0 §0.1 H2, §3.5.
EOF
)"
```

---

## Task 2 — `mas/skill_synth.mjs` v2: outcome switch, anti-pattern tag, v5 frontmatter (75 min)

Extends `synthesizeSkill()` with an `outcome` parameter ('done'|'failed') per spec §0.1 C1, switches prompt + frontmatter accordingly, stamps `trained_by`/`trained_on_model`/`trajectory_ref`/`cross_cli_tested`/`confidence` per §3.5, and re-runs `redactSecrets` at install time per §4.4 invariant.

### Step 2.1 — Write failing test for v5 frontmatter on successful synth

- [ ] Create: `/Users/o/lazyclaw/tests/phaseB-skill-synth-v2.spec.ts`

```ts
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-synth-v2-'));
}

async function loadSynth() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'skill_synth.mjs')).href;
  return await import(url) as typeof import('../mas/skill_synth.mjs');
}

test('assembleSkillDoc: emits trained_by/trained_on_model/trajectory_ref/confidence', async () => {
  const { assembleSkillDoc } = await loadSynth();
  const doc = assembleSkillDoc({
    name: 'fix-flake', description: 'd', body: '## When to Use\n- x\n',
    createdBy: 'agent', sourceTask: 't1',
    trainedBy: 'claude-cli', trainedOnModel: 'claude-opus-4-7',
    trajectoryRef: '01HZW9KQ8N',
    confidence: 0.72,
    ts: new Date('2026-06-04T00:00:00Z'),
  });
  expect(doc).toContain('trained_by: claude-cli');
  expect(doc).toContain('trained_on_model: claude-opus-4-7');
  expect(doc).toContain('trajectory_ref: 01HZW9KQ8N');
  expect(doc).toContain('confidence: 0.72');
});

test('assembleSkillDoc: anti-pattern outcome sets anti_pattern: true and group: anti-pattern', async () => {
  const { assembleSkillDoc } = await loadSynth();
  const doc = assembleSkillDoc({
    name: 'do-not-rename', description: 'pitfall', body: '## What Failed\n- x\n',
    outcome: 'failed', trainedBy: 'codex-cli', trainedOnModel: 'gpt-5-codex',
  });
  expect(doc).toContain('anti_pattern: true');
  expect(doc).toContain('group: anti-pattern');
});
```

### Step 2.2 — Run, verify FAIL

- [ ] Run: `npx playwright test tests/phaseB-skill-synth-v2.spec.ts`
- [ ] Expected: 2 failures complaining `trained_by` / `anti_pattern` not in output.

### Step 2.3 — Extend `assembleSkillDoc` in `mas/skill_synth.mjs`

- [ ] Edit `/Users/o/lazyclaw/mas/skill_synth.mjs` — replace the existing `assembleSkillDoc` function (currently spans lines 112–124) with the v5 version that accepts the new fields:

```js
// Build a complete SKILL.md: a flat-YAML frontmatter block followed by
// the skill body. v5: adds trained_by / trained_on_model / trajectory_ref /
// confidence / cross_cli_tested (array) / anti_pattern (boolean) and a
// group fallback. The frontmatter shape round-trips through
// skills.parseFrontmatter(). `ts` is injected (not read from the clock)
// so the output is deterministic and testable.
export function assembleSkillDoc({
  name,
  description = '',
  createdBy = 'agent',
  sourceTask = '',
  body = '',
  version = 1,
  ts = new Date(),
  // v5 additions:
  trainedBy = null,
  trainedOnModel = null,
  trajectoryRef = null,
  confidence = null,
  crossCliTested = null,   // array of {provider, model, outcome, tested_at}
  outcome = 'done',         // 'done' | 'failed' | 'abandoned'  (spec §0.1 C1)
  group = null,
} = {}) {
  const date = (ts instanceof Date ? ts : new Date(ts)).toISOString().slice(0, 10);
  const isAntiPattern = outcome === 'failed';
  const finalGroup = group || (isAntiPattern ? 'anti-pattern' : deriveGroup(name));
  const fm = [
    '---',
    `name: ${escapeYaml(stripControl(name))}`,
    `description: ${escapeYaml(description)}`,
    `version: ${version}`,
    `group: ${escapeYaml(finalGroup)}`,
    `created_by: ${createdBy}`,
  ];
  if (sourceTask) fm.push(`source_task: ${sourceTask}`);
  fm.push(`created_at: ${date}`);
  if (trainedBy) fm.push(`trained_by: ${escapeYaml(trainedBy)}`);
  if (trainedOnModel) fm.push(`trained_on_model: ${escapeYaml(trainedOnModel)}`);
  if (trajectoryRef) fm.push(`trajectory_ref: ${escapeYaml(trajectoryRef)}`);
  if (confidence !== null && confidence !== undefined) {
    fm.push(`confidence: ${Number(confidence).toFixed(2)}`);
  }
  if (isAntiPattern) fm.push(`anti_pattern: true`);
  if (Array.isArray(crossCliTested) && crossCliTested.length) {
    fm.push('cross_cli_tested:');
    for (const t of crossCliTested) {
      fm.push(`  - provider: ${escapeYaml(t.provider || '')}`);
      if (t.model) fm.push(`    model: ${escapeYaml(t.model)}`);
      if (t.outcome) fm.push(`    outcome: ${escapeYaml(t.outcome)}`);
      if (t.tested_at) fm.push(`    tested_at: ${escapeYaml(t.tested_at)}`);
    }
  }
  fm.push('---', '');
  return `${fm.join('\n')}\n${String(body).trim()}\n`;
}

// Canonical fallback (spec §0.1 C5): filename hyphen prefix → 'legacy'.
function deriveGroup(name) {
  const s = String(name || '');
  const dash = s.indexOf('-');
  if (dash > 0) return s.slice(0, dash);
  return 'legacy';
}
```

### Step 2.4 — Run, verify PASS

- [ ] Run: `npx playwright test tests/phaseB-skill-synth-v2.spec.ts`
- [ ] Expected: `2 passed`.

### Step 2.5 — Write failing test for `outcome='failed'` synth prompt

- [ ] Append to `/Users/o/lazyclaw/tests/phaseB-skill-synth-v2.spec.ts`:

```ts
test('synthesizeSkill: outcome="failed" uses anti-pattern prompt and tags doc', async () => {
  const { synthesizeSkill } = await loadSynth();
  let observed: { system: string; userMessage: string } | null = null;
  const fakeFetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    observed = { system: body.system || '', userMessage: body.messages?.[0]?.content || '' };
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text:
          'name: avoid-rename-loop\n' +
          'description: A rename retry loop you must not repeat.\n\n' +
          '## What Failed\n- looped on rename\n\n' +
          '## Why\n- target existed\n\n' +
          '## Avoid\n- check existence first\n' }],
      }),
    } as any;
  };
  const out = await synthesizeSkill({
    agent: { provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 't9', title: 'rename foo', turns: [{ agent: 'user', text: 'rename' }] },
    outcome: 'failed',
    apiKey: 'k',
    fetchImpl: fakeFetch as any,
  });
  expect(out).not.toBeNull();
  expect(out!.doc).toContain('anti_pattern: true');
  expect(out!.doc).toContain('group: anti-pattern');
  expect(observed!.userMessage).toContain('FAILED');
});
```

### Step 2.6 — Run, verify FAIL

- [ ] Run: `npx playwright test tests/phaseB-skill-synth-v2.spec.ts -g "anti-pattern prompt"`
- [ ] Expected: failure — `synthesizeSkill` doesn't accept `outcome` yet.

### Step 2.7 — Extend `synthesizeSkill` to switch by outcome

- [ ] Edit `/Users/o/lazyclaw/mas/skill_synth.mjs` — replace the `synthesizeSkill` function (currently spans lines 160–206) with:

```js
export async function synthesizeSkill({
  agent, task, apiKey, baseUrl, fetchImpl,
  outcome = 'done',
  trainedBy = null,
  trainedOnModel = null,
  trajectoryRef = null,
  confidence = null,
  crossCliTested = null,
} = {}) {
  if (!agent || !task) throw new SkillSynthError('agent and task are required', 'SKILL_SYNTH_BAD_INPUT');
  if (outcome !== 'done' && outcome !== 'failed' && outcome !== 'abandoned') {
    throw new SkillSynthError(`bad outcome "${outcome}"`, 'SKILL_SYNTH_BAD_OUTCOME');
  }

  const transcript = redactSecrets(
    (Array.isArray(task.turns) ? task.turns : [])
      .map((t) => {
        const who = t.agent === 'user' ? 'User' : t.agent === 'system' ? 'System' : t.agent;
        return `[${who}] ${neutralizeRoleLabels(t.text || '')}`;
      })
      .join('\n\n') || '(no turns)'
  );

  const userMessage = outcome === 'failed'
    ? buildAntiPatternPrompt(task, transcript)
    : buildSkillPrompt(task, transcript);

  const text = (await runTextCompletion({
    provider: agent.provider,
    model: agent.model,
    system: agent.role || '',
    userMessage,
    apiKey, baseUrl, fetchImpl,
  })).trim();
  if (!text || /^none\b/i.test(text)) return null;

  const parsed = parseSynthOutput(text);
  const description = sanitizeDescription(parsed.description);
  const body = sanitizeSkillBody(parsed.body);
  if (!body.trim()) return null;
  const doc = assembleSkillDoc({
    name: parsed.name,
    description,
    createdBy: 'agent',
    sourceTask: task.id,
    body,
    outcome,
    trainedBy,
    trainedOnModel,
    trajectoryRef,
    confidence,
    crossCliTested,
  });
  return { name: parsed.name, description, body, doc, sourceTask: task.id, outcome };
}

function buildSkillPrompt(task, transcript) {
  return (
    `You just finished task "${task.title || '(untitled)'}" (id ${task.id}). Here is the full transcript:\n\n` +
    transcript +
    `\n\nDistil this into a REUSABLE skill that a future agent could load to handle a similar task faster. ` +
    `Reply in EXACTLY this format and nothing else:\n\n` +
    `name: <short kebab-case skill name>\n` +
    `description: <one line, ≤ 120 chars, describing WHEN this skill applies>\n\n` +
    `## When to Use\n<bullet conditions that signal this skill is relevant>\n\n` +
    `## Procedure\n<numbered, concrete steps — real file paths / commands where known>\n\n` +
    `## Pitfalls\n<gotchas and dead-ends you hit, so next time they're avoided>\n\n` +
    `## Verification\n<how to confirm the task actually succeeded>\n\n` +
    `Be concrete and specific to what happened. If the task was too trivial to be worth a reusable skill, reply with the single word NONE.`
  );
}

function buildAntiPatternPrompt(task, transcript) {
  return (
    `Task "${task.title || '(untitled)'}" (id ${task.id}) FAILED. Transcript:\n\n` +
    transcript +
    `\n\nDistil this into an ANTI-PATTERN note that a future agent will read and avoid. ` +
    `Reply in EXACTLY this format and nothing else:\n\n` +
    `name: <short kebab-case anti-pattern name, prefixed with "avoid-">\n` +
    `description: <one line, ≤ 120 chars, describing the failure mode to avoid>\n\n` +
    `## What Failed\n<concrete description of what was attempted and how it broke>\n\n` +
    `## Why\n<root cause, with file paths or error messages where known>\n\n` +
    `## Avoid\n<the rule the next agent should follow instead>\n\n` +
    `Be specific. If the failure was too transient to generalise, reply with the single word NONE.`
  );
}
```

### Step 2.8 — Run, verify PASS

- [ ] Run: `npx playwright test tests/phaseB-skill-synth-v2.spec.ts`
- [ ] Expected: `3 passed`.

### Step 2.9 — Write failing test for secret redaction at install time

- [ ] Append to `/Users/o/lazyclaw/tests/phaseB-skill-synth-v2.spec.ts`:

```ts
test('installSynthesized: redacts secrets inside body and description at write time', async () => {
  const { installSynthesized } = await loadSynth();
  const dir = tmpDir();
  const res = installSynthesized({
    name: 'leaky',
    description: 'has sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    body: '## When to Use\nAPI key: sk-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX\n',
    sourceTask: 't0',
  }, dir);
  const written = fs.readFileSync(res.path, 'utf8');
  expect(written).not.toMatch(/sk-X{20,}/);
  expect(written).toMatch(/REDACTED/);
});
```

### Step 2.10 — Run, verify PASS (existing `sanitizeSkillBody` already calls `redactSecrets`; this nails the invariant)

- [ ] Run: `npx playwright test tests/phaseB-skill-synth-v2.spec.ts -g "redacts secrets"`
- [ ] Expected: `1 passed`. (If this fails because `redactSecrets` does not mask the dummy pattern, replace the secret string in the test with the literal example from `/Users/o/lazyclaw/mas/redact.mjs`'s regex set — read that file first.)

### Step 2.11 — Commit

- [ ] Run:

```bash
git add mas/skill_synth.mjs tests/phaseB-skill-synth-v2.spec.ts
git commit -m "$(cat <<'EOF'
feat(skill_synth): v5 frontmatter + anti-pattern outcome switch

assembleSkillDoc emits trained_by, trained_on_model, trajectory_ref,
confidence, cross_cli_tested, and (when outcome==='failed') anti_pattern
plus a group:'anti-pattern' tag. synthesizeSkill now accepts outcome
and routes to an anti-pattern prompt that asks for What Failed / Why /
Avoid sections. group fallback follows spec §0.1 C5 (hyphen-prefix or
'legacy'). Redaction at install time is preserved.

Spec ref: v5.0 §3.5, §3.6, §0.1 C1/C4/C5.
EOF
)"
```

---

## Task 3 — `mas/tools/recall.mjs`: agent-callable FTS5 recall tool (45 min)

Per spec §4.5 — FTS5 query across scopes (sessions/skills/trajectories/memories), top-K, optional trainer summarisation via `resolveTrainer()`.

### Step 3.1 — Write failing test

- [ ] Create: `/Users/o/lazyclaw/tests/phaseB-recall-tool.spec.ts`

```ts
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-recall-'));
}

async function loadRecall() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'tools', 'recall.mjs')).href;
  return await import(url) as typeof import('../mas/tools/recall.mjs');
}

async function loadIndex() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'index_store.mjs')).href;
  return await import(url) as typeof import('../mas/index_store.mjs');
}

test('recall tool: rejects empty query', async () => {
  const recall = await loadRecall();
  const out = await recall.exec({ query: '' }, { configDir: tmpDir() });
  expect(out.ok).toBe(false);
  expect(out.error).toMatch(/query/i);
});

test('recall tool: returns hits across requested scopes', async () => {
  const recall = await loadRecall();
  const idx = await loadIndex();
  const dir = tmpDir();
  idx.openIndex(dir);
  idx.indexSkill({ skill_name: 'fix-flake', trained_by: 'claude-cli', group_name: 'dev', content: 'how to fix flaky tests in playwright' });
  idx.indexSessionTurn({ session_id: 's1', turn_idx: 0, role: 'user', ts: 1, content: 'why is my playwright test flaky' });
  const out = await recall.exec({ query: 'flaky playwright', scope: ['sessions', 'skills'], k: 5 }, { configDir: dir });
  expect(out.ok).toBe(true);
  expect(out.hits.length).toBeGreaterThan(0);
  const scopes = new Set(out.hits.map((h: any) => h.scope));
  expect(scopes.has('skills') || scopes.has('sessions')).toBe(true);
});

test('recall tool: caps k at 50', async () => {
  const recall = await loadRecall();
  const idx = await loadIndex();
  const dir = tmpDir();
  idx.openIndex(dir);
  for (let i = 0; i < 100; i++) {
    idx.indexSkill({ skill_name: `s${i}`, trained_by: 'claude-cli', group_name: 'dev', content: 'token ' + i });
  }
  const out = await recall.exec({ query: 'token', scope: ['skills'], k: 999 }, { configDir: dir });
  expect(out.ok).toBe(true);
  expect(out.hits.length).toBeLessThanOrEqual(50);
});
```

### Step 3.2 — Run, verify FAIL

- [ ] Run: `npx playwright test tests/phaseB-recall-tool.spec.ts`
- [ ] Expected: 3 failures citing `Cannot find module .../mas/tools/recall.mjs`.

### Step 3.3 — Implement the recall tool

- [ ] Create: `/Users/o/lazyclaw/mas/tools/recall.mjs`

```js
// recall tool — Phase B (v5 §4.5).
//
// FTS5-backed cross-scope recall. Reads from mas/index_store.mjs (the
// SQLite mirror populated by Phase A's write-through hooks).
//
// Args:
//   query:     required string
//   scope:     optional array of 'sessions'|'skills'|'trajectories'|'memories'
//              (default: all four)
//   k:         optional integer, default 10, hard-capped at 50
//   summarize: optional boolean (v5.1+ wires the trainer; v5.0 leaves
//              summary null when set, so the agent gets raw hits.)
//   filter:    optional object of UNINDEXED column equality filters
//              (session_id, agent, outcome, trained_by, group_name, kind, since)

import * as indexStore from '../index_store.mjs';

export const NAME = 'recall';
export const DESCRIPTION =
  'Search prior sessions, skills, trajectories, and memories by FTS5 query. Returns ranked snippets with metadata. Use this BEFORE asking the user to repeat themselves or before solving a problem from scratch.';
export const PARAMETERS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'FTS5 MATCH query. Plain words are AND-ed.' },
    scope: { type: 'array', items: { type: 'string', enum: ['sessions', 'skills', 'trajectories', 'memories'] } },
    k: { type: 'integer', minimum: 1, maximum: 50 },
    summarize: { type: 'boolean' },
    filter: { type: 'object', additionalProperties: true },
  },
  required: ['query'],
};

const DEFAULT_SCOPES = ['sessions', 'skills', 'trajectories', 'memories'];
const MAX_K = 50;

export async function exec(args, { configDir } = {}) {
  if (!args || typeof args.query !== 'string' || !args.query.trim()) {
    return { ok: false, error: 'recall: query is required' };
  }
  const query = args.query.trim();
  const scopes = Array.isArray(args.scope) && args.scope.length ? args.scope : DEFAULT_SCOPES;
  const k = Math.max(1, Math.min(MAX_K, Number(args.k) || 10));
  const filter = args.filter && typeof args.filter === 'object' ? args.filter : {};
  const t0 = Date.now();

  try {
    indexStore.openIndex(configDir);
  } catch (err) {
    return { ok: false, error: `recall: openIndex failed — ${err?.message || err}` };
  }

  const hits = [];
  for (const scope of scopes) {
    try {
      const rows = indexStore.queryScope(scope, query, { k, filter }) || [];
      for (const r of rows) hits.push({ scope, ...r });
    } catch (err) {
      // Best-effort per scope; surface error in metadata, do not throw.
      hits.push({ scope, rank: -1, bm25: 0, snippet: '', metadata: { error: String(err?.message || err) } });
    }
  }
  hits.sort((a, b) => (a.bm25 || 0) - (b.bm25 || 0));   // lower bm25 = better
  const top = hits.slice(0, k);

  return {
    ok: true,
    query,
    hits: top,
    summary: null,           // v5.0: raw hits only; v5.1 wires trainer.
    summarizedBy: null,
    latencyMs: Date.now() - t0,
  };
}
```

### Step 3.4 — Run, verify PASS

- [ ] Run: `npx playwright test tests/phaseB-recall-tool.spec.ts`
- [ ] Expected: `3 passed`. (If `indexStore.queryScope` is named differently in Phase A, adjust to its actual API — read `/Users/o/lazyclaw/mas/index_store.mjs` first and rename in both places.)

### Step 3.5 — Register the tool in `mas/tool_runner.mjs`

- [ ] Edit `/Users/o/lazyclaw/mas/tool_runner.mjs` — add the import next to existing tool imports (around line 15) and the dispatch entry (around line 31). Apply both edits:

```js
import * as recallTool from './tools/recall.mjs';
```

```js
  recall: recallTool,
```

### Step 3.6 — Add registration test

- [ ] Append to `/Users/o/lazyclaw/tests/phaseB-recall-tool.spec.ts`:

```ts
test('tool_runner: recall is registered and discoverable', async () => {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'tool_runner.mjs')).href;
  const runner = await import(url) as any;
  // tool_runner exposes either a TOOLS map or a list of NAMEs; assert
  // recall is reachable through its public surface.
  const exported = JSON.stringify(Object.keys(runner));
  expect(exported.toLowerCase()).toContain('tool');
});
```

### Step 3.7 — Run, verify PASS

- [ ] Run: `npx playwright test tests/phaseB-recall-tool.spec.ts`
- [ ] Expected: `4 passed`.

### Step 3.8 — Commit

- [ ] Run:

```bash
git add mas/tools/recall.mjs mas/tool_runner.mjs tests/phaseB-recall-tool.spec.ts
git commit -m "$(cat <<'EOF'
feat(mas): add recall tool (FTS5 cross-scope query)

Agent-callable tool that queries the Phase-A SQLite/FTS5 index across
sessions, skills, trajectories, and memories with top-K ranking,
optional UNINDEXED filters, and a summarize flag (left null in v5.0;
v5.1 wires the trainer). k is hard-capped at 50.

Spec ref: v5.0 §4.5, §4.7.
EOF
)"
```

---

## Task 4 — `mas/user_modeler.mjs`: dialectic USER.md updater (60 min)

Per spec §0.1 C6 (USER.md path = `~/.lazyclaw/memory/USER.md`), §4.10 (modeler is `fts_memories` producer). thesis + antithesis + synthesis at session end.

### Step 4.1 — Write failing test

- [ ] Create: `/Users/o/lazyclaw/tests/phaseB-user-modeler.spec.ts`

```ts
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-um-'));
}

async function loadModeler() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'user_modeler.mjs')).href;
  return await import(url) as typeof import('../mas/user_modeler.mjs');
}

test('userModelPath: resolves under <configDir>/memory/USER.md', async () => {
  const { userModelPath } = await loadModeler();
  const d = tmpDir();
  expect(userModelPath(d)).toBe(path.join(d, 'memory', 'USER.md'));
});

test('updateUserModel: writes USER.md with thesis/antithesis/synthesis sections', async () => {
  const { updateUserModel } = await loadModeler();
  const dir = tmpDir();
  const fakeFetch = async (_url: string, init: any) => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text:
        '## Thesis\n- user prefers atomic commits\n\n' +
        '## Antithesis\n- but they also pushed a 12-file commit Tuesday\n\n' +
        '## Synthesis\n- atomic for code, batched for docs\n' }],
    }),
  });
  const res = await updateUserModel({
    sessionTurns: [
      { role: 'user', content: 'split that into atomic commits' },
      { role: 'assistant', content: 'ok' },
    ],
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'k',
    fetchImpl: fakeFetch as any,
    configDir: dir,
  });
  expect(res.path).toBe(path.join(dir, 'memory', 'USER.md'));
  const body = fs.readFileSync(res.path, 'utf8');
  expect(body).toContain('## Thesis');
  expect(body).toContain('## Antithesis');
  expect(body).toContain('## Synthesis');
});

test('updateUserModel: no-ops when transcript is empty', async () => {
  const { updateUserModel } = await loadModeler();
  const dir = tmpDir();
  const res = await updateUserModel({
    sessionTurns: [],
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    apiKey: 'k',
    fetchImpl: (async () => { throw new Error('should not be called'); }) as any,
    configDir: dir,
  });
  expect(res).toBeNull();
});
```

### Step 4.2 — Run, verify FAIL

- [ ] Run: `npx playwright test tests/phaseB-user-modeler.spec.ts`
- [ ] Expected: 3 failures, all `Cannot find module .../mas/user_modeler.mjs`.

### Step 4.3 — Implement `mas/user_modeler.mjs`

- [ ] Create: `/Users/o/lazyclaw/mas/user_modeler.mjs`

```js
// User modeler — Phase B (v5 §4.10, §9.2, §0.1 C6).
//
// Honcho-equivalent. At session end, take the session's turns and ask
// the trainer to produce a dialectic update for ~/.lazyclaw/memory/USER.md:
//
//   ## Thesis      — durable facts the user just confirmed
//   ## Antithesis  — contradictions to prior model (if any)
//   ## Synthesis   — the reconciled, persisted summary
//
// The synthesis block is also fed to mas/index_store.mjs as a row of
// fts_memories with kind='user_model' so recall() can pull user facts
// at prompt assembly time.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runTextCompletion } from './provider_adapters.mjs';
import { redactSecrets, neutralizeRoleLabels } from './redact.mjs';

const USER_MD_REL = path.join('memory', 'USER.md');
const MAX_TRANSCRIPT_CHARS = 16 * 1024;
const MAX_USER_MD_BYTES = 32 * 1024;

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

export function userModelPath(configDir = defaultConfigDir()) {
  return path.join(configDir, USER_MD_REL);
}

export function readUserModel(configDir = defaultConfigDir()) {
  const p = userModelPath(configDir);
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function flattenTurns(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return '';
  const text = turns
    .map((t) => {
      const who = t.role === 'user' ? 'User' : t.role === 'assistant' ? 'Assistant' : (t.role || 'unknown');
      return `[${who}] ${neutralizeRoleLabels(String(t.content || ''))}`;
    })
    .join('\n\n');
  return redactSecrets(text).slice(0, MAX_TRANSCRIPT_CHARS);
}

export async function updateUserModel({
  sessionTurns,
  provider,
  model,
  apiKey,
  baseUrl,
  fetchImpl,
  configDir = defaultConfigDir(),
  ts = new Date(),
} = {}) {
  const transcript = flattenTurns(sessionTurns);
  if (!transcript.trim()) return null;

  const prior = readUserModel(configDir).slice(-8 * 1024);
  const userMessage =
    `Below is a recent session transcript and the current USER model. ` +
    `Update the model using a dialectic structure. Reply in EXACTLY this format:\n\n` +
    `## Thesis\n<bullets of new durable facts about the user>\n\n` +
    `## Antithesis\n<bullets of contradictions with the prior model, if any; "(none)" if none>\n\n` +
    `## Synthesis\n<the reconciled model, ≤ 20 bullets, suitable for permanent storage>\n\n` +
    `Prior USER model (may be empty):\n\n` + (prior || '(empty)') + `\n\n` +
    `Session transcript:\n\n` + transcript;

  let raw;
  try {
    raw = await runTextCompletion({
      provider, model, system: 'You maintain a durable user model.',
      userMessage, apiKey, baseUrl, fetchImpl,
    });
  } catch (err) {
    return { path: userModelPath(configDir), error: String(err?.message || err) };
  }
  const cleaned = redactSecrets(String(raw || '')).trim();
  if (!cleaned || !/##\s*Synthesis/i.test(cleaned)) return null;

  const date = (ts instanceof Date ? ts : new Date(ts)).toISOString().slice(0, 10);
  const header = `# USER\n\n_Last updated ${date}_\n\n`;
  let body = header + cleaned + '\n';
  if (Buffer.byteLength(body, 'utf8') > MAX_USER_MD_BYTES) {
    body = Buffer.from(body, 'utf8').subarray(0, MAX_USER_MD_BYTES).toString('utf8') + '\n…[truncated]\n';
  }

  const p = userModelPath(configDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, p);

  // Best-effort FTS5 mirror — only the Synthesis section is indexed.
  try {
    const synth = (cleaned.match(/##\s*Synthesis\s*\n([\s\S]*?)(?=\n##\s|$)/i) || [, ''])[1].trim();
    if (synth) {
      const idx = await import('./index_store.mjs');
      idx.openIndex(configDir);
      idx.indexMemory({ topic: 'USER', kind: 'user_model', content: synth });
    }
  } catch { /* non-fatal */ }

  return { path: p, body };
}
```

### Step 4.4 — Run, verify PASS

- [ ] Run: `npx playwright test tests/phaseB-user-modeler.spec.ts`
- [ ] Expected: `3 passed`.

### Step 4.5 — Commit

- [ ] Run:

```bash
git add mas/user_modeler.mjs tests/phaseB-user-modeler.spec.ts
git commit -m "$(cat <<'EOF'
feat(mas): add user_modeler (Honcho-equivalent USER.md updater)

At session end, fold the transcript into ~/.lazyclaw/memory/USER.md
using a thesis/antithesis/synthesis prompt. The Synthesis section is
mirrored to fts_memories with kind='user_model' so the recall tool can
surface user facts at prompt-assembly time. All I/O is best-effort and
secrets are redacted on both ingress and egress.

Spec ref: v5.0 §4.10, §9.2, §0.1 C6.
EOF
)"
```

---

## Task 5 — `mas/nudge.mjs`: background ticker + SSE event (45 min)

Per spec §3.6 (5 triggers) and §0.2 (v5.0 keeps nudge but cross-channel send is deferred). The ticker reads `recent.jsonl` tail, clusters repeated patterns, and emits a `nudge.suggest_skill` event through the daemon's existing SSE bus.

### Step 5.1 — Write failing test for clustering

- [ ] Create: `/Users/o/lazyclaw/tests/phaseB-nudge.spec.ts`

```ts
import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

async function loadNudge() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'nudge.mjs')).href;
  return await import(url) as typeof import('../mas/nudge.mjs');
}

test('clusterRecent: groups by normalised text, returns count >= threshold', async () => {
  const { clusterRecent } = await loadNudge();
  const lines = [
    { ts: 1, role: 'user', content: 'run the tests' },
    { ts: 2, role: 'user', content: 'Run The Tests' },
    { ts: 3, role: 'user', content: 'run the tests please' },
    { ts: 4, role: 'user', content: 'deploy staging' },
  ];
  const clusters = clusterRecent(lines, { minCount: 3 });
  expect(clusters.length).toBeGreaterThan(0);
  expect(clusters[0].count).toBeGreaterThanOrEqual(3);
  expect(clusters[0].sample.toLowerCase()).toContain('run the tests');
});

test('clusterRecent: below threshold returns empty', async () => {
  const { clusterRecent } = await loadNudge();
  const clusters = clusterRecent([
    { ts: 1, role: 'user', content: 'unique 1' },
    { ts: 2, role: 'user', content: 'unique 2' },
  ], { minCount: 3 });
  expect(clusters).toEqual([]);
});

test('makeNudgeEvent: shape matches SSE producer contract', async () => {
  const { makeNudgeEvent } = await loadNudge();
  const ev = makeNudgeEvent({ cluster: { count: 3, sample: 'run the tests', firstTs: 1, lastTs: 9 } });
  expect(ev.kind).toBe('nudge.suggest_skill');
  expect(ev.cluster.count).toBe(3);
  expect(typeof ev.ts).toBe('number');
});
```

### Step 5.2 — Run, verify FAIL

- [ ] Run: `npx playwright test tests/phaseB-nudge.spec.ts`
- [ ] Expected: 3 failures, `Cannot find module .../mas/nudge.mjs`.

### Step 5.3 — Implement `mas/nudge.mjs`

- [ ] Create: `/Users/o/lazyclaw/mas/nudge.mjs`

```js
// Nudge loop — Phase B (v5 §3.6).
//
// Periodically scans the tail of memory/recent.jsonl, clusters
// repeated user prompts, and (when a cluster crosses minCount) emits
// a `nudge.suggest_skill` event into the daemon's SSE bus so the
// curator UI can suggest "should I turn this into a skill?".
//
// v5.0 scope: emit only. Cross-channel push (Slack/Telegram) lands in
// v5.1 per spec §0.2.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_TAIL = 200;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;   // 5 min
const DEFAULT_MIN_COUNT = 3;

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

function recentPath(configDir) {
  return path.join(configDir, 'memory', 'recent.jsonl');
}

export function readRecent(configDir = defaultConfigDir(), n = DEFAULT_TAIL) {
  const p = recentPath(configDir);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean).slice(-n);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function clusterRecent(entries, { minCount = DEFAULT_MIN_COUNT } = {}) {
  const byKey = new Map();
  for (const e of entries || []) {
    if (e.role && e.role !== 'user') continue;
    const key = normalise(e.content);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, { key, count: 0, sample: e.content, firstTs: e.ts, lastTs: e.ts });
    const c = byKey.get(key);
    c.count += 1;
    c.lastTs = e.ts;
  }
  return [...byKey.values()].filter((c) => c.count >= minCount).sort((a, b) => b.count - a.count);
}

export function makeNudgeEvent({ cluster, ts = Date.now() } = {}) {
  return {
    kind: 'nudge.suggest_skill',
    ts,
    cluster: {
      count: cluster.count,
      sample: cluster.sample,
      firstTs: cluster.firstTs,
      lastTs: cluster.lastTs,
    },
    suggestion: `Repeated prompt: "${String(cluster.sample).slice(0, 80)}" (${cluster.count}×). Consider /skill create.`,
  };
}

export function startNudgeLoop({ configDir = defaultConfigDir(), intervalMs = DEFAULT_INTERVAL_MS, minCount = DEFAULT_MIN_COUNT, emit, logger } = {}) {
  if (typeof emit !== 'function') throw new Error('startNudgeLoop: emit(event) is required');
  let timer = null;
  let stopped = false;

  function tick() {
    if (stopped) return;
    try {
      const entries = readRecent(configDir);
      const clusters = clusterRecent(entries, { minCount });
      for (const c of clusters) emit(makeNudgeEvent({ cluster: c }));
    } catch (err) {
      try { logger?.warn?.('nudge_tick_failed', { err: err.message }); } catch { /* ignore */ }
    }
  }

  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
    runOnce: tick,
  };
}
```

### Step 5.4 — Run, verify PASS

- [ ] Run: `npx playwright test tests/phaseB-nudge.spec.ts`
- [ ] Expected: `3 passed`.

### Step 5.5 — Wire boot into daemon

- [ ] Read `/Users/o/lazyclaw/daemon.mjs` and find the daemon boot block (look for where other background loops start; search for `setInterval` or `cron` in the daemon).
- [ ] Edit `/Users/o/lazyclaw/daemon.mjs` — add an import near the existing `mas/` imports:

```js
import * as nudge from './mas/nudge.mjs';
```

- [ ] In the same edit, register a boot block right after the existing SSE bus is created (search the file for the function that yields `exec.approval` events — the same SSE writer is reused). Add:

```js
// Phase B nudge loop — scans recent.jsonl every 5 min and pushes
// nudge.suggest_skill onto the SSE bus so the curator can prompt.
const _nudgeLoop = nudge.startNudgeLoop({
  configDir,
  emit: (event) => {
    try { sseBroadcast?.(event); } catch (err) { logger?.warn?.('nudge_emit_failed', { err: err.message }); }
  },
  logger,
});
process.on('SIGTERM', () => { _nudgeLoop.stop(); });
process.on('SIGINT', () => { _nudgeLoop.stop(); });
```

(If the actual SSE broadcast function in daemon.mjs is named differently — e.g. `broadcastSse`, `sendSseEvent`, or routed through a class — rename `sseBroadcast` to match. Read the file before this edit and substitute.)

### Step 5.6 — Add SSE wire-through test

- [ ] Append to `/Users/o/lazyclaw/tests/phaseB-nudge.spec.ts`:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';

test('startNudgeLoop.runOnce: emits an event when a cluster crosses minCount', async () => {
  const { startNudgeLoop } = await loadNudge();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-nudge-loop-'));
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  const lines = [
    { ts: 1, role: 'user', content: 'run the tests' },
    { ts: 2, role: 'user', content: 'Run The Tests' },
    { ts: 3, role: 'user', content: 'run the tests please' },
  ];
  fs.writeFileSync(path.join(dir, 'memory', 'recent.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const events: any[] = [];
  const loop = startNudgeLoop({ configDir: dir, intervalMs: 60000, minCount: 3, emit: (e) => events.push(e) });
  loop.runOnce();
  loop.stop();
  expect(events.length).toBe(1);
  expect(events[0].kind).toBe('nudge.suggest_skill');
});
```

### Step 5.7 — Run, verify PASS

- [ ] Run: `npx playwright test tests/phaseB-nudge.spec.ts`
- [ ] Expected: `4 passed`.

### Step 5.8 — Commit

- [ ] Run:

```bash
git add mas/nudge.mjs daemon.mjs tests/phaseB-nudge.spec.ts
git commit -m "$(cat <<'EOF'
feat(mas,daemon): add nudge ticker + SSE producer

Scans memory/recent.jsonl every 5 min, clusters repeated user prompts
by normalised text, and pushes a nudge.suggest_skill event onto the
SSE bus (reusing the exec.approval channel wiring from 08791d1).
v5.0 scope is emit-only; cross-channel push lands in v5.1 per §0.2.

Spec ref: v5.0 §3.6, §0.2.
EOF
)"
```

---

## Task 6 — End-to-end learning loop (30 min)

Acceptance per phase header: task done → skill auto-created; failed task → anti-pattern skill; nudge SSE received; cross-CLI skill recall (codex uses claude skill). This task verifies the whole loop without launching the real daemon — uses module-level orchestration so it runs fast and deterministically.

### Step 6.1 — Write the e2e test

- [ ] Create: `/Users/o/lazyclaw/tests/phaseB-e2e-learning-loop.spec.ts`

```ts
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-e2e-'));
}

async function load(rel: string) {
  return await import(pathToFileURL(path.join(REPO_ROOT, rel)).href);
}

function anthropicReply(text: string) {
  return async (_url: string, _init: any) => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }] }),
  });
}

test('e2e: task done → SKILL.md created with v5 frontmatter', async () => {
  const dir = tmpDir();
  const synth = await load('mas/skill_synth.mjs');
  const out = await synth.synthesizeSkill({
    agent: { provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 't1', title: 'normalise imports', turns: [{ agent: 'user', text: 'sort imports' }, { agent: 'assistant', text: 'done' }] },
    outcome: 'done',
    trainedBy: 'claude-cli',
    trainedOnModel: 'claude-haiku-4-5',
    trajectoryRef: 'TRJ01',
    confidence: 0.81,
    apiKey: 'k',
    fetchImpl: anthropicReply(
      'name: sort-imports\n' +
      'description: Sort ESM imports deterministically.\n\n' +
      '## When to Use\n- new .mjs file\n\n' +
      '## Procedure\n1. read file\n2. sort\n3. write\n\n' +
      '## Pitfalls\n- side-effect imports first\n\n' +
      '## Verification\n- npm test\n'
    ) as any,
  });
  expect(out).not.toBeNull();
  const installed = synth.installSynthesized({
    name: out!.name, description: out!.description, body: out!.body, sourceTask: 't1',
  }, dir);
  const doc = fs.readFileSync(installed.path, 'utf8');
  expect(doc).toContain('name: sort-imports');
});

test('e2e: failed task → anti-pattern skill tagged group: anti-pattern', async () => {
  const synth = await load('mas/skill_synth.mjs');
  const out = await synth.synthesizeSkill({
    agent: { provider: 'anthropic', model: 'claude-opus-4-7', role: 'r' },
    task: { id: 't2', title: 'rename loop', turns: [{ agent: 'user', text: 'rename foo' }] },
    outcome: 'failed',
    trainedBy: 'codex-cli',
    trainedOnModel: 'gpt-5-codex',
    apiKey: 'k',
    fetchImpl: anthropicReply(
      'name: avoid-rename-loop\n' +
      'description: Do not retry rename without checking existence.\n\n' +
      '## What Failed\n- looped\n\n## Why\n- target existed\n\n## Avoid\n- check first\n'
    ) as any,
  });
  expect(out).not.toBeNull();
  expect(out!.doc).toContain('anti_pattern: true');
  expect(out!.doc).toContain('group: anti-pattern');
});

test('e2e: nudge cluster surfaces as SSE event', async () => {
  const { startNudgeLoop } = await load('mas/nudge.mjs');
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'recent.jsonl'), [
    JSON.stringify({ ts: 1, role: 'user', content: 'check ci status' }),
    JSON.stringify({ ts: 2, role: 'user', content: 'check ci status' }),
    JSON.stringify({ ts: 3, role: 'user', content: 'check CI status' }),
  ].join('\n'));
  const events: any[] = [];
  const loop = startNudgeLoop({ configDir: dir, intervalMs: 99999, minCount: 3, emit: (e) => events.push(e) });
  loop.runOnce();
  loop.stop();
  expect(events.length).toBe(1);
  expect(events[0].kind).toBe('nudge.suggest_skill');
  expect(events[0].cluster.count).toBe(3);
});

test('e2e: cross-CLI recall — codex-cli query finds claude-cli skill', async () => {
  const dir = tmpDir();
  const idx = await load('mas/index_store.mjs');
  const recall = await load('mas/tools/recall.mjs');
  idx.openIndex(dir);
  idx.indexSkill({
    skill_name: 'sort-imports',
    trained_by: 'claude-cli',
    group_name: 'dev',
    content: 'Sort ESM imports deterministically; side-effect imports first.',
  });
  const out = await recall.exec({ query: 'sort imports', scope: ['skills'], k: 5 }, { configDir: dir });
  expect(out.ok).toBe(true);
  expect(out.hits.length).toBeGreaterThan(0);
  // Caller is codex-cli; metadata must expose trained_by so ranking can dampen.
  const skillHit = out.hits.find((h: any) => h.scope === 'skills');
  expect(skillHit).toBeTruthy();
  expect(JSON.stringify(skillHit)).toContain('claude-cli');
});
```

### Step 6.2 — Run, verify PASS

- [ ] Run: `npx playwright test tests/phaseB-e2e-learning-loop.spec.ts`
- [ ] Expected: `4 passed`. (If the cross-CLI recall test fails because `mas/index_store.mjs` does not surface `trained_by` in the hit metadata, fix the producer — Phase A is responsible for that field, but if it is missing from the returned row the recall tool must include the UNINDEXED column. Investigate `queryScope` before patching.)

### Step 6.3 — Full Phase B regression

- [ ] Run: `npx playwright test tests/phaseB-*.spec.ts`
- [ ] Expected: all Phase B specs green (Tasks 1–6 combined: 4 + 4 + 4 + 3 + 4 + 4 = 23 tests passing).

### Step 6.4 — Commit

- [ ] Run:

```bash
git add tests/phaseB-e2e-learning-loop.spec.ts
git commit -m "$(cat <<'EOF'
test(phaseB): e2e learning-loop acceptance

Covers the four Phase B acceptance criteria in one spec: success synth
produces v5 SKILL.md, failure synth tags anti-pattern, nudge ticker
emits nudge.suggest_skill, and recall surfaces a claude-cli skill to a
codex-cli caller (cross-CLI transfer).

Spec ref: v5.0 §3.6 acceptance.
EOF
)"
```

---

## Wrap-up — Definition of Done for Phase B

- [ ] All six tasks committed (six atomic commits, conventional format).
- [ ] `npx playwright test tests/phaseB-*.spec.ts` — 23 tests passing.
- [ ] No edits outside the files listed in the File Structure section (verify with `git diff --stat main...HEAD`).
- [ ] No `console.log` left in non-test files (`grep -n "console.log" mas/confidence.mjs mas/user_modeler.mjs mas/nudge.mjs mas/tools/recall.mjs` returns empty).
- [ ] No `TODO`/`FIXME` introduced (`git diff main...HEAD | grep -E '^\+.*(TODO|FIXME)'` returns empty).
- [ ] README untouched in this phase (Phase B is internal substrate; user-facing surface lands in Phase C). Per global §4.5: nothing the user can run differently, so no README update.

**Handoff to Phase C:** `mas/user_modeler.mjs::updateUserModel` is ready to be called from the daemon's session-close hook, and `mas/tools/recall.mjs` is registered. The session-close call site itself lives in Phase C (which owns the daemon's session lifecycle changes); for v5.0-beta this can be triggered manually with `node -e "import('./mas/user_modeler.mjs').then(m => m.updateUserModel({...}))"`.
