# lazyclaw v5.0 — Phase G: persona-migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the v5.0 persona compose stack, personality CLI, and the three migration entry points (`lazyclaw migrate`, `lazyclaw hermes import`, `lazyclaw openclaw import`) so existing v4 / Hermes / OpenClaw installs upgrade cleanly with USER.md, SOUL.md and `personalities/<name>.md` correctly populated.

**Architecture:** A new `mas/prompt_stack.mjs` composes the 8-layer system prompt (canonical §9.3, decision C10) — global SOUL → workspace SOUL → personality → agent.role → USER.md → skill index → memory → trajectory — and is wired into `daemon.mjs`'s prompt builder via a single `composePromptStack({cfgDir, agent, workspace, sessionId})` call. `cli.mjs` gains a `personality` subcommand and a `/personality` REPL slash command persisting selections in `cfg.persona.personality` and `agent.personality`. Migration tooling lives under `scripts/`: `migrate-v5.mjs` (extended from Phase A) gains a rollback path that snapshots `~/.lazyclaw` to `~/.lazyclaw.v4.backup/<ts>/`, rewrites config keys (`orchestrator`→`orchestra`, `trainer` injection, sandbox string→object), and upgrades every `skills/*.md` frontmatter to include `group`, `confidence: 0.5`, `trained_by: legacy` (canonical fallback C5). `scripts/hermes-import.mjs` and `scripts/openclaw-import.mjs` are read-only on the source tree and write into the lazyclaw config dir with `trained_by: hermes-import` / `openclaw-import` tagging (canonical enum C4).

**Tech Stack:** Node.js 18+, `.mjs` ES modules, no new runtime deps in this phase (re-uses `skills.mjs::parseFrontmatter`, `memory.mjs`, existing `mas/audit.mjs`). Tests use `@playwright/test` runner with `spawnSync(process.execPath, [CLI, ...])` per established pattern in `tests/phase*.spec.ts`.

**Depends on phases:** A (config schema + initial `scripts/migrate-v5.mjs` skeleton + `~/.lazyclaw/memory/USER.md` path constant), B (skill frontmatter `confidence` / `trained_by` writer in `mas/skill_synth.mjs`).

**Spec reference:** `docs/superpowers/specs/2026-06-04-lazyclaw-v5-hermes-parity-design.md` §0.1 (C4–C10), §1.6 (Hermes parity), §1.7 (v4→v5 impact), §5.5 (SKILL frontmatter group fallback), §9 (Persona system), §10 (Migration: v4→v5, Hermes import, OpenClaw import).

---

## File Structure

**Create:**

- `/Users/o/lazyclaw/mas/prompt_stack.mjs` — 8-layer compose function `composePromptStack({cfgDir, agent, workspace, sessionId})`.
- `/Users/o/lazyclaw/scripts/hermes-import.mjs` — read `~/.hermes`, write into lazyclaw config dir.
- `/Users/o/lazyclaw/scripts/openclaw-import.mjs` — read `~/.openclaw`, write into lazyclaw config dir.
- `/Users/o/lazyclaw/tests/phaseG-prompt-stack.spec.ts` — compose-stack ordering + missing-layer fallback.
- `/Users/o/lazyclaw/tests/phaseG-personality.spec.ts` — `lazyclaw personality list/show/install/remove/use`.
- `/Users/o/lazyclaw/tests/phaseG-migrate.spec.ts` — 3 fixture v4 installs round-trip, rollback.
- `/Users/o/lazyclaw/tests/phaseG-hermes-import.spec.ts` — Hermes smoke (fake `~/.hermes`).
- `/Users/o/lazyclaw/tests/phaseG-openclaw-import.spec.ts` — OpenClaw smoke (fake `~/.openclaw`).
- `/Users/o/lazyclaw/tests/fixtures/v4-minimal/config.json` — minimal v4 cfg (provider only).
- `/Users/o/lazyclaw/tests/fixtures/v4-slack-heavy/config.json` — slack channel tokens + sandbox string.
- `/Users/o/lazyclaw/tests/fixtures/v4-skill-heavy/config.json` — references skills (sibling `skills/*.md` files emitted by the test).

**Modify:**

- `/Users/o/lazyclaw/cli.mjs` — add `cmdPersonality(...)`, register `personality` in dispatcher, add `/personality` slash REPL command, register `migrate rollback` subcommand.
- `/Users/o/lazyclaw/scripts/migrate-v5.mjs` — extend from Phase A skeleton: backup writer, config-key rewriter, sandbox-string→object, full skill frontmatter upgrade (group + confidence + trained_by), rollback entry.
- `/Users/o/lazyclaw/package.json` — add `personality` to the `bin` exposure is **not** required (subcommand of `lazyclaw`), but add `scripts/hermes-import.mjs` and `scripts/openclaw-import.mjs` to the `files` array for npm publish.

---

## Task 1 — `mas/prompt_stack.mjs` 8-layer compose (spec §9.3, decision C10)

Estimated: **45 min**. Owns layers 1 (global SOUL) + 1.5 (workspace SOUL [C10]) + 2 (personality) + 3 (agent.role) + 4 (USER.md @ `~/.lazyclaw/memory/USER.md` per C6) + 5 (skill index from `skills.skillsIndex()`) + 6 (memory recall — defers to existing `memory.loadCore` for now; FTS5 recall lives in Phase D) + 7 (trajectory tail — opt-in, reads last 1 entry from `recent.jsonl`). Output is a single newline-joined string suitable for prepending to the system prompt.

### Step 1.1 — Write the failing test

- [ ] Create `/Users/o/lazyclaw/tests/phaseG-prompt-stack.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpCfg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pstack-'));
}

test('composePromptStack orders 8 layers and skips empty layers', async () => {
  const cfgDir = tmpCfg();
  fs.mkdirSync(path.join(cfgDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, 'personalities'), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, 'workspaces', 'ws1'), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, 'skills'), { recursive: true });

  fs.writeFileSync(path.join(cfgDir, 'SOUL.md'), 'GLOBAL_SOUL');
  fs.writeFileSync(path.join(cfgDir, 'workspaces', 'ws1', 'SOUL.md'), 'WORKSPACE_SOUL');
  fs.writeFileSync(path.join(cfgDir, 'personalities', 'pirate.md'), 'PIRATE_PERSONA');
  fs.writeFileSync(path.join(cfgDir, 'memory', 'USER.md'), 'USER_FACTS');
  fs.writeFileSync(path.join(cfgDir, 'memory', 'core.md'), 'CORE_MEM');
  fs.writeFileSync(
    path.join(cfgDir, 'skills', 'dev-review.md'),
    '---\nname: dev-review\ndescription: review code\n---\nbody'
  );

  const mod = await import(`${process.cwd()}/mas/prompt_stack.mjs?ts=${Date.now()}`);
  const out = mod.composePromptStack({
    cfgDir,
    agent: { name: 'a1', role: 'AGENT_ROLE', personality: 'pirate' },
    workspace: 'ws1',
    sessionId: 's1',
  });

  expect(out).toContain('GLOBAL_SOUL');
  expect(out).toContain('WORKSPACE_SOUL');
  expect(out).toContain('PIRATE_PERSONA');
  expect(out).toContain('AGENT_ROLE');
  expect(out).toContain('USER_FACTS');
  expect(out).toContain('dev-review');
  expect(out).toContain('CORE_MEM');

  // Strict ordering: GLOBAL precedes WORKSPACE precedes PERSONA precedes ROLE
  // precedes USER_FACTS precedes skill index precedes CORE_MEM.
  const order = ['GLOBAL_SOUL', 'WORKSPACE_SOUL', 'PIRATE_PERSONA',
    'AGENT_ROLE', 'USER_FACTS', 'dev-review', 'CORE_MEM'];
  let last = -1;
  for (const tag of order) {
    const i = out.indexOf(tag);
    expect(i).toBeGreaterThan(last);
    last = i;
  }
});

test('composePromptStack skips missing layers without throwing', async () => {
  const cfgDir = tmpCfg();
  const mod = await import(`${process.cwd()}/mas/prompt_stack.mjs?ts=${Date.now()}`);
  const out = mod.composePromptStack({ cfgDir, agent: { name: 'a1' } });
  expect(typeof out).toBe('string');
});
```

### Step 1.2 — Run test, verify FAIL

- [ ] Run: `npx playwright test tests/phaseG-prompt-stack.spec.ts`
- [ ] Expected: `Error: Cannot find module '.../mas/prompt_stack.mjs'` — 2 failing tests.

### Step 1.3 — Implement `mas/prompt_stack.mjs`

- [ ] Create `/Users/o/lazyclaw/mas/prompt_stack.mjs`:

```js
// mas/prompt_stack.mjs
// 8-layer system-prompt composer (v5.0 spec §9.3, canonical C10).
// Layers (top-to-bottom in the system prompt):
//   1.  Global  SOUL.md          <configDir>/SOUL.md
//   1.5 Workspace SOUL.md        <configDir>/workspaces/<name>/SOUL.md      (C10)
//   2.  Personality              <configDir>/personalities/<name>.md         (C7)
//   3.  agent.role               from agent record
//   4.  USER.md                  <configDir>/memory/USER.md                  (C6)
//   5.  Skill index              skills.skillsIndex(cfgDir)
//   6.  Memory (core.md)         memory.loadCore(cfgDir)
//   7.  Trajectory tail          last recent.jsonl entry (best-effort)
//
// Missing layers are silently skipped. Never throws. Result is a single
// newline-joined string suitable for prepending to the agent system
// prompt. Caller decides whether to further sandwich it with task input.

import fs from 'node:fs';
import path from 'node:path';
import { skillsIndex } from '../skills.mjs';
import { loadCore, recentPath, defaultConfigDir } from '../memory.mjs';

function readOpt(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); }
  catch { return ''; }
}

function lastRecentLine(cfgDir) {
  try {
    const p = recentPath(cfgDir);
    if (!fs.existsSync(p)) return '';
    const txt = fs.readFileSync(p, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    if (!lines.length) return '';
    const parsed = JSON.parse(lines[lines.length - 1]);
    return `${parsed.role || 'user'}: ${String(parsed.content || '').slice(0, 240)}`;
  } catch { return ''; }
}

export function composePromptStack({ cfgDir, agent, workspace, sessionId } = {}) {
  const dir = cfgDir || defaultConfigDir();
  const a = agent || {};
  const parts = [];

  // 1. global SOUL
  const globalSoul = readOpt(path.join(dir, 'SOUL.md'));
  if (globalSoul) parts.push(`## SOUL\n${globalSoul}`);

  // 1.5 workspace SOUL (C10)
  if (workspace) {
    const wsSoul = readOpt(path.join(dir, 'workspaces', workspace, 'SOUL.md'));
    if (wsSoul) parts.push(`## Workspace SOUL (${workspace})\n${wsSoul}`);
  }

  // 2. personality (C7)
  if (a.personality) {
    const p = readOpt(path.join(dir, 'personalities', `${a.personality}.md`));
    if (p) parts.push(`## Personality (${a.personality})\n${p}`);
  }

  // 3. agent.role
  if (a.role) parts.push(`## Role (${a.name || 'agent'})\n${a.role}`);

  // 4. USER.md (C6)
  const userMd = readOpt(path.join(dir, 'memory', 'USER.md'));
  if (userMd) parts.push(`## What the user has told you before\n${userMd}`);

  // 5. skill index
  const idx = skillsIndex(dir);
  if (idx) parts.push(`## Available skills\n${idx}`);

  // 6. memory core.md
  const core = loadCore(dir);
  if (core && core.trim()) parts.push(`## Long-term memory\n${core.trim()}`);

  // 7. trajectory tail (sessionId may be ignored — recent.jsonl is global)
  const tail = lastRecentLine(dir);
  if (tail) parts.push(`## Most-recent turn\n${tail}`);

  return parts.join('\n\n');
}
```

### Step 1.4 — Run test, verify PASS

- [ ] Run: `npx playwright test tests/phaseG-prompt-stack.spec.ts`
- [ ] Expected: `2 passed`.

### Step 1.5 — Commit

- [ ] Run:

```bash
git add mas/prompt_stack.mjs tests/phaseG-prompt-stack.spec.ts
git commit -m "$(cat <<'EOF'
feat(mas): 8-layer prompt compose stack for v5 persona system

Implements the canonical layer order from spec §9.3 (decision C10):
global SOUL → workspace SOUL → personality → agent.role → USER.md
→ skill index → memory core → trajectory tail. Missing layers are
silently skipped so v4 installs that have not yet been migrated keep
producing valid system prompts.

Reads USER.md from ~/.lazyclaw/memory/USER.md (canonical C6) and
personalities from <configDir>/personalities/<name>.md (C7).
EOF
)"
```

---

## Task 2 — `lazyclaw personality` CLI + `/personality` REPL slash (spec §9, decision C7)

Estimated: **45 min**. Subcommands: `list` (lists `<configDir>/personalities/*.md`), `show <name>` (cats one), `install <name> <file>` (copies a `.md` into the directory; rejects existing), `remove <name>`, `use <name>` (writes `cfg.persona.personality = name` via the existing `cmdConfigSet` writer; per-agent override uses `agent.personality`).

### Step 2.1 — Write the failing test

- [ ] Create `/Users/o/lazyclaw/tests/phaseG-personality.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

function tmpCfg() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pers-')); }

function run(args: string[], cfgDir: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, LAZYCLAW_NO_INK: '1' },
    encoding: 'utf8',
  });
}

test('personality list empty', () => {
  const cfgDir = tmpCfg();
  const r = run(['personality', 'list'], cfgDir);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('No personalities installed');
});

test('personality install + list + show + remove', () => {
  const cfgDir = tmpCfg();
  const src = path.join(cfgDir, 'pirate.md');
  fs.writeFileSync(src, '# Pirate\nArrr.');

  let r = run(['personality', 'install', 'pirate', src], cfgDir);
  expect(r.status).toBe(0);
  expect(fs.existsSync(path.join(cfgDir, 'personalities', 'pirate.md'))).toBe(true);

  r = run(['personality', 'list'], cfgDir);
  expect(r.stdout).toContain('pirate');

  r = run(['personality', 'show', 'pirate'], cfgDir);
  expect(r.stdout).toContain('Arrr.');

  r = run(['personality', 'remove', 'pirate'], cfgDir);
  expect(r.status).toBe(0);
  expect(fs.existsSync(path.join(cfgDir, 'personalities', 'pirate.md'))).toBe(false);
});

test('personality use writes cfg.persona.personality', () => {
  const cfgDir = tmpCfg();
  fs.mkdirSync(path.join(cfgDir, 'personalities'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'personalities', 'pirate.md'), '# Pirate');

  const r = run(['personality', 'use', 'pirate'], cfgDir);
  expect(r.status).toBe(0);
  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  expect(cfg.persona?.personality).toBe('pirate');
});

test('personality use rejects unknown name', () => {
  const cfgDir = tmpCfg();
  const r = run(['personality', 'use', 'ghost'], cfgDir);
  expect(r.status).not.toBe(0);
  expect((r.stderr + r.stdout)).toMatch(/not installed|not found/i);
});
```

### Step 2.2 — Run test, verify FAIL

- [ ] Run: `npx playwright test tests/phaseG-personality.spec.ts`
- [ ] Expected: 4 failing — `lazyclaw personality` unknown command.

### Step 2.3 — Add `cmdPersonality` to `cli.mjs`

- [ ] Locate the command dispatcher (the `switch` near the bottom of `cli.mjs`; existing `cmdHelp` is at line 1229 — insert the new handler near `cmdConfigEdit` around line 642). Add:

```js
// --- Phase G: personality subcommand (spec §9, decision C7) -------------
import { defaultConfigDir as _persDefaultCfg } from './memory.mjs';

async function cmdPersonality(sub, a, b) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const cfgDir = process.env.LAZYCLAW_CONFIG_DIR || _persDefaultCfg();
  const dir = path.join(cfgDir, 'personalities');
  fs.mkdirSync(dir, { recursive: true });

  if (!sub || sub === 'list') {
    const names = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))
      : [];
    if (!names.length) { console.log('No personalities installed'); return 0; }
    for (const n of names.sort()) console.log(n);
    return 0;
  }

  if (sub === 'show') {
    if (!a) { console.error('Usage: lazyclaw personality show <name>'); return 2; }
    const p = path.join(dir, `${a}.md`);
    if (!fs.existsSync(p)) { console.error(`personality not found: ${a}`); return 1; }
    process.stdout.write(fs.readFileSync(p, 'utf8'));
    return 0;
  }

  if (sub === 'install') {
    if (!a || !b) { console.error('Usage: lazyclaw personality install <name> <file>'); return 2; }
    const dst = path.join(dir, `${a}.md`);
    if (fs.existsSync(dst)) { console.error(`personality already installed: ${a}`); return 1; }
    if (!fs.existsSync(b)) { console.error(`source file not found: ${b}`); return 1; }
    fs.writeFileSync(dst, fs.readFileSync(b, 'utf8'));
    console.log(`installed ${a}`);
    return 0;
  }

  if (sub === 'remove') {
    if (!a) { console.error('Usage: lazyclaw personality remove <name>'); return 2; }
    const p = path.join(dir, `${a}.md`);
    if (!fs.existsSync(p)) { console.error(`personality not installed: ${a}`); return 1; }
    fs.unlinkSync(p);
    console.log(`removed ${a}`);
    return 0;
  }

  if (sub === 'use') {
    if (!a) { console.error('Usage: lazyclaw personality use <name>'); return 2; }
    const p = path.join(dir, `${a}.md`);
    if (!fs.existsSync(p)) { console.error(`personality not installed: ${a}`); return 1; }
    const cfgPath = path.join(cfgDir, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
    cfg.persona = { ...(cfg.persona || {}), personality: a };
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log(`active personality: ${a}`);
    return 0;
  }

  console.error(`Unknown personality subcommand: ${sub}`);
  return 2;
}
```

- [ ] Register the command — find the existing dispatcher switch (search for `case 'config':` and add a sibling case):

```js
case 'personality':
  process.exit(await cmdPersonality(rest[0], rest[1], rest[2]));
  break;
```

- [ ] Add `/personality <sub> [args]` slash inside the REPL slash handler (search for `case '/help':` and add adjacent):

```js
case '/personality': {
  const parts = (rest || '').trim().split(/\s+/).filter(Boolean);
  await cmdPersonality(parts[0] || 'list', parts[1], parts[2]);
  break;
}
```

### Step 2.4 — Run test, verify PASS

- [ ] Run: `npx playwright test tests/phaseG-personality.spec.ts`
- [ ] Expected: `4 passed`.

### Step 2.5 — Commit

- [ ] Run:

```bash
git add cli.mjs tests/phaseG-personality.spec.ts
git commit -m "$(cat <<'EOF'
feat(cli): personality subcommand + /personality REPL slash

Manages <configDir>/personalities/<name>.md per canonical C7.
list/show/install/remove/use mirror the existing skill subcommand
surface so users do not need to learn a new vocabulary. `use`
writes cfg.persona.personality; per-agent override remains via
agent.personality (consumed by mas/prompt_stack.mjs layer 2).
EOF
)"
```

---

## Task 3 — Extend `scripts/migrate-v5.mjs`: backup, config rewrite, skill frontmatter upgrade, rollback (spec §1.7, §10, decisions C4 + C5 + C7)

Estimated: **70 min**. Phase A delivers a stub. Phase G makes it production-shaped: it snapshots the entire `~/.lazyclaw` tree to `~/.lazyclaw.v4.backup/<ISO-ts>/` first, then rewrites `config.json` (`orchestrator`→`orchestra`, inject `trainer` default when absent, convert `sandbox: "docker"` string to `sandbox: {backend: "docker"}` object), upgrades every `skills/*.md` to include `group:` (filename hyphen prefix or `legacy` — C5), `confidence: 0.5`, `trained_by: legacy` (C4) if missing. `lazyclaw migrate rollback` restores the most-recent backup.

### Step 3.1 — Write the failing tests + fixtures

- [ ] Create `/Users/o/lazyclaw/tests/fixtures/v4-minimal/config.json`:

```json
{
  "provider": "claude",
  "model": "claude-opus-4-7"
}
```

- [ ] Create `/Users/o/lazyclaw/tests/fixtures/v4-slack-heavy/config.json`:

```json
{
  "provider": "claude",
  "model": "claude-opus-4-7",
  "sandbox": "docker",
  "channels": {
    "slack": { "botToken": "xoxb-xxx", "appToken": "xapp-xxx" }
  }
}
```

- [ ] Create `/Users/o/lazyclaw/tests/fixtures/v4-skill-heavy/config.json`:

```json
{
  "provider": "openai",
  "model": "gpt-5",
  "orchestrator": {
    "planner": "claude_cli:opus",
    "workers": ["claude_cli:sonnet", "codex_cli:gpt-5-codex"]
  }
}
```

- [ ] Create `/Users/o/lazyclaw/tests/phaseG-migrate.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');
const FIX = path.join(process.cwd(), 'tests', 'fixtures');

function setup(fixtureName: string): string {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), `lc-mig-${fixtureName}-`));
  const cfgSrc = path.join(FIX, fixtureName, 'config.json');
  fs.writeFileSync(path.join(dst, 'config.json'), fs.readFileSync(cfgSrc, 'utf8'));
  return dst;
}

function run(args: string[], cfgDir: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, LAZYCLAW_NO_INK: '1' },
    encoding: 'utf8',
  });
}

test('migrate v4-minimal: writes backup + injects trainer default', () => {
  const cfgDir = setup('v4-minimal');
  const r = run(['migrate'], cfgDir);
  expect(r.status).toBe(0);
  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  expect(cfg.trainer).toBeDefined();
  const backups = fs.readdirSync(path.dirname(cfgDir))
    .filter(d => d.endsWith('.v4.backup'));
  // Backup directory lives at <cfgDir>.v4.backup
  expect(fs.existsSync(`${cfgDir}.v4.backup`)).toBe(true);
});

test('migrate v4-slack-heavy: sandbox string → object', () => {
  const cfgDir = setup('v4-slack-heavy');
  const r = run(['migrate'], cfgDir);
  expect(r.status).toBe(0);
  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  expect(typeof cfg.sandbox).toBe('object');
  expect(cfg.sandbox.backend).toBe('docker');
  expect(cfg.channels.slack.botToken).toBe('xoxb-xxx'); // preserved
});

test('migrate v4-skill-heavy: orchestrator → orchestra + skill frontmatter upgrade', () => {
  const cfgDir = setup('v4-skill-heavy');
  // Seed a v4 skill with no group/confidence/trained_by
  fs.mkdirSync(path.join(cfgDir, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'skills', 'dev-review.md'),
    '---\nname: dev-review\ndescription: review code\nversion: 2\n---\n# body'
  );
  fs.writeFileSync(
    path.join(cfgDir, 'skills', 'standalone.md'),
    '---\nname: standalone\ndescription: noop\n---\n# body'
  );
  const r = run(['migrate'], cfgDir);
  expect(r.status).toBe(0);

  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  expect(cfg.orchestra).toBeDefined();
  expect(cfg.orchestrator).toBeUndefined();

  const sk1 = fs.readFileSync(path.join(cfgDir, 'skills', 'dev-review.md'), 'utf8');
  expect(sk1).toMatch(/group:\s*dev/);              // C5 hyphen prefix
  expect(sk1).toMatch(/confidence:\s*0\.5/);
  expect(sk1).toMatch(/trained_by:\s*legacy/);

  const sk2 = fs.readFileSync(path.join(cfgDir, 'skills', 'standalone.md'), 'utf8');
  expect(sk2).toMatch(/group:\s*legacy/);            // no hyphen → legacy (C5)
});

test('migrate rollback restores the snapshot', () => {
  const cfgDir = setup('v4-minimal');
  const before = fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8');
  expect(run(['migrate'], cfgDir).status).toBe(0);
  expect(run(['migrate', 'rollback'], cfgDir).status).toBe(0);
  const after = fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8');
  expect(after.trim()).toBe(before.trim());
});
```

### Step 3.2 — Run tests, verify FAIL

- [ ] Run: `npx playwright test tests/phaseG-migrate.spec.ts`
- [ ] Expected: 4 failing — `migrate` unknown or stub from Phase A.

### Step 3.3 — Extend `scripts/migrate-v5.mjs`

- [ ] Open `/Users/o/lazyclaw/scripts/migrate-v5.mjs` (created in Phase A). Replace the body so the file looks like this — keeping the Phase-A exported entry name `migrate(opts)` intact:

```js
// scripts/migrate-v5.mjs
// v4 → v5 migration entrypoint. Backs up the entire config dir to
// "<cfgDir>.v4.backup/<ISO-ts>" then rewrites config.json + every
// skills/*.md frontmatter in place. Canonical decisions referenced:
//   C4 trained_by enum  → "legacy" for pre-existing skills
//   C5 group fallback   → filename hyphen prefix, else "legacy"
//   C7 personalities dir is created (empty) so subcommands work
//   C10 (workspace SOUL) — left to user; we only ensure dirs exist

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function defaultConfigDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

function isoTs() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function removeTree(p) {
  if (!fs.existsSync(p)) return;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const c = path.join(p, entry.name);
    if (entry.isDirectory()) removeTree(c);
    else fs.unlinkSync(c);
  }
  fs.rmdirSync(p);
}

function backup(cfgDir) {
  const root = `${cfgDir}.v4.backup`;
  fs.mkdirSync(root, { recursive: true });
  const dst = path.join(root, isoTs());
  copyTree(cfgDir, dst);
  return dst;
}

function rewriteConfig(cfgDir) {
  const p = path.join(cfgDir, 'config.json');
  if (!fs.existsSync(p)) return;
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`migrate: config.json is not valid JSON: ${e.message}`); }

  // orchestrator → orchestra (C3 + spec §3.9)
  if (cfg.orchestrator && !cfg.orchestra) {
    cfg.orchestra = cfg.orchestrator;
    delete cfg.orchestrator;
  }

  // sandbox: "docker" → sandbox: { backend: "docker" } (C8)
  if (typeof cfg.sandbox === 'string') {
    cfg.sandbox = { backend: cfg.sandbox };
  }

  // Default trainer (auto) when absent (C9)
  if (!cfg.trainer) {
    cfg.trainer = { provider: 'auto', schedule: 'nightly' };
  }

  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}

function upgradeSkill(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Frontmatter detection mirrors skills.mjs::parseFrontmatter
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return;
  const after = raw.slice(4);
  const closeRe = /\r?\n---[ \t]*(?:\r?\n|$)/;
  const m = closeRe.exec(after);
  if (!m) return;
  const block = after.slice(0, m.index);
  const body = after.slice(m.index + m[0].length);
  const keys = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) keys[kv[1]] = kv[2];
  }

  const fname = path.basename(filePath, '.md');
  const hyphenPrefix = fname.includes('-') ? fname.split('-')[0] : null;

  let mutated = false;
  if (!keys.group) {
    keys.group = hyphenPrefix || 'legacy';                  // C5
    mutated = true;
  }
  if (!keys.confidence) { keys.confidence = '0.5'; mutated = true; }
  if (!keys.trained_by) { keys.trained_by = 'legacy'; mutated = true; }   // C4

  if (!mutated) return;
  // Emit in a stable order: keep originals first, append new ones
  const orderedKeys = [];
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:/.exec(line.trim());
    if (kv && !orderedKeys.includes(kv[1])) orderedKeys.push(kv[1]);
  }
  for (const k of ['group', 'confidence', 'trained_by']) {
    if (!orderedKeys.includes(k)) orderedKeys.push(k);
  }
  const newBlock = orderedKeys.map(k => `${k}: ${keys[k]}`).join('\n');
  fs.writeFileSync(filePath, `---\n${newBlock}\n---\n${body}`);
}

function upgradeAllSkills(cfgDir) {
  const dir = path.join(cfgDir, 'skills');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.md')) upgradeSkill(path.join(dir, f));
  }
}

function ensureDirs(cfgDir) {
  fs.mkdirSync(path.join(cfgDir, 'personalities'), { recursive: true });   // C7
  fs.mkdirSync(path.join(cfgDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(cfgDir, 'workspaces'), { recursive: true });
}

export function migrate({ cfgDir } = {}) {
  const dir = cfgDir || defaultConfigDir();
  if (!fs.existsSync(dir)) throw new Error(`config dir not found: ${dir}`);
  const backupDir = backup(dir);
  rewriteConfig(dir);
  upgradeAllSkills(dir);
  ensureDirs(dir);
  return { backupDir };
}

export function rollback({ cfgDir } = {}) {
  const dir = cfgDir || defaultConfigDir();
  const root = `${dir}.v4.backup`;
  if (!fs.existsSync(root)) throw new Error(`no backup found at ${root}`);
  const stamps = fs.readdirSync(root).sort();
  if (!stamps.length) throw new Error(`no backup snapshots in ${root}`);
  const latest = path.join(root, stamps[stamps.length - 1]);
  // wipe current cfgDir contents, restore latest
  for (const entry of fs.readdirSync(dir)) removeTree(path.join(dir, entry));
  copyTree(latest, dir);
  return { restoredFrom: latest };
}
```

- [ ] Wire dispatcher entries in `cli.mjs` (sibling to `personality`). Search for the existing dispatcher switch and add:

```js
case 'migrate': {
  const sub = rest[0];
  const mod = await import('./scripts/migrate-v5.mjs');
  try {
    if (sub === 'rollback') {
      const { restoredFrom } = mod.rollback();
      console.log(`rolled back from ${restoredFrom}`);
    } else {
      const { backupDir } = mod.migrate();
      console.log(`migrated; backup at ${backupDir}`);
    }
    process.exit(0);
  } catch (e) {
    console.error(`migrate failed: ${e.message}`);
    process.exit(1);
  }
  break;
}
```

### Step 3.4 — Run tests, verify PASS

- [ ] Run: `npx playwright test tests/phaseG-migrate.spec.ts`
- [ ] Expected: `4 passed`.

### Step 3.5 — Commit

- [ ] Run:

```bash
git add scripts/migrate-v5.mjs cli.mjs tests/phaseG-migrate.spec.ts tests/fixtures/v4-minimal tests/fixtures/v4-slack-heavy tests/fixtures/v4-skill-heavy
git commit -m "$(cat <<'EOF'
feat(migrate): full v4→v5 migration + rollback

Snapshots the entire config dir to <cfgDir>.v4.backup/<ISO-ts> before
rewriting config.json (orchestrator→orchestra, sandbox string→object
per C8, auto-trainer default per C9) and every skills/*.md frontmatter
(group fallback per C5, confidence 0.5, trained_by legacy per C4).
`lazyclaw migrate rollback` restores the most-recent snapshot.

Three fixture v4 installs (minimal/slack-heavy/skill-heavy) round-trip
clean.
EOF
)"
```

---

## Task 4 — `scripts/hermes-import.mjs` + `lazyclaw hermes import` CLI (spec §10, §1.6)

Estimated: **45 min**. Detect `~/.hermes` (or `--from <dir>`), copy `skills/*.md` with `trained_by: hermes-import` (canonical C4), merge `USER.md` + `MEMORY.md` content into `~/.lazyclaw/memory/USER.md` and `core.md`, map channel tokens (`hermes/channels.json` → `cfg.channels.*`), and best-effort convert any `skins/*.yaml` to `personalities/hermes-<slug>.md` (C7).

### Step 4.1 — Write the failing test

- [ ] Create `/Users/o/lazyclaw/tests/phaseG-hermes-import.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

test('hermes import smoke: skills + USER + skin → personality', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-hi-'));
  const hermes = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-fake-'));

  fs.mkdirSync(path.join(hermes, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(hermes, 'skills', 'dev-review.md'),
    '---\nname: dev-review\ndescription: review code\n---\nbody'
  );
  fs.writeFileSync(path.join(hermes, 'USER.md'), 'user knows ts');
  fs.writeFileSync(path.join(hermes, 'MEMORY.md'), 'core knowledge');
  fs.mkdirSync(path.join(hermes, 'skins'), { recursive: true });
  fs.writeFileSync(
    path.join(hermes, 'skins', 'pirate.yaml'),
    'name: pirate\nprompt: "arr matey"\n'
  );

  const r = spawnSync(
    process.execPath, [CLI, 'hermes', 'import', '--from', hermes],
    { env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, LAZYCLAW_NO_INK: '1' }, encoding: 'utf8' }
  );
  expect(r.status).toBe(0);

  const sk = fs.readFileSync(path.join(cfgDir, 'skills', 'dev-review.md'), 'utf8');
  expect(sk).toMatch(/trained_by:\s*hermes-import/);

  const userMd = fs.readFileSync(path.join(cfgDir, 'memory', 'USER.md'), 'utf8');
  expect(userMd).toContain('user knows ts');

  const core = fs.readFileSync(path.join(cfgDir, 'memory', 'core.md'), 'utf8');
  expect(core).toContain('core knowledge');

  expect(fs.existsSync(path.join(cfgDir, 'personalities', 'hermes-pirate.md'))).toBe(true);
});
```

### Step 4.2 — Run test, verify FAIL

- [ ] Run: `npx playwright test tests/phaseG-hermes-import.spec.ts`
- [ ] Expected: 1 failing — `hermes` unknown command.

### Step 4.3 — Implement `scripts/hermes-import.mjs`

- [ ] Create `/Users/o/lazyclaw/scripts/hermes-import.mjs`:

```js
// scripts/hermes-import.mjs
// Detect ~/.hermes (or --from <dir>) and import into lazyclaw.
//   skills/*.md       → <cfgDir>/skills/*.md with trained_by: hermes-import (C4)
//   USER.md           → <cfgDir>/memory/USER.md          (C6)
//   MEMORY.md         → <cfgDir>/memory/core.md          (merged, append)
//   channels.json     → cfg.channels.* (best-effort)
//   skins/<slug>.yaml → <cfgDir>/personalities/hermes-<slug>.md (C7)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function defaultHermesDir() { return path.join(os.homedir(), '.hermes'); }
export function defaultCfgDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

function injectTrainedBy(content, value) {
  if (!content.startsWith('---')) {
    return `---\ntrained_by: ${value}\n---\n${content}`;
  }
  // Replace existing trained_by or insert before closing fence
  const closeRe = /\r?\n---[ \t]*(?:\r?\n|$)/;
  const m = closeRe.exec(content.slice(3));
  if (!m) return content;
  const block = content.slice(4, 3 + m.index);
  const rest = content.slice(3 + m.index + m[0].length);
  if (/^trained_by:/m.test(block)) {
    return `---\n${block.replace(/^trained_by:.*$/m, `trained_by: ${value}`)}\n---\n${rest}`;
  }
  return `---\n${block}\ntrained_by: ${value}\n---\n${rest}`;
}

function importSkills(srcDir, dstDir) {
  const src = path.join(srcDir, 'skills');
  if (!fs.existsSync(src)) return 0;
  const dst = path.join(dstDir, 'skills');
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(src, f), 'utf8');
    fs.writeFileSync(path.join(dst, f), injectTrainedBy(content, 'hermes-import'));
    n++;
  }
  return n;
}

function importMemory(srcDir, dstDir) {
  const memDir = path.join(dstDir, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const userSrc = path.join(srcDir, 'USER.md');
  if (fs.existsSync(userSrc)) {
    const incoming = fs.readFileSync(userSrc, 'utf8');
    const dst = path.join(memDir, 'USER.md');
    const existing = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
    fs.writeFileSync(dst, existing ? `${existing}\n\n<!-- hermes-import -->\n${incoming}` : incoming);
  }
  const memSrc = path.join(srcDir, 'MEMORY.md');
  if (fs.existsSync(memSrc)) {
    const incoming = fs.readFileSync(memSrc, 'utf8');
    const dst = path.join(memDir, 'core.md');
    const existing = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
    fs.writeFileSync(dst, existing ? `${existing}\n\n<!-- hermes-import -->\n${incoming}` : incoming);
  }
}

function importChannels(srcDir, cfgDir) {
  const src = path.join(srcDir, 'channels.json');
  if (!fs.existsSync(src)) return;
  let incoming;
  try { incoming = JSON.parse(fs.readFileSync(src, 'utf8')); } catch { return; }
  const cfgPath = path.join(cfgDir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg.channels = { ...(cfg.channels || {}), ...incoming };
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

function importSkins(srcDir, dstDir) {
  const src = path.join(srcDir, 'skins');
  if (!fs.existsSync(src)) return 0;
  const dst = path.join(dstDir, 'personalities');
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const slug = f.replace(/\.ya?ml$/, '');
    const raw = fs.readFileSync(path.join(src, f), 'utf8');
    // Best-effort: extract `prompt:` flat YAML; else dump raw.
    const m = /^prompt:\s*"?(.*?)"?\s*$/m.exec(raw);
    const body = m ? m[1] : raw;
    fs.writeFileSync(path.join(dst, `hermes-${slug}.md`), `# ${slug} (imported from Hermes)\n\n${body}\n`);
    n++;
  }
  return n;
}

export function importHermes({ from, cfgDir } = {}) {
  const src = from || defaultHermesDir();
  const dst = cfgDir || defaultCfgDir();
  if (!fs.existsSync(src)) throw new Error(`hermes source not found: ${src}`);
  fs.mkdirSync(dst, { recursive: true });
  const counts = {
    skills: importSkills(src, dst),
    memory: (importMemory(src, dst), 1),
    channels: (importChannels(src, dst), 1),
    skins: importSkins(src, dst),
  };
  return { src, dst, counts };
}
```

- [ ] Wire dispatcher in `cli.mjs`:

```js
case 'hermes': {
  if (rest[0] !== 'import') {
    console.error('Usage: lazyclaw hermes import [--from <dir>]');
    process.exit(2);
  }
  const fromIdx = rest.indexOf('--from');
  const from = fromIdx >= 0 ? rest[fromIdx + 1] : undefined;
  const mod = await import('./scripts/hermes-import.mjs');
  try {
    const { src, dst, counts } = mod.importHermes({ from });
    console.log(`hermes import: ${src} → ${dst}`);
    console.log(`  skills: ${counts.skills}  skins: ${counts.skins}`);
    process.exit(0);
  } catch (e) { console.error(`hermes import failed: ${e.message}`); process.exit(1); }
  break;
}
```

### Step 4.4 — Run test, verify PASS

- [ ] Run: `npx playwright test tests/phaseG-hermes-import.spec.ts`
- [ ] Expected: `1 passed`.

### Step 4.5 — Commit

- [ ] Run:

```bash
git add scripts/hermes-import.mjs cli.mjs tests/phaseG-hermes-import.spec.ts
git commit -m "$(cat <<'EOF'
feat(migrate): lazyclaw hermes import

Imports a Hermes Agent install (~/.hermes or --from <dir>) into the
lazyclaw config dir. Skills land in <cfgDir>/skills/ with
trained_by: hermes-import (canonical C4). USER.md merges into
<cfgDir>/memory/USER.md (C6). MEMORY.md appends to core.md.
channels.json maps onto cfg.channels.*. skins/*.yaml best-effort
becomes personalities/hermes-<slug>.md (C7).
EOF
)"
```

---

## Task 5 — `scripts/openclaw-import.mjs` + `lazyclaw openclaw import` (spec §10, matches Hermes `claw migrate` coverage)

Estimated: **35 min**. Detect `~/.openclaw`, copy SOUL.md + MEMORY.md + USER.md + skills + allowlist + messaging config; tag every skill `trained_by: openclaw-import` (C4). Mirrors Task 4 structure but with OpenClaw layout (SOUL.md at root, MEMORY.md, allowlist.json).

### Step 5.1 — Write the failing test

- [ ] Create `/Users/o/lazyclaw/tests/phaseG-openclaw-import.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.join(process.cwd(), 'cli.mjs');

test('openclaw import smoke', () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-oc-'));
  const oc = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-fake-'));

  fs.writeFileSync(path.join(oc, 'SOUL.md'), 'OPENCLAW SOUL');
  fs.writeFileSync(path.join(oc, 'USER.md'), 'oc user facts');
  fs.writeFileSync(path.join(oc, 'MEMORY.md'), 'oc core');
  fs.mkdirSync(path.join(oc, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(oc, 'skills', 'ops-deploy.md'),
    '---\nname: ops-deploy\ndescription: deploy\n---\nbody'
  );
  fs.writeFileSync(path.join(oc, 'allowlist.json'), '{"bash":["ls","pwd"]}');
  fs.writeFileSync(path.join(oc, 'messaging.json'), '{"slack":{"botToken":"xoxb-oc"}}');

  const r = spawnSync(
    process.execPath, [CLI, 'openclaw', 'import', '--from', oc],
    { env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, LAZYCLAW_NO_INK: '1' }, encoding: 'utf8' }
  );
  expect(r.status).toBe(0);

  expect(fs.readFileSync(path.join(cfgDir, 'SOUL.md'), 'utf8')).toContain('OPENCLAW SOUL');
  expect(fs.readFileSync(path.join(cfgDir, 'memory', 'USER.md'), 'utf8')).toContain('oc user facts');
  expect(fs.readFileSync(path.join(cfgDir, 'memory', 'core.md'), 'utf8')).toContain('oc core');
  const sk = fs.readFileSync(path.join(cfgDir, 'skills', 'ops-deploy.md'), 'utf8');
  expect(sk).toMatch(/trained_by:\s*openclaw-import/);

  const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  expect(cfg.allowlist?.bash).toContain('ls');
  expect(cfg.channels?.slack?.botToken).toBe('xoxb-oc');
});
```

### Step 5.2 — Run test, verify FAIL

- [ ] Run: `npx playwright test tests/phaseG-openclaw-import.spec.ts`
- [ ] Expected: 1 failing — `openclaw` unknown command.

### Step 5.3 — Implement `scripts/openclaw-import.mjs`

- [ ] Create `/Users/o/lazyclaw/scripts/openclaw-import.mjs`:

```js
// scripts/openclaw-import.mjs
// Detect ~/.openclaw (or --from <dir>) and import into lazyclaw,
// matching Hermes `claw migrate` coverage. Tags every skill
// trained_by: openclaw-import (canonical C4).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function defaultOpenclawDir() { return path.join(os.homedir(), '.openclaw'); }
export function defaultCfgDir() {
  return process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.lazyclaw');
}

function injectTrainedBy(content, value) {
  if (!content.startsWith('---')) return `---\ntrained_by: ${value}\n---\n${content}`;
  const closeRe = /\r?\n---[ \t]*(?:\r?\n|$)/;
  const m = closeRe.exec(content.slice(3));
  if (!m) return content;
  const block = content.slice(4, 3 + m.index);
  const rest = content.slice(3 + m.index + m[0].length);
  if (/^trained_by:/m.test(block)) {
    return `---\n${block.replace(/^trained_by:.*$/m, `trained_by: ${value}`)}\n---\n${rest}`;
  }
  return `---\n${block}\ntrained_by: ${value}\n---\n${rest}`;
}

function copyIfPresent(srcFile, dstFile, transform = (s) => s) {
  if (!fs.existsSync(srcFile)) return false;
  fs.mkdirSync(path.dirname(dstFile), { recursive: true });
  fs.writeFileSync(dstFile, transform(fs.readFileSync(srcFile, 'utf8')));
  return true;
}

function mergeJson(srcFile, cfgKey, cfgDir) {
  if (!fs.existsSync(srcFile)) return;
  let incoming; try { incoming = JSON.parse(fs.readFileSync(srcFile, 'utf8')); } catch { return; }
  const cfgPath = path.join(cfgDir, 'config.json');
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  cfg[cfgKey] = { ...(cfg[cfgKey] || {}), ...incoming };
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

export function importOpenclaw({ from, cfgDir } = {}) {
  const src = from || defaultOpenclawDir();
  const dst = cfgDir || defaultCfgDir();
  if (!fs.existsSync(src)) throw new Error(`openclaw source not found: ${src}`);
  fs.mkdirSync(dst, { recursive: true });

  copyIfPresent(path.join(src, 'SOUL.md'),  path.join(dst, 'SOUL.md'));
  copyIfPresent(path.join(src, 'USER.md'),  path.join(dst, 'memory', 'USER.md'));
  copyIfPresent(path.join(src, 'MEMORY.md'), path.join(dst, 'memory', 'core.md'));

  const skillsSrc = path.join(src, 'skills');
  let nSkills = 0;
  if (fs.existsSync(skillsSrc)) {
    const skillsDst = path.join(dst, 'skills');
    fs.mkdirSync(skillsDst, { recursive: true });
    for (const f of fs.readdirSync(skillsSrc)) {
      if (!f.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(skillsSrc, f), 'utf8');
      fs.writeFileSync(path.join(skillsDst, f), injectTrainedBy(content, 'openclaw-import'));
      nSkills++;
    }
  }

  mergeJson(path.join(src, 'allowlist.json'), 'allowlist', dst);
  mergeJson(path.join(src, 'messaging.json'), 'channels', dst);

  return { src, dst, counts: { skills: nSkills } };
}
```

- [ ] Wire dispatcher in `cli.mjs`:

```js
case 'openclaw': {
  if (rest[0] !== 'import') {
    console.error('Usage: lazyclaw openclaw import [--from <dir>]');
    process.exit(2);
  }
  const fromIdx = rest.indexOf('--from');
  const from = fromIdx >= 0 ? rest[fromIdx + 1] : undefined;
  const mod = await import('./scripts/openclaw-import.mjs');
  try {
    const { src, dst, counts } = mod.importOpenclaw({ from });
    console.log(`openclaw import: ${src} → ${dst}  skills:${counts.skills}`);
    process.exit(0);
  } catch (e) { console.error(`openclaw import failed: ${e.message}`); process.exit(1); }
  break;
}
```

### Step 5.4 — Run test, verify PASS

- [ ] Run: `npx playwright test tests/phaseG-openclaw-import.spec.ts`
- [ ] Expected: `1 passed`.

### Step 5.5 — Update `package.json` files array + commit

- [ ] Edit `/Users/o/lazyclaw/package.json` — add the two new scripts to the `files` array (sibling to `scripts/loop-worker.mjs`):

```json
    "scripts/loop-worker.mjs",
    "scripts/migrate-v5.mjs",
    "scripts/hermes-import.mjs",
    "scripts/openclaw-import.mjs",
```

- [ ] Run the full Phase G suite to confirm nothing regressed:

```bash
npx playwright test tests/phaseG-prompt-stack.spec.ts tests/phaseG-personality.spec.ts tests/phaseG-migrate.spec.ts tests/phaseG-hermes-import.spec.ts tests/phaseG-openclaw-import.spec.ts
```

- [ ] Expected: `12 passed`.

- [ ] Run:

```bash
git add scripts/openclaw-import.mjs cli.mjs tests/phaseG-openclaw-import.spec.ts package.json
git commit -m "$(cat <<'EOF'
feat(migrate): lazyclaw openclaw import

Matches Hermes 'claw migrate' coverage for OpenClaw installs:
SOUL.md, MEMORY.md, USER.md, skills/* (tagged trained_by:
openclaw-import per canonical C4), allowlist.json, messaging.json.
USER.md lands at <cfgDir>/memory/USER.md (C6). Allowlist + channel
configs merge into cfg.allowlist / cfg.channels.

Closes Phase G. Acceptance: 3 fixture v4 installs migrate clean,
Hermes + OpenClaw smoke tests green, SOUL.md prepend visible in
the composed system prompt via mas/prompt_stack.mjs.
EOF
)"
```

---

## Phase G acceptance verification

- [ ] All five spec tests pass: prompt-stack ordering + missing-layer fallback, personality CRUD + use, migrate (3 fixtures + rollback), hermes import smoke, openclaw import smoke.
- [ ] `lazyclaw personality list` works in a fresh config dir (empty list, exit 0).
- [ ] `lazyclaw migrate` on a v4 install produces `<cfgDir>.v4.backup/<ISO-ts>/` and rewrites config + skills frontmatter.
- [ ] `lazyclaw migrate rollback` restores the pre-migration state byte-for-byte for `config.json`.
- [ ] `mas/prompt_stack.mjs::composePromptStack` returns a string in which `## SOUL` appears before `## Workspace SOUL` before `## Personality` (decision C10).
- [ ] Hermes and OpenClaw imports leave skills tagged with the correct `trained_by:` value (canonical C4 enum).
