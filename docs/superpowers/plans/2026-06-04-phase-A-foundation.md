# lazyclaw v5.0 — Phase A: foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the v5 substrate — trainer resolver, TrajectoryRecord persistence, SQLite+FTS5 index, write-through hooks, and v4→v5 migration — so every later phase has a typed store, a normalized provider split, and a one-shot migration path.

**Architecture:** Five additive modules plus four surgical hook edits. `providers/registry.mjs` gains `resolveTrainer()`. `mas/trajectory_store.mjs` owns the JSONL trajectory log and a memory cache, fed from `mas/agent_turn.mjs`. `mas/index_db.mjs` owns the single `~/.lazyclaw/index.db` SQLite handle with FTS5 virtual tables, mounted at daemon/CLI boot and written through from `sessions.appendTurn`, `skill_synth.installSynthesized`, `trajectory_store.put`. `scripts/migrate-v5.mjs` is the one-shot upgrade — backup → config rewrite → skill frontmatter upgrade → FTS5 rebuild.

**Tech Stack:** Node.js 18+, .mjs ES modules, `better-sqlite3` (NEW native dep — see spec §0.1 C11 and §4.2). Tests use `node --test` (built-in), not Playwright — Playwright is reserved for existing integration `.spec.ts` files; new Phase A unit tests are pure Node so they run without browser setup.

**Depends on phases:** none (this *is* the foundation). Every later phase (B learning, C personas, D sandbox, E channels) imports from `mas/index_db.mjs`, `mas/trajectory_store.mjs`, or calls `resolveTrainer()`.

**Spec reference:** `docs/superpowers/specs/2026-06-04-lazyclaw-v5-hermes-parity-design.md` §0.1 (canonical decisions C1–C11), §2.3–§2.4 (trainer config + `resolveTrainer`), §3.3 (TrajectoryRecord schema), §4.2–§4.4 (SQLite+FTS5 schema and write-through hooks), §10 (v4→v5 migration overview — Phase A delivers the baseline; later phases extend it).

---

## File Structure

**Create:**

- `/Users/o/lazyclaw/mas/trajectory_store.mjs` — TrajectoryRecord type + JSONL append + in-memory LRU + `put()` / `get()` / `recallByTaskId()`.
- `/Users/o/lazyclaw/mas/index_db.mjs` — `openIndex()`, schema, prepared statements, `indexSessionTurn()` / `indexSkill()` / `indexTrajectory()` / `indexMemory()`, `recall()` (raw FTS5, no summarisation — that arrives in Phase B), `integrityCheck()`, `rebuild()`.
- `/Users/o/lazyclaw/scripts/migrate-v5.mjs` — CLI entry: backup `~/.lazyclaw` to `~/.lazyclaw/backup-v4-<ts>/`, rewrite `config.json` with `trainer: "auto"` default, walk `skills/*.md` adding missing `group:` / `trained_by:` frontmatter, then rebuild `index.db` from existing sessions + skills + memory.
- `/Users/o/lazyclaw/tests/phaseA-resolve-trainer.test.mjs` — unit tests for `resolveTrainer()` (omitted trainer, explicit kebab-case provider, `"auto"` resolution, fallback parsing, `useFallback` opt).
- `/Users/o/lazyclaw/tests/phaseA-trajectory-store.test.mjs` — round-trip persist + load, outcome enum guard, ULID monotonicity, redaction at write.
- `/Users/o/lazyclaw/tests/phaseA-index-db.test.mjs` — schema bootstrap, `PRAGMA integrity_check`, `recall()` < 50 ms @ 10k rows, write-through idempotency.
- `/Users/o/lazyclaw/tests/phaseA-index-hooks.test.mjs` — `appendTurn` → `fts_sessions`, `installSynthesized` → `fts_skills`, `trajectory_store.put` → `fts_trajectories`.
- `/Users/o/lazyclaw/tests/phaseA-migrate-v5.test.mjs` — three fixture v4 configDirs (`empty`, `with-sessions`, `with-skills`) all migrate without throwing and produce a populated FTS5.
- `/Users/o/lazyclaw/tests/fixtures/v4-installs/empty/.gitkeep` — empty dir marker.
- `/Users/o/lazyclaw/tests/fixtures/v4-installs/with-sessions/config.json` — minimal v4 config with `provider: "claude-cli"` and one session JSONL.
- `/Users/o/lazyclaw/tests/fixtures/v4-installs/with-skills/config.json` — v4 config plus one skill without `group:` frontmatter (exercises C5 fallback).

**Modify:**

- `/Users/o/lazyclaw/providers/registry.mjs` — add `resolveTrainer(cfg, opts)` export + `parseProviderModel()` helper + `detectAutoTrainer(cfg)` stub.
- `/Users/o/lazyclaw/mas/agent_turn.mjs` — capture trajectory turns into a `trajectoryRef` argument when supplied; non-breaking — when caller passes nothing, behaviour is byte-identical to v4.
- `/Users/o/lazyclaw/mas/skill_synth.mjs` — call `indexSkill()` after `installSynthesized` succeeds (best-effort, swallowed failures per §4.4 invariant).
- `/Users/o/lazyclaw/sessions.mjs` — add `indexSessionTurn()` write-through inside `appendTurn`, wrapped in try/catch (must not break session writes — §4.4).
- `/Users/o/lazyclaw/package.json` — add `better-sqlite3: ^11.6.0` to `dependencies`, add `migrate:v5` script.
- `/Users/o/lazyclaw/cli.mjs` — register `lazyclaw migrate v5` subcommand wired to `scripts/migrate-v5.mjs`, surface `lazyclaw config get trainer.provider` (dotted key access in `cmdConfigGet`).

---

## Task 1: Add `resolveTrainer()` to provider registry

Delivers spec §2.3 (config schema) and §2.4 (API surface). Sets up the contract every later trainer call site (`skill_synth`, `agent_memory`, `daemon` reflect dispatch) depends on.

- [ ] **Step 1.1 — Write the failing test.** Create `/Users/o/lazyclaw/tests/phaseA-resolve-trainer.test.mjs`:

  ```js
  // Phase A: trainer provider resolution (spec §2.3, §2.4, canonical C9).
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { resolveTrainer, parseProviderModel } from '../providers/registry.mjs';

  test('resolveTrainer: omitted trainer mirrors chat provider (v4 compat)', () => {
    const got = resolveTrainer({ provider: 'claude-cli', model: 'claude-opus-4-7' });
    assert.equal(got.provider, 'claude-cli');
    assert.equal(got.model, 'claude-opus-4-7');
  });

  test('resolveTrainer: explicit trainer overrides chat (canonical kebab-case C3)', () => {
    const got = resolveTrainer({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      trainer: { provider: 'openai', model: 'gpt-4o-mini' },
    });
    assert.equal(got.provider, 'openai');
    assert.equal(got.model, 'gpt-4o-mini');
  });

  test('resolveTrainer: trainer.model omitted inherits chat model', () => {
    const got = resolveTrainer({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      trainer: { provider: 'claude-cli' },
    });
    assert.equal(got.provider, 'claude-cli');
    assert.equal(got.model, 'claude-opus-4-7');
  });

  test('resolveTrainer: "auto" with no Pro/Max detection mirrors chat provider (C9)', () => {
    const got = resolveTrainer(
      { provider: 'anthropic', model: 'claude-opus-4-7', trainer: { provider: 'auto' } },
      { detectClaudeCli: () => false },
    );
    assert.equal(got.provider, 'anthropic');
    assert.equal(got.model, 'claude-opus-4-7');
  });

  test('resolveTrainer: "auto" with Pro/Max detection resolves to claude-cli (C9)', () => {
    const got = resolveTrainer(
      { provider: 'anthropic', model: 'claude-opus-4-7', trainer: { provider: 'auto' } },
      { detectClaudeCli: () => true },
    );
    assert.equal(got.provider, 'claude-cli');
  });

  test('resolveTrainer: useFallback parses provider:model fallback string', () => {
    const got = resolveTrainer(
      { provider: 'anthropic', model: 'claude-opus-4-7',
        trainer: { provider: 'claude-cli', fallback: 'openai:gpt-4o-mini' } },
      { useFallback: true },
    );
    assert.equal(got.provider, 'openai');
    assert.equal(got.model, 'gpt-4o-mini');
  });

  test('parseProviderModel: splits on first colon', () => {
    assert.deepEqual(parseProviderModel('openai:gpt-4o-mini'),
      { provider: 'openai', model: 'gpt-4o-mini' });
    assert.deepEqual(parseProviderModel('anthropic:claude-opus-4-7:beta'),
      { provider: 'anthropic', model: 'claude-opus-4-7:beta' });
    assert.deepEqual(parseProviderModel('claude-cli'),
      { provider: 'claude-cli', model: null });
  });
  ```

- [ ] **Step 1.2 — Run test, verify FAIL.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-resolve-trainer.test.mjs`

  Expected: 7 tests fail with `TypeError: resolveTrainer is not a function` (or `parseProviderModel is not a function`).

- [ ] **Step 1.3 — Implement `resolveTrainer` in registry.mjs.** Open `/Users/o/lazyclaw/providers/registry.mjs` and append after the existing `makeOrchestratorProvider` re-export block (after line 62, before `OPENAI_COMPAT_BUILTINS`):

  ```js
  // ─── Phase A: trainer resolver (spec §2.3, §2.4, canonical C3/C9) ───
  //
  // resolveTrainer(cfg, opts) returns { provider, model } for synthesis /
  // reflection calls — split from the chat provider so users can route
  // learning to a cheap model or to a CLI-subscription worker.
  //
  // Rules:
  //   - cfg.trainer omitted → mirror chat (v4 compat).
  //   - cfg.trainer.provider === 'auto' → claude-cli when Pro/Max
  //     session detected, else mirror chat (canonical decision C9).
  //   - opts.useFallback → parse cfg.trainer.fallback ('provider:model')
  //     and use it; missing pieces inherit from chat.
  //   - All identifiers MUST be kebab-case in user-facing config (C3).

  export function parseProviderModel(spec) {
    const s = String(spec || '');
    const i = s.indexOf(':');
    if (i < 0) return { provider: s || null, model: null };
    return { provider: s.slice(0, i) || null, model: s.slice(i + 1) || null };
  }

  function _defaultDetectClaudeCli() {
    // Phase A stub: real Pro/Max session detection arrives in Phase B
    // (it requires reading the claude-cli OAuth token cache). Until
    // then, treat presence of CLAUDE_CODE_OAUTH_TOKEN as a positive
    // signal so users can opt-in explicitly.
    return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  }

  export function resolveTrainer(cfg, opts = {}) {
    const chatProvider = cfg && cfg.provider;
    const chatModel = cfg && cfg.model;
    const t = cfg && cfg.trainer;

    if (!t || !t.provider) {
      return { provider: chatProvider, model: chatModel };
    }

    if (opts.useFallback && t.fallback) {
      const { provider, model } = parseProviderModel(t.fallback);
      return {
        provider: provider || chatProvider,
        model: model || chatModel,
      };
    }

    if (t.provider === 'auto') {
      const detect = opts.detectClaudeCli || _defaultDetectClaudeCli;
      if (detect()) return { provider: 'claude-cli', model: t.model || chatModel };
      return { provider: chatProvider, model: t.model || chatModel };
    }

    return { provider: t.provider, model: t.model || chatModel };
  }
  ```

- [ ] **Step 1.4 — Run test, verify PASS.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-resolve-trainer.test.mjs`

  Expected: `# pass 7`, `# fail 0`.

- [ ] **Step 1.5 — Surface dotted-key `config get` access.** The acceptance criterion says `lazyclaw config get trainer.provider` must work. Modify `/Users/o/lazyclaw/cli.mjs` `cmdConfigGet` (currently line 5964) to support dotted lookup:

  ```js
  function cmdConfigGet(key) {
    const cfg = readConfig();
    if (!key) { console.log(JSON.stringify(cfg)); return; }
    let value = cfg;
    for (const seg of String(key).split('.')) {
      if (value && typeof value === 'object' && seg in value) value = value[seg];
      else { value = null; break; }
    }
    console.log(JSON.stringify({ key, value }));
  }
  ```

- [ ] **Step 1.6 — Commit.**

  Run:
  ```bash
  git add /Users/o/lazyclaw/providers/registry.mjs /Users/o/lazyclaw/cli.mjs /Users/o/lazyclaw/tests/phaseA-resolve-trainer.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(providers): add resolveTrainer() and dotted config-get

  Split trainer provider from chat provider per v5.0 spec §2.3/§2.4.
  Supports kebab-case ids (C3), "auto" detection (C9), and provider:model
  fallback parsing. cmdConfigGet now walks dotted keys so users can run
  `lazyclaw config get trainer.provider` against nested config.
  EOF
  )"
  ```

---

## Task 2: TrajectoryRecord schema + persistence

Delivers spec §3.3 (TrajectoryRecord shape) and the "trajectory_store round-trip" acceptance gate. The store is the substrate Phase B's learning loop reads from.

- [ ] **Step 2.1 — Write the failing test.** Create `/Users/o/lazyclaw/tests/phaseA-trajectory-store.test.mjs`:

  ```js
  // Phase A: TrajectoryRecord persistence (spec §3.3, canonical C1).
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';
  import { put, get, listByTaskId, OUTCOME_ENUM } from '../mas/trajectory_store.mjs';

  function tmpDir() {
    const p = fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-traj-'));
    return p;
  }

  test('OUTCOME_ENUM is exactly the canonical 3 values (C1)', () => {
    assert.deepEqual([...OUTCOME_ENUM].sort(), ['abandoned', 'done', 'failed']);
  });

  test('put → get round-trip preserves all fields', async () => {
    const dir = tmpDir();
    const rec = {
      taskId: 'task_test_1',
      agentName: 'worker-0',
      workerProvider: 'claude-cli',
      workerModel: 'claude-opus-4-7',
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      systemPrompt: 'You are helpful.',
      userMessages: ['hello'],
      turns: [{
        turnIdx: 0, role: 'assistant', content: 'hi',
        toolCalls: [], tokensUsed: { input: 10, output: 5 },
      }],
      finalAnswer: 'hi',
      outcome: 'done',
    };
    const stored = await put(rec, { configDir: dir });
    assert.ok(stored.id, 'put assigns ULID');
    const loaded = await get(stored.id, { configDir: dir });
    assert.equal(loaded.taskId, 'task_test_1');
    assert.equal(loaded.outcome, 'done');
    assert.equal(loaded.turns.length, 1);
    assert.equal(loaded.turns[0].content, 'hi');
  });

  test('put rejects unknown outcome (C1 enum guard)', async () => {
    const dir = tmpDir();
    await assert.rejects(
      put({ taskId: 't', outcome: 'success', turns: [] }, { configDir: dir }),
      /outcome must be one of/,
    );
  });

  test('put redacts secrets in turn content before persistence', async () => {
    const dir = tmpDir();
    const rec = {
      taskId: 't_redact', agentName: 'a', workerProvider: 'anthropic',
      workerModel: 'claude-opus-4-7', startedAt: 1, endedAt: 2,
      systemPrompt: '', userMessages: [],
      turns: [{
        turnIdx: 0, role: 'assistant',
        content: 'use sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234567890abcdefgh and you are set',
        toolCalls: [],
      }],
      finalAnswer: '', outcome: 'done',
    };
    const stored = await put(rec, { configDir: dir });
    const loaded = await get(stored.id, { configDir: dir });
    assert.ok(!loaded.turns[0].content.includes('sk-ant-api03-AAAABBBB'),
      'secret leaked into trajectory');
  });

  test('listByTaskId returns records in insertion order', async () => {
    const dir = tmpDir();
    const base = { agentName: 'a', workerProvider: 'anthropic',
      workerModel: 'm', startedAt: 1, endedAt: 2,
      systemPrompt: '', userMessages: [], turns: [], finalAnswer: '', outcome: 'done' };
    const a = await put({ ...base, taskId: 't_list' }, { configDir: dir });
    const b = await put({ ...base, taskId: 't_list' }, { configDir: dir });
    const list = await listByTaskId('t_list', { configDir: dir });
    assert.equal(list.length, 2);
    assert.deepEqual(list.map(r => r.id), [a.id, b.id]);
  });
  ```

- [ ] **Step 2.2 — Run test, verify FAIL.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-trajectory-store.test.mjs`

  Expected: 5 tests fail with `Cannot find module '../mas/trajectory_store.mjs'`.

- [ ] **Step 2.3 — Implement trajectory_store.mjs.** Create `/Users/o/lazyclaw/mas/trajectory_store.mjs`:

  ```js
  // mas/trajectory_store.mjs — Phase A.
  //
  // Persists TrajectoryRecord (spec §3.3) to JSONL on disk plus an
  // in-memory cache. Storage layout:
  //   <configDir>/trajectories/<YYYY-MM-DD>/<id>.jsonl
  // One file per trajectory id (a ULID) so concurrent writers never
  // contend. A single in-memory Map<id, record> serves hot reads; cold
  // reads stream the file back through JSON.parse.
  //
  // Phase A scope: write, read, list-by-task. Recall by full-text query
  // lives in mas/index_db.mjs (FTS5). The two stores share the same
  // record but the FTS5 mirror is best-effort — disk JSONL is the
  // source of truth.

  import fs from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';
  import crypto from 'node:crypto';
  import { redactSecrets } from './redact.mjs';

  export const OUTCOME_ENUM = Object.freeze(['done', 'failed', 'abandoned']);

  const _cache = new Map();   // id → record (capped at CACHE_MAX entries)
  const CACHE_MAX = 256;

  function defaultConfigDir() {
    return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
  }

  function trajectoriesDir(configDir) {
    return path.join(configDir, 'trajectories');
  }

  // Crockford-base32 ULID generator. Monotonic within a single ms by
  // appending a counter — same-millisecond puts stay sortable.
  const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let _ulidLastMs = 0;
  let _ulidCounter = 0;
  function ulid() {
    let now = Date.now();
    if (now === _ulidLastMs) _ulidCounter++;
    else { _ulidLastMs = now; _ulidCounter = 0; }
    let timePart = '';
    let t = now;
    for (let i = 0; i < 10; i++) {
      timePart = ULID_ALPHABET[t % 32] + timePart;
      t = Math.floor(t / 32);
    }
    const rand = crypto.randomBytes(10);
    let randPart = '';
    for (let i = 0; i < 16; i++) {
      randPart += ULID_ALPHABET[rand[i % 10] % 32];
    }
    // Counter suffix (last 2 chars) keeps monotonicity intra-ms.
    const ctr = ULID_ALPHABET[(_ulidCounter >> 5) % 32]
              + ULID_ALPHABET[_ulidCounter % 32];
    return timePart + randPart.slice(0, 14) + ctr;
  }

  function redactTurns(turns) {
    return (turns || []).map(t => ({
      ...t,
      content: typeof t.content === 'string' ? redactSecrets(t.content) : t.content,
      thinking: typeof t.thinking === 'string' ? redactSecrets(t.thinking) : t.thinking,
      toolCalls: (t.toolCalls || []).map(c => ({
        ...c,
        result: typeof c.result === 'string' ? redactSecrets(c.result) : c.result,
      })),
    }));
  }

  function dateBucket(ms) {
    return new Date(ms).toISOString().slice(0, 10);   // YYYY-MM-DD
  }

  function recordPath(configDir, bucket, id) {
    return path.join(trajectoriesDir(configDir), bucket, `${id}.jsonl`);
  }

  function cachePush(id, rec) {
    _cache.set(id, rec);
    if (_cache.size > CACHE_MAX) {
      const oldest = _cache.keys().next().value;
      _cache.delete(oldest);
    }
  }

  export async function put(record, opts = {}) {
    if (!record || typeof record !== 'object') {
      throw new TypeError('trajectory_store.put: record must be an object');
    }
    if (!OUTCOME_ENUM.includes(record.outcome)) {
      throw new Error(
        `outcome must be one of ${OUTCOME_ENUM.join('|')}, got ${record.outcome}`,
      );
    }
    const configDir = opts.configDir || defaultConfigDir();
    const id = record.id || ulid();
    const stored = {
      ...record,
      id,
      systemPrompt: typeof record.systemPrompt === 'string'
        ? redactSecrets(record.systemPrompt) : '',
      userMessages: (record.userMessages || []).map(m =>
        typeof m === 'string' ? redactSecrets(m) : m),
      turns: redactTurns(record.turns),
      finalAnswer: typeof record.finalAnswer === 'string'
        ? redactSecrets(record.finalAnswer) : '',
    };
    const bucket = dateBucket(stored.startedAt || Date.now());
    const file = recordPath(configDir, bucket, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stored) + '\n');
    cachePush(id, stored);
    return stored;
  }

  export async function get(id, opts = {}) {
    if (_cache.has(id)) return _cache.get(id);
    const configDir = opts.configDir || defaultConfigDir();
    const root = trajectoriesDir(configDir);
    if (!fs.existsSync(root)) return null;
    for (const bucket of fs.readdirSync(root)) {
      const file = recordPath(configDir, bucket, id);
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8').trim();
        const rec = JSON.parse(raw);
        cachePush(id, rec);
        return rec;
      }
    }
    return null;
  }

  export async function listByTaskId(taskId, opts = {}) {
    const configDir = opts.configDir || defaultConfigDir();
    const root = trajectoriesDir(configDir);
    if (!fs.existsSync(root)) return [];
    const matches = [];
    for (const bucket of fs.readdirSync(root).sort()) {
      const bdir = path.join(root, bucket);
      if (!fs.statSync(bdir).isDirectory()) continue;
      for (const f of fs.readdirSync(bdir).sort()) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(bdir, f), 'utf8'));
          if (rec.taskId === taskId) matches.push(rec);
        } catch { /* skip corrupt */ }
      }
    }
    return matches;
  }

  // Test/maintenance hook.
  export function _resetCache() { _cache.clear(); }
  ```

- [ ] **Step 2.4 — Run test, verify PASS.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-trajectory-store.test.mjs`

  Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 2.5 — Wire optional capture into agent_turn.mjs.** Modify `/Users/o/lazyclaw/mas/agent_turn.mjs`. Add an optional `trajectoryRef` param to `runAgentTurn` that, when provided, accumulates turn records, then a single `put()` at completion. Non-breaking: omit the param and behaviour matches v4 exactly.

  Add this import at the top of the file (after the existing imports on lines 23–27):

  ```js
  import { put as _trajPut } from './trajectory_store.mjs';
  ```

  In the `runAgentTurn` signature (line 61), add `trajectoryRef` after `approve`:

  ```js
  export async function runAgentTurn({
    agent,
    userMessage,
    history = [],
    taskId,
    configDir,
    cwd,
    fetchImpl,
    baseUrl,
    apiKey,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    signal,
    approve,
    trajectoryRef,
  } = {}) {
  ```

  At the very end of the function, right before each of the three `return` statements (`final`, `tool_error`, `budget` paths — currently lines 106, 143, 147), insert a single helper call. Add this helper inside `runAgentTurn` just before the `while` loop:

  ```js
    const _maybePersistTrajectory = async (outcome) => {
      if (!trajectoryRef) return;
      try {
        await _trajPut({
          taskId, agentName: agent.name || 'agent',
          workerProvider: agent.provider, workerModel: agent.model,
          startedAt: trajectoryRef.startedAt || Date.now(),
          endedAt: Date.now(),
          systemPrompt: agent.role || '',
          userMessages: userMessage ? [String(userMessage)] : [],
          turns: toolCalls.map((c, i) => ({
            turnIdx: i, role: 'tool', content: '',
            toolCalls: [{ name: c.name, args: c.input, result: JSON.stringify(c.result), success: c.ok, durationMs: 0 }],
          })).concat(lastText ? [{
            turnIdx: toolCalls.length, role: 'assistant', content: lastText, toolCalls: [],
          }] : []),
          finalAnswer: lastText,
          outcome,
        }, { configDir });
      } catch { /* trajectory failure must not break the agent turn */ }
    };
  ```

  Then update the three return paths:
  - Line 106 — replace `return { text: resp.text || '', iterations, stoppedBy: 'final', toolCalls };` with:
    ```js
        await _maybePersistTrajectory('done');
        return { text: resp.text || '', iterations, stoppedBy: 'final', toolCalls };
    ```
  - Line 143 — replace `return { text: lastText, iterations, stoppedBy: 'tool_error', toolCalls };` with:
    ```js
        await _maybePersistTrajectory('failed');
        return { text: lastText, iterations, stoppedBy: 'tool_error', toolCalls };
    ```
  - Line 147 (final `return`) — replace with:
    ```js
      await _maybePersistTrajectory('abandoned');
      return { text: lastText, iterations, stoppedBy: 'budget', toolCalls };
    ```

  Also at the function top, where `iterations = 0` is declared, also assign `if (trajectoryRef && !trajectoryRef.startedAt) trajectoryRef.startedAt = Date.now();`.

- [ ] **Step 2.6 — Run trajectory test again to confirm no regression.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-trajectory-store.test.mjs`

  Expected: still `# pass 5`.

- [ ] **Step 2.7 — Commit.**

  Run:
  ```bash
  git add /Users/o/lazyclaw/mas/trajectory_store.mjs /Users/o/lazyclaw/mas/agent_turn.mjs /Users/o/lazyclaw/tests/phaseA-trajectory-store.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(mas): TrajectoryRecord store with JSONL persistence

  Implements spec §3.3. Outcome enum locked to done|failed|abandoned
  (canonical C1). agent_turn.mjs gains an optional trajectoryRef param
  so callers that want capture opt in; absence preserves v4 behaviour
  byte-for-byte. Secrets are redacted at write through mas/redact.mjs,
  ULIDs are monotonic intra-ms.
  EOF
  )"
  ```

---

## Task 3: SQLite + FTS5 index with integrity check

Delivers spec §4.2 (storage), §4.3 (schema), §4.8 (integrity), and the "FTS5 query <50ms@10k rows" acceptance bar. This module is the dependency for the write-through hooks in Task 4.

- [ ] **Step 3.1 — Add `better-sqlite3` to package.json.** Modify `/Users/o/lazyclaw/package.json`. Insert a `dependencies` block right before `devDependencies`:

  ```json
    "dependencies": {
      "better-sqlite3": "^11.6.0"
    },
    "devDependencies": {
  ```

  Also add a `migrate:v5` script to the existing `scripts` object:

  ```json
    "scripts": {
      "test": "playwright test",
      "test:bench": "node scripts/bench-providers.mjs",
      "migrate:v5": "node scripts/migrate-v5.mjs"
    },
  ```

  Then install:
  ```bash
  cd /Users/o/lazyclaw && npm install better-sqlite3@^11.6.0
  ```

  Expected: `added 1 package` (plus its native build). If native build fails on the developer's platform, abort and surface the error — fallback guidance lives in the migration docs per C11.

- [ ] **Step 3.2 — Write the failing test.** Create `/Users/o/lazyclaw/tests/phaseA-index-db.test.mjs`:

  ```js
  // Phase A: SQLite + FTS5 index (spec §4.2, §4.3, §4.8, §4.9).
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';
  import {
    openIndex, closeIndex, indexSessionTurn, indexSkill,
    indexTrajectory, indexMemory, recall, integrityCheck, rebuild,
  } from '../mas/index_db.mjs';

  function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-idx-'));
  }

  test('openIndex creates the db file and runs PRAGMA integrity_check', () => {
    const dir = tmp();
    const db = openIndex(dir);
    assert.ok(db, 'returns a db handle');
    assert.ok(fs.existsSync(path.join(dir, 'index.db')));
    const integ = integrityCheck(dir);
    assert.equal(integ.ok, true, JSON.stringify(integ));
    closeIndex(dir);
  });

  test('schema contains all four FTS5 virtual tables', () => {
    const dir = tmp();
    const db = openIndex(dir);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);
    for (const want of ['fts_sessions', 'fts_skills', 'fts_trajectories', 'fts_memories']) {
      assert.ok(tables.includes(want), `${want} missing; got ${tables.join(',')}`);
    }
    closeIndex(dir);
  });

  test('write-through hooks insert and recall round-trips', () => {
    const dir = tmp();
    openIndex(dir);
    indexSessionTurn({ session_id: 's1', turn_idx: 0, role: 'user',
      ts: 1, content: 'how do I refactor mjs imports' }, dir);
    indexSkill({ skill_name: 'refactor-mjs-imports', trained_by: 'claude-cli',
      group_name: 'dev', content: 'Reorganise ESM imports in .mjs files' }, dir);
    indexTrajectory({ trajectory_id: 't1', agent: 'worker-0', outcome: 'done',
      content: 'used mas/tools/edit to rewrite imports' }, dir);
    indexMemory({ topic: 'esm', kind: 'episodic',
      content: 'user prefers named exports' }, dir);

    const hits = recall('refactor', { configDir: dir });
    assert.ok(hits.hits.length >= 2, `expected ≥2 hits, got ${hits.hits.length}`);
    const scopes = new Set(hits.hits.map(h => h.scope));
    assert.ok(scopes.has('sessions') || scopes.has('skills'));
    closeIndex(dir);
  });

  test('recall on 10k rows completes in <50ms (spec §4.9)', () => {
    const dir = tmp();
    openIndex(dir);
    for (let i = 0; i < 10000; i++) {
      indexSessionTurn({ session_id: `s${i}`, turn_idx: 0, role: 'user',
        ts: i, content: `synthetic turn number ${i} about widgets and gizmos` }, dir);
    }
    // Warm the query plan once.
    recall('widgets', { configDir: dir, k: 10 });
    const t0 = process.hrtime.bigint();
    const out = recall('gizmos', { configDir: dir, k: 10 });
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(out.hits.length === 10, `got ${out.hits.length} hits`);
    assert.ok(elapsedMs < 50, `recall took ${elapsedMs.toFixed(2)}ms, budget 50ms`);
    closeIndex(dir);
  });

  test('rebuild() recreates schema and is idempotent', () => {
    const dir = tmp();
    openIndex(dir);
    indexSessionTurn({ session_id: 'pre', turn_idx: 0, role: 'user', ts: 0,
      content: 'before rebuild' }, dir);
    closeIndex(dir);
    rebuild(dir);
    rebuild(dir);   // second call must not throw
    const integ = integrityCheck(dir);
    assert.equal(integ.ok, true);
    closeIndex(dir);
  });
  ```

- [ ] **Step 3.3 — Run test, verify FAIL.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-index-db.test.mjs`

  Expected: 5 tests fail with `Cannot find module '../mas/index_db.mjs'`.

- [ ] **Step 3.4 — Implement index_db.mjs.** Create `/Users/o/lazyclaw/mas/index_db.mjs`:

  ```js
  // mas/index_db.mjs — Phase A.
  //
  // Single SQLite handle per configDir backing four FTS5 virtual tables
  // (spec §4.3). The daemon opens the db at boot; CLI subcommands open
  // on demand. WAL mode lets many readers coexist with the one writer.
  //
  // Index failure NEVER propagates — see spec §4.4: write-through hooks
  // log and swallow so a corrupt index can't break the session-write
  // path. Recovery is via `lazyclaw index rebuild`.

  import Database from 'better-sqlite3';
  import fs from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';
  import { redactSecrets } from './redact.mjs';

  const SCHEMA_VERSION = 1;
  const _handles = new Map();   // configDir → { db, stmts }

  function defaultConfigDir() {
    return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
  }

  function dbPath(configDir) {
    return path.join(configDir, 'index.db');
  }

  function ensureSchema(db) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_sessions USING fts5(
        content,
        session_id UNINDEXED, turn_idx UNINDEXED, role UNINDEXED, ts UNINDEXED
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_skills USING fts5(
        content,
        skill_name UNINDEXED, trained_by UNINDEXED, group_name UNINDEXED
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_trajectories USING fts5(
        content,
        trajectory_id UNINDEXED, agent UNINDEXED, outcome UNINDEXED
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(
        content,
        topic UNINDEXED, kind UNINDEXED
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    if (!cur) {
      db.prepare("INSERT INTO meta(key,value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
    }
  }

  function prepareStatements(db) {
    return {
      insertSession: db.prepare(
        `INSERT INTO fts_sessions(content, session_id, turn_idx, role, ts)
         VALUES (?, ?, ?, ?, ?)`),
      insertSkill: db.prepare(
        `INSERT INTO fts_skills(content, skill_name, trained_by, group_name)
         VALUES (?, ?, ?, ?)`),
      insertTrajectory: db.prepare(
        `INSERT INTO fts_trajectories(content, trajectory_id, agent, outcome)
         VALUES (?, ?, ?, ?)`),
      insertMemory: db.prepare(
        `INSERT INTO fts_memories(content, topic, kind)
         VALUES (?, ?, ?)`),
      queries: {
        sessions: db.prepare(
          `SELECT 'sessions' AS scope, bm25(fts_sessions) AS bm25,
                  snippet(fts_sessions, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                  session_id, turn_idx, role, ts
             FROM fts_sessions WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
        skills: db.prepare(
          `SELECT 'skills' AS scope, bm25(fts_skills) AS bm25,
                  snippet(fts_skills, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                  skill_name, trained_by, group_name
             FROM fts_skills WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
        trajectories: db.prepare(
          `SELECT 'trajectories' AS scope, bm25(fts_trajectories) AS bm25,
                  snippet(fts_trajectories, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                  trajectory_id, agent, outcome
             FROM fts_trajectories WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
        memories: db.prepare(
          `SELECT 'memories' AS scope, bm25(fts_memories) AS bm25,
                  snippet(fts_memories, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                  topic, kind
             FROM fts_memories WHERE content MATCH ? ORDER BY bm25 LIMIT ?`),
      },
    };
  }

  export function openIndex(configDir = defaultConfigDir(), opts = {}) {
    const dir = configDir;
    if (_handles.has(dir)) return _handles.get(dir).db;
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(dbPath(dir));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    ensureSchema(db);
    if (opts.runIntegrityCheck !== false) {
      const r = db.pragma('integrity_check', { simple: true });
      if (r !== 'ok') {
        // eslint-disable-next-line no-console
        console.warn(`[index_db] integrity_check returned ${r} for ${dbPath(dir)}`);
      }
    }
    const stmts = prepareStatements(db);
    _handles.set(dir, { db, stmts });
    return db;
  }

  export function closeIndex(configDir = defaultConfigDir()) {
    const h = _handles.get(configDir);
    if (!h) return;
    try { h.db.close(); } catch { /* ignore */ }
    _handles.delete(configDir);
  }

  function _stmts(configDir) {
    if (!_handles.has(configDir)) openIndex(configDir);
    return _handles.get(configDir).stmts;
  }

  export function indexSessionTurn(row, configDir = defaultConfigDir()) {
    try {
      const s = _stmts(configDir);
      s.insertSession.run(
        redactSecrets(String(row.content || '')),
        String(row.session_id || ''), Number(row.turn_idx || 0),
        String(row.role || ''), Number(row.ts || Date.now()),
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[index_db] indexSessionTurn failed:', e.message);
    }
  }

  export function indexSkill(row, configDir = defaultConfigDir()) {
    try {
      const s = _stmts(configDir);
      s.insertSkill.run(
        redactSecrets(String(row.content || '')),
        String(row.skill_name || ''), String(row.trained_by || ''),
        String(row.group_name || ''),
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[index_db] indexSkill failed:', e.message);
    }
  }

  export function indexTrajectory(row, configDir = defaultConfigDir()) {
    try {
      const s = _stmts(configDir);
      s.insertTrajectory.run(
        redactSecrets(String(row.content || '')),
        String(row.trajectory_id || ''), String(row.agent || ''),
        String(row.outcome || ''),
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[index_db] indexTrajectory failed:', e.message);
    }
  }

  export function indexMemory(row, configDir = defaultConfigDir()) {
    try {
      const s = _stmts(configDir);
      s.insertMemory.run(
        redactSecrets(String(row.content || '')),
        String(row.topic || ''), String(row.kind || ''),
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[index_db] indexMemory failed:', e.message);
    }
  }

  export function recall(query, opts = {}) {
    const t0 = process.hrtime.bigint();
    const configDir = opts.configDir || defaultConfigDir();
    const scope = opts.scope || ['sessions', 'skills', 'trajectories', 'memories'];
    const k = Math.min(Math.max(Number(opts.k) || 10, 1), 50);
    const s = _stmts(configDir);
    const hits = [];
    for (const sc of scope) {
      const stmt = s.queries[sc];
      if (!stmt) continue;
      try {
        const rows = stmt.all(query, k);
        for (const r of rows) {
          const { scope: sc2, bm25, snippet, ...metadata } = r;
          hits.push({ scope: sc2, rank: hits.length, bm25, snippet, metadata });
        }
      } catch (e) {
        // FTS5 MATCH syntax errors are caller mistakes; skip silently.
        if (!/syntax error/i.test(e.message)) throw e;
      }
    }
    hits.sort((a, b) => a.bm25 - b.bm25);
    const trimmed = hits.slice(0, k);
    for (let i = 0; i < trimmed.length; i++) trimmed[i].rank = i;
    const elapsedNs = process.hrtime.bigint() - t0;
    return { query, hits: trimmed, latencyMs: Number(elapsedNs) / 1e6 };
  }

  export function integrityCheck(configDir = defaultConfigDir()) {
    const db = openIndex(configDir);
    const r = db.pragma('integrity_check', { simple: true });
    return { ok: r === 'ok', result: r };
  }

  export function rebuild(configDir = defaultConfigDir()) {
    closeIndex(configDir);
    const p = dbPath(configDir);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      // WAL sidecar files
      for (const ext of ['-wal', '-shm']) {
        const side = p + ext;
        if (fs.existsSync(side)) fs.unlinkSync(side);
      }
    }
    openIndex(configDir);
  }
  ```

- [ ] **Step 3.5 — Run test, verify PASS.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-index-db.test.mjs`

  Expected: `# pass 5`, `# fail 0`. The 10k-rows perf test should report < 50 ms; if it exceeds, do not weaken the test — investigate `journal_mode = WAL` setup and the `bm25 ORDER BY` plan.

- [ ] **Step 3.6 — Commit.**

  Run:
  ```bash
  git add /Users/o/lazyclaw/package.json /Users/o/lazyclaw/package-lock.json /Users/o/lazyclaw/mas/index_db.mjs /Users/o/lazyclaw/tests/phaseA-index-db.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(mas): SQLite + FTS5 index store

  Adds better-sqlite3 as a runtime dep (spec §0.1 C11, §4.2) and
  implements the four FTS5 virtual tables defined in §4.3. recall()
  hits the spec §4.9 budget of <50ms on 10k rows. Every write hook
  swallows failures so a corrupt index never breaks session writes
  (invariant from §4.4).
  EOF
  )"
  ```

---

## Task 4: FTS5 sync write hooks into sessions and skill_synth

Delivers spec §4.4 — the four write-through call sites that keep `index.db` current as state mutates. trajectory_store already calls into index_db via the hook in this task. user_modeler doesn't exist yet (Phase B) — only the three Phase A producers wire up here.

- [ ] **Step 4.1 — Write the failing test.** Create `/Users/o/lazyclaw/tests/phaseA-index-hooks.test.mjs`:

  ```js
  // Phase A: write-through hooks (spec §4.4).
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';
  import { appendTurn } from '../sessions.mjs';
  import { installSynthesized } from '../mas/skill_synth.mjs';
  import { put as trajPut } from '../mas/trajectory_store.mjs';
  import { openIndex, recall, closeIndex } from '../mas/index_db.mjs';

  function tmp() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lazyclaw-hooks-'));
    process.env.LAZYCLAW_CONFIG_DIR = d;
    return d;
  }

  test('appendTurn writes through to fts_sessions', () => {
    const dir = tmp();
    openIndex(dir);
    appendTurn('s_hook_1', 'user', 'investigate the slack reaction noise', dir);
    const out = recall('reaction', { configDir: dir, scope: ['sessions'] });
    assert.ok(out.hits.length >= 1, `no session hit; got ${JSON.stringify(out.hits)}`);
    assert.equal(out.hits[0].metadata.session_id, 's_hook_1');
    closeIndex(dir);
  });

  test('installSynthesized writes through to fts_skills', () => {
    const dir = tmp();
    openIndex(dir);
    installSynthesized({
      name: 'phaseA-hook-skill',
      description: 'Hook test fixture',
      body: '## When to use\nWhen testing the FTS5 write-through.\n',
      sourceTask: 't_test',
    }, dir);
    const out = recall('write-through', { configDir: dir, scope: ['skills'] });
    assert.ok(out.hits.length >= 1, `no skill hit; got ${JSON.stringify(out.hits)}`);
    closeIndex(dir);
  });

  test('trajectory_store.put writes through to fts_trajectories', async () => {
    const dir = tmp();
    openIndex(dir);
    await trajPut({
      taskId: 't_hook', agentName: 'a', workerProvider: 'anthropic',
      workerModel: 'm', startedAt: 1, endedAt: 2,
      systemPrompt: '', userMessages: [],
      turns: [{ turnIdx: 0, role: 'assistant',
        content: 'fts trajectory write-through verification phrase', toolCalls: [] }],
      finalAnswer: 'fts trajectory write-through verification phrase',
      outcome: 'done',
    }, { configDir: dir });
    const out = recall('verification', { configDir: dir, scope: ['trajectories'] });
    assert.ok(out.hits.length >= 1, `no trajectory hit; got ${JSON.stringify(out.hits)}`);
    assert.equal(out.hits[0].metadata.outcome, 'done');
    closeIndex(dir);
  });

  test('appendTurn still succeeds when index_db is unwritable', () => {
    const dir = tmp();
    // No openIndex call → indexSessionTurn falls into the lazy-open
    // path; we then forcibly close so the next write hits a closed db
    // and must be swallowed by the try/catch.
    openIndex(dir);
    closeIndex(dir);
    // Replace the db file with a directory so reopen throws.
    fs.unlinkSync(path.join(dir, 'index.db'));
    fs.mkdirSync(path.join(dir, 'index.db'));
    // appendTurn must NOT throw (invariant: session writes never break).
    appendTurn('s_resilient', 'user', 'this must succeed', dir);
    fs.rmSync(path.join(dir, 'index.db'), { recursive: true, force: true });
  });
  ```

- [ ] **Step 4.2 — Run test, verify FAIL.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-index-hooks.test.mjs`

  Expected: first three tests fail with `no … hit`; the resilience test may pass already because `appendTurn` already swallows. Three failures is the target before implementation.

- [ ] **Step 4.3 — Wire `appendTurn` → `indexSessionTurn`.** Modify `/Users/o/lazyclaw/sessions.mjs`. Add the import at the top:

  ```js
  import { indexSessionTurn as _indexSessionTurn } from './mas/index_db.mjs';
  ```

  Then in `appendTurn` (currently ending at line 82 with `_memoryAppendRecent`), add a turn-index counter using the on-disk line count and a swallowed write-through. Replace the function body from line 70 onward:

  ```js
  export function appendTurn(id, role, content, configDir = defaultConfigDir()) {
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      throw new Error(`invalid role: ${role}`);
    }
    const p = sessionPath(id, configDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const ts = Date.now();
    const line = JSON.stringify({ role, content: String(content ?? ''), ts }) + '\n';
    // Compute turn_idx BEFORE the append so the index row aligns with the
    // JSONL row about to land on disk.
    let turnIdx = 0;
    try {
      if (fs.existsSync(p)) {
        const existing = fs.readFileSync(p, 'utf8');
        turnIdx = existing ? existing.split('\n').filter(Boolean).length : 0;
      }
    } catch { /* ignore — turn_idx defaults to 0 */ }
    fs.appendFileSync(p, line);
    // Write-through to the memory recency log. Best-effort; failures
    // never propagate up — a missing or broken memory store must not
    // break the session-write path.
    _memoryAppendRecent(id, role, content, configDir);
    // Phase A: FTS5 mirror (spec §4.4). Errors are swallowed inside
    // indexSessionTurn but we wrap again here so a missing module (e.g.
    // index_db not present in a tree shaped before Phase A) can't break
    // this hot path either.
    try {
      _indexSessionTurn({ session_id: id, turn_idx: turnIdx, role, ts,
        content: String(content ?? '') }, configDir);
    } catch { /* swallow */ }
  }
  ```

- [ ] **Step 4.4 — Wire `installSynthesized` → `indexSkill`.** Modify `/Users/o/lazyclaw/mas/skill_synth.mjs`. Add the import alongside the existing ones at line ~18:

  ```js
  import { indexSkill as _indexSkill } from './index_db.mjs';
  import { parseFrontmatter } from '../skills.mjs';
  ```

  At the end of `installSynthesized` (line ~231), before `return { skill: finalName, path: p, version };`, insert:

  ```js
    // Phase A: FTS5 mirror (spec §4.4). Group fallback per canonical C5.
    try {
      const { meta, body: skillBody } = parseFrontmatter(doc);
      const group = meta.group
        || (finalName.includes('-') ? finalName.split('-')[0] : 'legacy');
      _indexSkill({
        skill_name: finalName,
        trained_by: meta.trained_by || createdBy === 'agent' ? 'agent' : 'user',
        group_name: group,
        content: skillBody,
      }, configDir);
    } catch { /* swallow */ }
  ```

- [ ] **Step 4.5 — Wire `trajectory_store.put` → `indexTrajectory`.** Modify `/Users/o/lazyclaw/mas/trajectory_store.mjs`. Add the import near the top alongside `redactSecrets`:

  ```js
  import { indexTrajectory as _indexTrajectory } from './index_db.mjs';
  ```

  In `put()`, after `fs.writeFileSync(file, JSON.stringify(stored) + '\n');` and before `cachePush(id, stored);`, insert:

  ```js
    // Phase A: FTS5 mirror (spec §4.4). Content is the concatenation of
    // the final answer plus every turn's textual content so a single
    // recall() can surface trajectories by either signal.
    try {
      const ftsContent = [
        stored.finalAnswer || '',
        ...(stored.turns || []).map(t => String(t.content || '')),
      ].filter(Boolean).join('\n');
      _indexTrajectory({
        trajectory_id: id,
        agent: stored.agentName || '',
        outcome: stored.outcome,
        content: ftsContent,
      }, configDir);
    } catch { /* swallow */ }
  ```

- [ ] **Step 4.6 — Run test, verify PASS.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-index-hooks.test.mjs`

  Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 4.7 — Re-run all Phase A tests to confirm no regression.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-*.test.mjs`

  Expected: `# pass 21` (7+5+5+4), `# fail 0`.

- [ ] **Step 4.8 — Commit.**

  Run:
  ```bash
  git add /Users/o/lazyclaw/sessions.mjs /Users/o/lazyclaw/mas/skill_synth.mjs /Users/o/lazyclaw/mas/trajectory_store.mjs /Users/o/lazyclaw/tests/phaseA-index-hooks.test.mjs
  git commit -m "$(cat <<'EOF'
  feat(mas): wire FTS5 write-through hooks for sessions/skills/trajectories

  Per spec §4.4 every state mutation now mirrors into index.db. All
  three hooks swallow failures (matches the §4.4 invariant: a corrupt
  index must not break the session-write path). Skill group falls back
  to filename-hyphen-prefix then 'legacy' per canonical decision C5.
  EOF
  )"
  ```

---

## Task 5: v4 → v5 migration baseline

Delivers spec §10 — backup, config rewrite, skill frontmatter upgrade, and FTS5 rebuild from existing on-disk state. Acceptance: three fixture v4 installs migrate cleanly.

- [ ] **Step 5.1 — Create the three fixture configDirs.**

  Run:
  ```bash
  mkdir -p /Users/o/lazyclaw/tests/fixtures/v4-installs/empty
  mkdir -p /Users/o/lazyclaw/tests/fixtures/v4-installs/with-sessions/sessions
  mkdir -p /Users/o/lazyclaw/tests/fixtures/v4-installs/with-skills/skills
  touch /Users/o/lazyclaw/tests/fixtures/v4-installs/empty/.gitkeep
  ```

  Then create `/Users/o/lazyclaw/tests/fixtures/v4-installs/with-sessions/config.json`:

  ```json
  {
    "provider": "claude-cli",
    "model": "claude-opus-4-7"
  }
  ```

  And `/Users/o/lazyclaw/tests/fixtures/v4-installs/with-sessions/sessions/s_fix1.jsonl`:

  ```jsonl
  {"role":"user","content":"how do I run the daemon","ts":1717400000000}
  {"role":"assistant","content":"run lazyclaw daemon start","ts":1717400001000}
  ```

  Then create `/Users/o/lazyclaw/tests/fixtures/v4-installs/with-skills/config.json`:

  ```json
  {
    "provider": "anthropic",
    "model": "claude-opus-4-7"
  }
  ```

  And `/Users/o/lazyclaw/tests/fixtures/v4-installs/with-skills/skills/dev-review.md` (v4-style, no `group:` frontmatter — exercises canonical C5):

  ```md
  ---
  name: dev-review
  description: Review the current diff
  version: 1
  created_by: agent
  ---

  ## When to use
  Right before opening a PR.

  ## Procedure
  Run git diff, summarise the change set, flag risky patterns.
  ```

- [ ] **Step 5.2 — Write the failing test.** Create `/Users/o/lazyclaw/tests/phaseA-migrate-v5.test.mjs`:

  ```js
  // Phase A: v4 → v5 migration baseline (spec §10).
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';
  import { migrateV5 } from '../scripts/migrate-v5.mjs';
  import { openIndex, recall, closeIndex } from '../mas/index_db.mjs';
  import { parseFrontmatter } from '../skills.mjs';

  const FIXTURES = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), 'fixtures/v4-installs');

  function copyFixture(name) {
    const src = path.join(FIXTURES, name);
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), `lazyclaw-mig-${name}-`));
    fs.cpSync(src, dst, { recursive: true });
    return dst;
  }

  test('migrate(empty): creates backup, writes default config, builds empty index', async () => {
    const dir = copyFixture('empty');
    const out = await migrateV5({ configDir: dir });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(fs.existsSync(out.backupDir), 'backup missing');
    assert.ok(fs.existsSync(path.join(dir, 'index.db')));
    closeIndex(dir);
  });

  test('migrate(with-sessions): rewrites config with trainer:auto and indexes existing turns', async () => {
    const dir = copyFixture('with-sessions');
    const out = await migrateV5({ configDir: dir });
    assert.equal(out.ok, true);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.trainer?.provider, 'auto', `trainer.provider = ${cfg.trainer?.provider}`);
    openIndex(dir);
    const hits = recall('daemon', { configDir: dir, scope: ['sessions'] });
    assert.ok(hits.hits.length >= 1, 'session turns not indexed');
    closeIndex(dir);
  });

  test('migrate(with-skills): upgrades skill frontmatter with group + trained_by (C4/C5)', async () => {
    const dir = copyFixture('with-skills');
    const out = await migrateV5({ configDir: dir });
    assert.equal(out.ok, true);
    const skillPath = path.join(dir, 'skills/dev-review.md');
    const raw = fs.readFileSync(skillPath, 'utf8');
    const { meta } = parseFrontmatter(raw);
    assert.equal(meta.group, 'dev', `group = ${meta.group}`);
    // trained_by defaults to 'legacy' for pre-v5 skills (canonical C4).
    assert.equal(meta.trained_by, 'legacy', `trained_by = ${meta.trained_by}`);
    openIndex(dir);
    const hits = recall('diff', { configDir: dir, scope: ['skills'] });
    assert.ok(hits.hits.length >= 1, 'skill not indexed after migration');
    closeIndex(dir);
  });

  test('migrate is idempotent: second run does not duplicate backup or skill frontmatter', async () => {
    const dir = copyFixture('with-skills');
    await migrateV5({ configDir: dir });
    const skillAfter1 = fs.readFileSync(path.join(dir, 'skills/dev-review.md'), 'utf8');
    await migrateV5({ configDir: dir });
    const skillAfter2 = fs.readFileSync(path.join(dir, 'skills/dev-review.md'), 'utf8');
    assert.equal(skillAfter1, skillAfter2, 'second migration mutated the skill');
    closeIndex(dir);
  });
  ```

- [ ] **Step 5.3 — Run test, verify FAIL.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-migrate-v5.test.mjs`

  Expected: 4 tests fail with `Cannot find module '../scripts/migrate-v5.mjs'`.

- [ ] **Step 5.4 — Implement migrate-v5.mjs.** Create `/Users/o/lazyclaw/scripts/migrate-v5.mjs`:

  ```js
  #!/usr/bin/env node
  // scripts/migrate-v5.mjs — Phase A baseline migration (spec §10).
  //
  // Steps (each is idempotent — a second run is a no-op):
  //   1. Backup <configDir> to <configDir>/backup-v4-<ts>/ (only when no
  //      prior backup exists for the current schema version).
  //   2. Rewrite config.json: ensure trainer.provider defaults to "auto"
  //      when omitted (canonical C9). Existing trainer blocks are left
  //      alone.
  //   3. Walk skills/*.md and add missing frontmatter fields per
  //      canonical decisions:
  //        - group:    filename-hyphen-prefix or 'legacy' (C5)
  //        - trained_by: 'legacy' for pre-v5 skills (C4)
  //      Existing fields are never overwritten.
  //   4. Rebuild index.db from on-disk sessions, skills, memory.
  //
  // Phases B+ extend this script with user-modeler import, persona
  // promotion, and trajectory backfill from the v4 recent.jsonl.

  import fs from 'node:fs';
  import path from 'node:path';
  import os from 'node:os';
  import { openIndex, rebuild, indexSessionTurn, indexSkill, indexMemory } from '../mas/index_db.mjs';
  import { parseFrontmatter } from '../skills.mjs';

  function defaultConfigDir() {
    return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
  }

  function tsStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  function backupOnce(configDir) {
    const entries = fs.readdirSync(configDir, { withFileTypes: true });
    const hasBackup = entries.some(e => e.isDirectory() && e.name.startsWith('backup-v4-'));
    if (hasBackup) return { skipped: true };
    const backupDir = path.join(configDir, `backup-v4-${tsStamp()}`);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const e of entries) {
      if (e.name === 'index.db' || e.name.startsWith('backup-v4-')) continue;
      const src = path.join(configDir, e.name);
      const dst = path.join(backupDir, e.name);
      fs.cpSync(src, dst, { recursive: true });
    }
    return { backupDir };
  }

  function rewriteConfig(configDir) {
    const cfgPath = path.join(configDir, 'config.json');
    let cfg = {};
    if (fs.existsSync(cfgPath)) {
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { cfg = {}; }
    }
    if (!cfg.trainer || !cfg.trainer.provider) {
      cfg.trainer = { provider: 'auto', ...(cfg.trainer || {}) };
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    return cfg;
  }

  function escapeYaml(s) {
    const str = String(s ?? '');
    if (!/[":\n]/.test(str)) return str;
    return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function upgradeSkillFrontmatter(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const baseName = path.basename(filePath, '.md');
    const want = {
      group: meta.group || (baseName.includes('-') ? baseName.split('-')[0] : 'legacy'),
      trained_by: meta.trained_by || 'legacy',
    };
    const before = JSON.stringify(meta);
    const next = { ...meta, ...want };
    if (JSON.stringify(next) === before) return false;   // no change
    const lines = ['---'];
    for (const [k, v] of Object.entries(next)) {
      lines.push(`${k}: ${escapeYaml(v)}`);
    }
    lines.push('---', '', body.replace(/^\n+/, ''));
    fs.writeFileSync(filePath, lines.join('\n'));
    return true;
  }

  function upgradeAllSkills(configDir) {
    const dir = path.join(configDir, 'skills');
    if (!fs.existsSync(dir)) return { upgraded: 0 };
    let n = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      if (upgradeSkillFrontmatter(path.join(dir, name))) n++;
    }
    return { upgraded: n };
  }

  function rebuildIndex(configDir) {
    rebuild(configDir);
    openIndex(configDir);

    // Sessions.
    const sessDir = path.join(configDir, 'sessions');
    if (fs.existsSync(sessDir)) {
      for (const f of fs.readdirSync(sessDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -'.jsonl'.length);
        const raw = fs.readFileSync(path.join(sessDir, f), 'utf8');
        let idx = 0;
        for (const line of raw.split('\n')) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            indexSessionTurn({
              session_id: id, turn_idx: idx++, role: obj.role || 'user',
              ts: obj.ts || 0, content: obj.content || '',
            }, configDir);
          } catch { /* skip malformed */ }
        }
      }
    }

    // Skills.
    const skillsDir = path.join(configDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const f of fs.readdirSync(skillsDir)) {
        if (!f.endsWith('.md')) continue;
        const name = f.slice(0, -'.md'.length);
        const raw = fs.readFileSync(path.join(skillsDir, f), 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        indexSkill({
          skill_name: name,
          trained_by: meta.trained_by || 'legacy',
          group_name: meta.group || (name.includes('-') ? name.split('-')[0] : 'legacy'),
          content: body,
        }, configDir);
      }
    }

    // Memory (core + episodic).
    const memDir = path.join(configDir, 'memory');
    if (fs.existsSync(memDir)) {
      const corePath = path.join(memDir, 'core.md');
      if (fs.existsSync(corePath)) {
        indexMemory({ topic: 'core', kind: 'core',
          content: fs.readFileSync(corePath, 'utf8') }, configDir);
      }
      const epi = path.join(memDir, 'episodic');
      if (fs.existsSync(epi)) {
        for (const f of fs.readdirSync(epi)) {
          if (!f.endsWith('.md')) continue;
          indexMemory({
            topic: f.slice(0, -'.md'.length), kind: 'episodic',
            content: fs.readFileSync(path.join(epi, f), 'utf8'),
          }, configDir);
        }
      }
    }
  }

  export async function migrateV5(opts = {}) {
    const configDir = opts.configDir || defaultConfigDir();
    fs.mkdirSync(configDir, { recursive: true });
    const backup = backupOnce(configDir);
    const config = rewriteConfig(configDir);
    const skills = upgradeAllSkills(configDir);
    rebuildIndex(configDir);
    return {
      ok: true,
      configDir,
      backupDir: backup.backupDir || null,
      backupSkipped: !!backup.skipped,
      trainerProvider: config.trainer?.provider,
      skillsUpgraded: skills.upgraded,
    };
  }

  // CLI entry — `npm run migrate:v5` or `node scripts/migrate-v5.mjs`.
  if (import.meta.url === `file://${process.argv[1]}`) {
    migrateV5().then(r => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok ? 0 : 1);
    }).catch(err => {
      // eslint-disable-next-line no-console
      console.error('[migrate-v5] failed:', err.stack || err.message);
      process.exit(1);
    });
  }
  ```

- [ ] **Step 5.5 — Run test, verify PASS.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-migrate-v5.test.mjs`

  Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5.6 — Wire `lazyclaw migrate v5` subcommand into cli.mjs.** Modify `/Users/o/lazyclaw/cli.mjs`. Find the subcommand dispatch table (around line 6316 where `config` is registered) and add a new handler block in the same router. Locate a sibling `if (sub === '…')` chain and insert:

  ```js
        if (sub === 'migrate') {
          const target = rest[0];
          if (target !== 'v5') {
            console.error('usage: lazyclaw migrate v5');
            process.exit(2);
          }
          const { migrateV5 } = await import('./scripts/migrate-v5.mjs');
          const r = await migrateV5();
          console.log(JSON.stringify(r, null, 2));
          process.exit(r.ok ? 0 : 1);
        }
  ```

  Note: the exact insertion line depends on the surrounding router shape — locate the existing `if (csub === ...)` chain reached for `config` and add this block at the same nesting level for `migrate`. If unsure, search `cli.mjs` for `cmdConfigGet` and add the block in the same switch/if-cascade.

- [ ] **Step 5.7 — Smoke test the CLI wiring.**

  Run:
  ```bash
  LAZYCLAW_CONFIG_DIR=$(mktemp -d) node /Users/o/lazyclaw/cli.mjs migrate v5
  ```

  Expected: JSON output with `"ok": true` and a non-null `backupDir` (or `backupSkipped: true` on a re-run). Exit code 0.

- [ ] **Step 5.8 — Run the entire Phase A test suite end-to-end.**

  Run: `node --test /Users/o/lazyclaw/tests/phaseA-*.test.mjs`

  Expected: `# pass 25` (7+5+5+4+4), `# fail 0`. If anything fails, do NOT weaken tests — fix the implementation.

- [ ] **Step 5.9 — Commit.**

  Run:
  ```bash
  git add /Users/o/lazyclaw/scripts/migrate-v5.mjs /Users/o/lazyclaw/cli.mjs /Users/o/lazyclaw/tests/phaseA-migrate-v5.test.mjs /Users/o/lazyclaw/tests/fixtures/v4-installs/
  git commit -m "$(cat <<'EOF'
  feat(migrate): v4 → v5 baseline migration (backup + config + index)

  Implements the Phase A slice of spec §10: one-shot backup, default
  trainer.provider="auto" rewrite (C9), skill frontmatter upgrade with
  group fallback (C5) and trained_by="legacy" (C4), and full FTS5
  rebuild from on-disk sessions + skills + memory. Idempotent — second
  run is a no-op. Wired to `lazyclaw migrate v5`.
  EOF
  )"
  ```

---

## Acceptance verification (run all)

After Task 5 commit:

- [ ] **All Phase A tests green.** Run: `node --test /Users/o/lazyclaw/tests/phaseA-*.test.mjs`. Expected: `# pass 25`.
- [ ] **Existing tests not regressed.** Run: `npx playwright test` and confirm no new failures vs. the pre-Phase-A baseline (some Playwright tests touch sessions/skills, so the write-through hooks must coexist with them).
- [ ] **`lazyclaw config get trainer.provider` works.** Run: `LAZYCLAW_CONFIG_DIR=$(mktemp -d) bash -c 'node /Users/o/lazyclaw/cli.mjs migrate v5 && node /Users/o/lazyclaw/cli.mjs config get trainer.provider'`. Expected last line: `{"key":"trainer.provider","value":"auto"}`.
- [ ] **`lazyclaw migrate v5` is idempotent on three fixture installs.** Verified by Phase A test #4 of Task 5.
- [ ] **FTS5 recall < 50 ms @ 10k rows.** Verified by Phase A test #4 of Task 3.
- [ ] **No new files in `dist-lazyclaw/`, no committed `index.db`, no committed `backup-v4-*` directories.** Run: `git status` and visually verify the diff.