# Unified Model Picker + Slash-Argument Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every interactive model-setting slash command through one canonical provider→model picker (with custom-id entry), and make the value typed after a command autocomplete via the existing modal picker.

**Architecture:** Hoist the Ink model-picker helpers out of `slash_dispatcher.mjs` into a new `tui/model_pick.mjs` exporting `pickProviderModel(ctx, registry, opts)`; migrate `/model`, `/provider`, `/trainer`, `/orchestrator`, `/agent` onto it and delete the orchestrator twin. Add a pure `tui/slash_args.mjs` (arg spec + completers) plus a `fillArgToken` editor primitive; relax the REPL space-guard so a command with an arg-completer keeps an inline hint, and a Tab in argument position opens `ctx.openPicker` seeded with the partial, then injects the chosen value back into the editor buffer.

**Tech Stack:** Node.js ESM (`.mjs`), Ink/React TUI, `node:test` + `node:assert/strict`. Tests render `ReplApp` over `PassThrough` stdio and script `ctx.openPicker` with a mock (see `tests/f-slash-args.test.mjs`, `tests/p3-model-switch.test.mjs`).

**Conventions:** Frequent atomic commits, English comments/messages, no Claude attribution, push to `main` after each green task (per session instruction). Run a single test file with `node --test tests/<file>.test.mjs`.

---

## File Structure

| File | Responsibility | Status |
|------|----------------|--------|
| `tui/model_pick.mjs` | Canonical `pickProviderModel()` + the provider/model picker helpers hoisted from the dispatcher. | **NEW** |
| `tui/slash_args.mjs` | Pure `argSpecFor(buffer, catalog)` + `ARG_COMPLETERS` (build the fill value, may call `pickProviderModel`). | **NEW** |
| `tui/slash_commands.mjs` | Add pure-data `arg:{name,completer}` to the 5 commands. | modify |
| `tui/editor_keys.mjs` | Add `fillArgToken(state, value)`. | modify |
| `tui/editor.mjs` | New props `argCompletable`/`onArgComplete`/`argInject`; Tab-in-arg branch + inject effect. | modify |
| `tui/repl.mjs` | Compute arg spec, render arg hint past the space-guard, wire Editor arg props, `openPicker` query seed. | modify |
| `tui/slash_dispatcher.mjs` | `/model`,`/provider`,`/trainer`,`/agent` call `pickProviderModel`; import hoisted helpers. | modify |
| `tui/orchestrator_flow.mjs` | Delete `pickModelForProvider`; `pickProviderModelSpec` wraps `pickProviderModel`. | modify |
| `commands/chat.mjs` | Build `onArgComplete` from the dispatch ctx + pass to `ReplApp`. | modify |
| `providers/registry.mjs`,`providers/anthropic.mjs`,`providers/tool_use/anthropic.mjs`,`providers/gemini.mjs`,`providers/tool_use/gemini.mjs` | Default/fallback model bumps. | modify |
| `config-validate.mjs` | Widen `KNOWN_KEYS`. | modify |
| `CHANGELOG.md`, `README*` | Document new behavior. | modify |

---

## Phase 0 — Bundled fixes (independent, low-risk)

### Task 0.1: Bump stale default models + adapter fallbacks

**Files:**
- Modify: `providers/registry.mjs:194` (claude-cli `defaultModel`), `:237` (anthropic `defaultModel`)
- Modify: `providers/anthropic.mjs:194`, `providers/tool_use/anthropic.mjs:71`
- Modify: `providers/gemini.mjs:188`, `providers/tool_use/gemini.mjs:91`
- Test: `tests/d6-defaults.test.mjs` (**NEW**)

- [ ] **Step 1: Write the failing test**

```js
// tests/d6-defaults.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../providers/registry.mjs';

test('claude-cli + anthropic default to the current Opus', () => {
  const info = registry.PROVIDER_INFO;
  assert.equal(info['claude-cli'].defaultModel, 'claude-opus-4-8');
  assert.equal(info['anthropic'].defaultModel, 'claude-opus-4-8');
  assert.ok(info['claude-cli'].suggestedModels.includes('claude-opus-4-8'));
});

test('gemini default + fallbacks agree on gemini-2.5-pro', () => {
  assert.equal(registry.PROVIDER_INFO['gemini'].defaultModel, 'gemini-2.5-pro');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test tests/d6-defaults.test.mjs`
Expected: FAIL — current `defaultModel` is `claude-opus-4-7`.

- [ ] **Step 3: Apply the bumps**

- `providers/registry.mjs:194` `'claude-opus-4-7'` → `'claude-opus-4-8'`
- `providers/registry.mjs:237` `'claude-opus-4-7'` → `'claude-opus-4-8'`
- `providers/anthropic.mjs:194` `opts.model || 'claude-opus-4-7'` → `'claude-opus-4-8'`
- `providers/tool_use/anthropic.mjs:71` `model || 'claude-opus-4-7'` → `'claude-opus-4-8'`
- `providers/gemini.mjs:188` `opts.model || 'gemini-1.5-pro'` → `'gemini-2.5-pro'`
- `providers/tool_use/gemini.mjs:91` `model || 'gemini-2.5-flash'` → `'gemini-2.5-pro'`

Confirm each literal exists in the provider's `suggestedModels` before changing; if `gemini-2.5-pro` is not listed, leave the fallback at the registry default value and note it in the commit.

- [ ] **Step 4: Run test, verify PASS**

Run: `node --test tests/d6-defaults.test.mjs` → PASS.

- [ ] **Step 5: Commit + push**

```bash
git add providers/registry.mjs providers/anthropic.mjs providers/tool_use/anthropic.mjs providers/gemini.mjs providers/tool_use/gemini.mjs tests/d6-defaults.test.mjs
git commit -m "fix(providers): bump stale default models to current Opus/Gemini

claude-cli/anthropic defaultModel was claude-opus-4-7 (prev gen) and the
streaming + tool_use fallbacks disagreed with the registry. Align all to
claude-opus-4-8 / gemini-2.5-pro so empty-model agents and providers test
hit a current model."
git push origin main
```

### Task 0.2: Widen `KNOWN_KEYS` so first-class config keys validate

**Files:**
- Modify: `config-validate.mjs:9`
- Test: `tests/d6-known-keys.test.mjs` (**NEW**)

- [ ] **Step 1: Write the failing test**

```js
// tests/d6-known-keys.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../config-validate.mjs';

test('trainer + orchestrator are recognized top-level keys', () => {
  const res = validateConfig({ provider: 'mock', trainer: { provider: 'auto' }, orchestrator: { workers: [] } });
  const msg = JSON.stringify(res);
  assert.ok(!/unknown top-level key.*trainer/i.test(msg), 'trainer must be known');
  assert.ok(!/unknown top-level key.*orchestrator/i.test(msg), 'orchestrator must be known');
});
```

> Read `config-validate.mjs` first to confirm the export name (`validateConfig`) and its return shape; adapt the assertion to match how it reports unknown keys (array of strings vs throw).

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test tests/d6-known-keys.test.mjs` → FAIL.

- [ ] **Step 3: Widen the set**

`config-validate.mjs:9`:
```js
const KNOWN_KEYS = new Set(['provider', 'model', 'api-key', 'rates', 'trainer', 'orchestrator', 'persona', 'customProviders', 'chat']);
```

- [ ] **Step 4: Run test, verify PASS** → PASS.

- [ ] **Step 5: Commit + push**

```bash
git add config-validate.mjs tests/d6-known-keys.test.mjs
git commit -m "fix(config): recognize trainer/orchestrator/persona/customProviders/chat keys

config validate flagged first-class model-bearing keys as unknown."
git push origin main
```

---

## Phase 1 — Pillar A: one canonical provider→model picker

### Task 1.1: Create `tui/model_pick.mjs` by hoisting the dispatcher helpers

Move these from `tui/slash_dispatcher.mjs` into `tui/model_pick.mjs` **unchanged** first (pure cut/paste + export), then generalize in 1.2: `_providerLookup` (:163), `_pickProviderDrillIn` (:171), `_infoFor` (:387), `_isCompositeProvider` (:394), `_hasRealModels` (:401), `_buildModelItems` (:409), `_pickModelLoop` (:445), `_pickProviderForModel` (:496). Their imports (`providerFamilies`, `providerTag`, `supportsLiveFetch`, `fetchModelsForProvider`) move too.

**Files:**
- Create: `tui/model_pick.mjs`
- Modify: `tui/slash_dispatcher.mjs` (import the hoisted helpers instead of defining them)
- Test: `tests/p4-model-pick.test.mjs` (**NEW**)

- [ ] **Step 1: Write the failing test** (drives the new module + export)

```js
// tests/p4-model-pick.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickProviderModel, buildModelItems } from '../tui/model_pick.mjs';
import * as registry from '../providers/registry.mjs';

// Scripted modal: each call returns the next queued answer. `openPicker`
// resolves to an id (plain row), {id,query} (freeText), or null (cancel).
function mkCtx(answers, { prov = 'anthropic', model = '' } = {}) {
  const q = [...answers];
  let activeProv = prov, activeModel = model;
  return {
    getActiveProvName: () => activeProv,
    getActiveModel: () => activeModel,
    setActiveProvName: (p) => { activeProv = p; },
    setActiveModel: (m) => { activeModel = m; },
    resolveAuthKey: () => '',
    cfg: {},
    openPicker: async () => (q.length ? q.shift() : null),
  };
}

test('buildModelItems carries a custom-id freeText row + switch-provider row', () => {
  const items = buildModelItems(registry.PROVIDER_INFO['anthropic'], 'anthropic', []);
  assert.ok(items.some((i) => i.id === '__custom_model__' && i.freeText));
  assert.ok(items.some((i) => i.id === '__switch_provider__'));
});

test('pickProviderModel returns the picked model for the active provider', async () => {
  const ctx = mkCtx(['claude-opus-4-8']);
  const r = await pickProviderModel(ctx, registry, {});
  assert.deepEqual(r, { provider: 'anthropic', model: 'claude-opus-4-8' });
});

test('pickProviderModel resolves a custom id from the freeText row', async () => {
  const ctx = mkCtx([{ id: '__custom_model__', query: 'my-tuned-model' }]);
  const r = await pickProviderModel(ctx, registry, {});
  assert.equal(r.model, 'my-tuned-model');
});

test('pickProviderModel returns null on cancel', async () => {
  const ctx = mkCtx([null]);
  assert.equal(await pickProviderModel(ctx, registry, {}), null);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test tests/p4-model-pick.test.mjs`
Expected: FAIL — `tui/model_pick.mjs` does not exist.

- [ ] **Step 3: Create the module with the hoisted helpers + the new entry point**

```js
// tui/model_pick.mjs — the single canonical provider→model picker for the
// Ink REPL. Hoisted out of slash_dispatcher.mjs so /model, /provider,
// /trainer, /orchestrator and /agent all pick a model the same way. Reuses
// ctx.openPicker (the host modal) and the freeText custom-id mechanism.

import { providerFamilies, providerTag } from './provider_families.mjs';
import { supportsLiveFetch, fetchModelsForProvider } from '../providers/model_catalogue.mjs';

export function providerLookup(registry, name) { /* moved from :163 */ }
export function infoFor(registry, provName) { /* moved from :387 */ }
export function isCompositeProvider(info, provName) { /* moved from :394 */ }
export function hasRealModels(info, provName) { /* moved from :401 */ }
export async function pickProviderDrillIn(ctx, registry) { /* moved from :171 */ }
export async function pickProviderForModel(ctx, registry, subtitle, exclude = []) { /* moved from :496, honoring `exclude` */ }

// `opts` (all optional):
//   includeSwitch  — show "⇄ pick a different provider" (default true)
//   includeAuto    — add an "auto" provider row (trainer; returns {provider:'auto', model:''})
//   includeDefault — add a "▷ provider's own default model" row (returns model:'')
//   exclude        — provider ids to hide
//   startProvider  — begin at this provider (skip the active-provider seed)
export function buildModelItems(info, provName, dynamicModels, opts = {}) { /* generalized :409 — add __default__ when opts.includeDefault */ }
async function pickModelLoop(ctx, registry, provName, opts = {}) { /* generalized :445 */ }

export async function pickProviderModel(ctx, registry, opts = {}) {
  const includeSwitch = opts.includeSwitch !== false;
  let provName = opts.startProvider || ctx.getActiveProvName();
  let info = infoFor(registry, provName);
  let switched = !!opts.startProvider;

  // composite/model-less active provider → pick a provider first
  if (isCompositeProvider(info, provName) || !hasRealModels(info, provName) || opts.includeAuto) {
    const picked = await pickProviderForModel(ctx, registry, opts.title, opts.exclude || []);
    if (picked == null) return null;
    if (picked === '__auto__') return { provider: 'auto', model: '' };
    if (picked !== provName) { provName = picked; switched = true; info = infoFor(registry, provName); }
  }

  for (let guard = 0; guard < 25; guard++) {
    const model = await pickModelLoop(ctx, registry, provName, opts);
    if (model === '__switch_provider__') {
      if (!includeSwitch) break;
      const np = await pickProviderForModel(ctx, registry, `current: ${provName} — pick a provider`, opts.exclude || []);
      if (!np || np === '__auto__') continue;
      if (np !== provName) { provName = np; switched = true; info = infoFor(registry, provName); }
      continue;
    }
    if (model == null) return null;
    return { provider: provName, model };
  }
  return null;
}
```

Fill each `/* moved */` body with the exact code from the cited dispatcher lines. `pickProviderForModel` gains an `exclude` param applied to its provider filter; `buildModelItems`/`pickModelLoop` gain `opts` to add the `__default__` / `__auto__` rows when requested (default off → identical to today). `includeAuto` adds an `{ id: '__auto__', label: 'auto — trainer picks (claude-cli on Pro/Max, else chat)' }` row inside `pickProviderForModel`.

- [ ] **Step 4: Re-point the dispatcher at the hoisted helpers**

In `tui/slash_dispatcher.mjs`, delete the moved function bodies and add:
```js
import { pickProviderModel, pickProviderDrillIn, pickProviderForModel, buildModelItems, infoFor, providerLookup, isCompositeProvider, hasRealModels } from './model_pick.mjs';
```
Update internal call sites (`_pickProviderDrillIn` → `pickProviderDrillIn`, `_infoFor` → `infoFor`, `_providerLookup` → `providerLookup`, etc.). Leave `_provider`/`_model` handler logic in place for now (1.3 migrates them).

- [ ] **Step 5: Run the new test + the existing dispatcher suite**

Run: `node --test tests/p4-model-pick.test.mjs tests/v54-slash-dispatcher.test.mjs tests/p1-model-dispatch.test.mjs tests/p3-model-switch.test.mjs`
Expected: PASS (no behavior change yet — pure hoist).

- [ ] **Step 6: Commit + push**

```bash
git add tui/model_pick.mjs tui/slash_dispatcher.mjs tests/p4-model-pick.test.mjs
git commit -m "refactor(tui): hoist canonical model picker into tui/model_pick.mjs

Extract the provider->model drill-in + model loop + custom-id row out of
slash_dispatcher.mjs and expose pickProviderModel(ctx, registry, opts) as
the single picker the other commands will share. No behavior change."
git push origin main
```

### Task 1.2: Migrate `/model` and `/provider` onto `pickProviderModel`

**Files:**
- Modify: `tui/slash_dispatcher.mjs` `_model` (:515), `_provider` (:343)
- Test: existing `tests/p1-model-dispatch.test.mjs`, `tests/p3-model-switch.test.mjs` must still pass.

- [ ] **Step 1: Replace the inline loop in `_model` no-arg branch**

In `_model` (slash_dispatcher.mjs:517-566), replace the hand-rolled provider/model loop with:
```js
const r = await pickProviderModel(ctx, registry, { includeSwitch: true });
if (!r) return 'cancelled';
const switched = r.provider !== ctx.getActiveProvName();
if (switched) {
  const next = providerLookup(registry, r.provider);
  if (next) { ctx.setActiveProvName?.(r.provider); ctx.setProv?.(next); }
}
ctx.setActiveModel?.(r.model);
return switched ? `provider → ${r.provider} · model → ${r.model}` : `model → ${r.model}`;
```
Keep the typed-arg branch (`parseSlashProviderModel`, :569-581) unchanged. **Persistence stays session-only — do not add a config write (D2).**

- [ ] **Step 2: Point `_provider`'s post-pick model chain at the shared picker**

`_provider` already calls `pickAndSetModel` (orchestrator_flow) after a drill-in. That call is migrated in 1.4; leave it for now.

- [ ] **Step 3: Run** `node --test tests/p1-model-dispatch.test.mjs tests/p3-model-switch.test.mjs` → PASS.

- [ ] **Step 4: Commit + push**

```bash
git add tui/slash_dispatcher.mjs
git commit -m "refactor(tui): /model uses the shared pickProviderModel"
git push origin main
```

### Task 1.3: Add the picker to `/trainer set` and `/trainer fallback`

**Files:**
- Modify: `tui/slash_dispatcher.mjs` `_trainer` (:1357 `set`, :1397 `fallback`)
- Test: `tests/p3-trainer-fallback.test.mjs` (extend) + `tests/p4-trainer-pick.test.mjs` (**NEW**)

- [ ] **Step 1: Write the failing test**

```js
// tests/p4-trainer-pick.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';

function tmpCfgDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lc-trainer-')); }

test('/trainer set with no spec opens the picker and persists the choice', async () => {
  const cfgDir = tmpCfgDir();
  const ctx = {
    cfgDir, cfg: {},
    getActiveProvName: () => 'anthropic', getActiveModel: () => '',
    resolveAuthKey: () => '',
    // scripted: pick provider 'anthropic', then model 'claude-opus-4-8'
    openPicker: (() => { const q = ['anthropic', 'claude-opus-4-8']; return async () => (q.length ? q.shift() : null); })(),
  };
  const out = await dispatchSlash('/trainer', 'set', ctx, () => {});
  const disk = JSON.parse(fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf8'));
  assert.equal(disk.trainer.provider, 'anthropic');
  assert.equal(disk.trainer.model, 'claude-opus-4-8');
  assert.match(out, /trainer → anthropic:claude-opus-4-8/);
});
```

> Confirm `dispatchSlash(cmd, args, ctx, write)` signature against `slash_dispatcher.mjs:1805` before finalizing the call.

- [ ] **Step 2: Run it, verify it fails**

Run: `node --test tests/p4-trainer-pick.test.mjs`
Expected: FAIL — `/trainer set` with no spec currently returns the usage string.

- [ ] **Step 3: Branch `_trainer` `set` to the picker when no spec + modal available**

At the top of the `sub === 'set'` block (after reading `tokens`), before the `if (!spec) return usage`:
```js
if (!spec && typeof ctx.openPicker === 'function') {
  const r = await pickProviderModel(ctx, registry, { includeAuto: true });
  if (!r) return 'trainer set: cancelled';
  // reuse the existing read-merge-write below by synthesizing the spec
  tokens[1] = r.provider === 'auto' ? 'auto' : (r.model ? `${r.provider}:${r.model}` : r.provider);
}
const spec = tokens[1]; // (move the existing `const spec` down to here)
```
The existing parse + validate + disk read-merge-write path then runs unchanged. Apply the same pattern to the `fallback` block (`includeAuto: true`).

- [ ] **Step 4: Run** `node --test tests/p4-trainer-pick.test.mjs tests/p3-trainer-fallback.test.mjs` → PASS.

- [ ] **Step 5: Commit + push**

```bash
git add tui/slash_dispatcher.mjs tests/p4-trainer-pick.test.mjs
git commit -m "feat(tui): /trainer set|fallback open the shared model picker

No-spec /trainer set now drills provider->model (with an 'auto' row) instead
of requiring a hand-typed provider:model spec; persistence path unchanged."
git push origin main
```

### Task 1.4: Migrate `/orchestrator` + delete the twin; align `/provider` chain

**Files:**
- Modify: `tui/orchestrator_flow.mjs` (delete `pickModelForProvider` :14, rewrite `pickProviderModelSpec` :47, rewrite `pickAndSetModel` :112)
- Modify: `tui/slash_dispatcher.mjs` `_provider` (it imports `pickAndSetModel`)
- Test: `tests/f-orchestrator-flow.test.mjs` (extend)

- [ ] **Step 1: Rewrite `pickProviderModelSpec` to wrap the canonical picker**

```js
import { pickProviderModel } from './model_pick.mjs';

async function pickProviderModelSpec(ctx, registry, title) {
  const r = await pickProviderModel(ctx, registry, {
    title, exclude: ['orchestrator', 'mock'], includeDefault: true, includeSwitch: false,
  });
  if (!r) return null;
  return r.model ? `${r.provider}:${r.model}` : r.provider;
}
```

- [ ] **Step 2: Rewrite `pickAndSetModel` to use the canonical picker**

```js
export async function pickAndSetModel(ctx, registry, prov) {
  const r = await pickProviderModel(ctx, registry, { startProvider: prov, includeDefault: true, includeSwitch: false });
  if (!r) return null;
  const m = r.model || null;
  if (ctx.setActiveModel) ctx.setActiveModel(m);
  try {
    const c = (ctx.readConfig || _readConfig)();
    if (m) c.model = m; else delete c.model;
    (ctx.writeConfig || _writeConfig)(c);
    if (ctx.cfg) { if (m) ctx.cfg.model = m; else delete ctx.cfg.model; }
  } catch (_) { /* best-effort */ }
  return m ? `model → ${m}` : 'model → (default)';
}
```

- [ ] **Step 3: Delete `pickModelForProvider`** (now unused) and its now-orphan imports if no other reference remains (grep first: `grep -rn pickModelForProvider tui/ commands/`).

- [ ] **Step 4: Run** `node --test tests/f-orchestrator-flow.test.mjs tests/f-orchestrator-config.test.mjs tests/phaseH-orchestrator-concurrency.test.mjs` → PASS. Fix any test that imported `pickModelForProvider` directly by pointing it at `pickProviderModel`.

- [ ] **Step 5: Commit + push**

```bash
git add tui/orchestrator_flow.mjs tui/slash_dispatcher.mjs tests/
git commit -m "refactor(tui): orchestrator + /provider chain use the canonical picker

Delete the parallel pickModelForProvider; pickProviderModelSpec and
pickAndSetModel now drill through pickProviderModel so orchestrator inherits
the family grouping + custom-id row. One picker implementation remains."
git push origin main
```

### Task 1.5: Add `/agent edit` and a provider/model pick to `/agent add`

**Files:**
- Modify: `tui/slash_dispatcher.mjs` `_agent` (:746 — `add` at :773, add a new `edit` branch)
- Test: `tests/p4-agent-pick.test.mjs` (**NEW**)

- [ ] **Step 1: Write the failing test**

```js
// tests/p4-agent-pick.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
import { dispatchSlash } from '../tui/slash_dispatcher.mjs';
import { getAgent } from '../agents.mjs';

test('/agent edit <name> picks provider+model and patches the record', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-agent-'));
  await dispatchSlash('/agent', 'add scout researcher', { cfgDir, cfg: {} }, () => {});
  const ctx = {
    cfgDir, cfg: {}, getActiveProvName: () => 'anthropic', getActiveModel: () => '',
    resolveAuthKey: () => '',
    openPicker: (() => { const q = ['anthropic', 'claude-opus-4-8']; return async () => (q.length ? q.shift() : null); })(),
  };
  const out = await dispatchSlash('/agent', 'edit scout', ctx, () => {});
  const a = getAgent('scout', cfgDir);
  assert.equal(a.provider, 'anthropic');
  assert.equal(a.model, 'claude-opus-4-8');
  assert.match(out, /scout/);
});
```

- [ ] **Step 2: Run it, verify it fails** → FAIL (no `edit` subcommand).

- [ ] **Step 3: Add the `edit` branch + offer a pick on `add`**

In `_agent`, after the `add` branch, add:
```js
if (sub === 'edit') {
  if (!aname) return 'usage: /agent edit <name>';
  const existing = agentsMod.getAgent(aname, ctx.cfgDir);
  if (!existing) return `no agent "${aname}"`;
  if (typeof ctx.openPicker !== 'function') return 'agent edit: picker unavailable in this session';
  const registry = await import('../providers/registry.mjs');
  const r = await pickProviderModel(ctx, registry, { includeDefault: true });
  if (!r) return 'agent edit: cancelled';
  const patched = agentsMod.patchAgent(aname, { provider: r.provider, model: r.model || '' }, ctx.cfgDir);
  return `✓ ${patched.name} → ${patched.provider}${patched.model ? '/' + patched.model : ''}`;
}
```
Add `/agent edit` to the `add` usage hints and the `sub === 'list'`/help text as appropriate.

- [ ] **Step 4: Run** `node --test tests/p4-agent-pick.test.mjs` → PASS. Also run the existing agent dispatcher tests (`grep -l "'/agent'" tests/*.mjs`).

- [ ] **Step 5: Commit + push**

```bash
git add tui/slash_dispatcher.mjs tests/p4-agent-pick.test.mjs
git commit -m "feat(tui): /agent edit picks provider+model via the shared picker

Agents could only get a provider/model via CLI --flags; in-chat /agent had
no way to set them. /agent edit <name> now drills the canonical picker and
patches the record."
git push origin main
```

---

## Phase 2 — Pillar B: slash-argument completion (modal reuse)

### Task 2.1: `fillArgToken` editor primitive

**Files:**
- Modify: `tui/editor_keys.mjs` (after `fillSlashCommand` :174)
- Test: `tests/p4-fill-arg-token.test.mjs` (**NEW**)

- [ ] **Step 1: Write the failing test**

```js
// tests/p4-fill-arg-token.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEditorState, fillArgToken } from '../tui/editor_keys.mjs';

function buf(s) { return { ...makeEditorState({}), buffer: s, cursor: s.length }; }

test('fillArgToken replaces the partial token after the command', () => {
  const next = fillArgToken(buf('/model gpt'), 'gpt-4.1');
  assert.equal(next.buffer, '/model gpt-4.1');
  assert.equal(next.cursor, next.buffer.length);
});

test('fillArgToken appends when the arg token is empty', () => {
  const next = fillArgToken(buf('/model '), 'claude-opus-4-8');
  assert.equal(next.buffer, '/model claude-opus-4-8');
});

test('fillArgToken replaces only the last token (multi-word args)', () => {
  const next = fillArgToken(buf('/trainer set anth'), 'anthropic:claude-opus-4-8');
  assert.equal(next.buffer, '/trainer set anthropic:claude-opus-4-8');
});
```

- [ ] **Step 2: Run it, verify it fails** → FAIL (`fillArgToken` undefined).

- [ ] **Step 3: Implement**

```js
// Replace the whitespace-delimited token that ENDS at the cursor with
// `value`. Used by the arg-completion flow: the user types `/model gpt`,
// picks `gpt-4.1` from the modal, and the partial token is swapped in place.
// Does NOT submit. Leaves the cursor at the end of the inserted value.
export function fillArgToken(state, value) {
  const buffer = state.buffer;
  const start = buffer.lastIndexOf(' ') + 1; // char after the last space
  const filled = buffer.slice(0, start) + value;
  return { ...state, buffer: filled, cursor: filled.length, lastSubmit: null, lastWasPaste: false };
}
```

- [ ] **Step 4: Run test, verify PASS** → PASS.

- [ ] **Step 5: Commit + push**

```bash
git add tui/editor_keys.mjs tests/p4-fill-arg-token.test.mjs
git commit -m "feat(tui): add fillArgToken editor primitive for arg completion"
git push origin main
```

### Task 2.2: `tui/slash_args.mjs` — arg spec + completers

**Files:**
- Create: `tui/slash_args.mjs`
- Modify: `tui/slash_commands.mjs` (add `arg` data)
- Test: `tests/p4-slash-args.test.mjs` (**NEW**)

- [ ] **Step 1: Add `arg` markers to the catalog**

In `tui/slash_commands.mjs`, add an `arg` field (pure data — a string key only) to:
```js
{ cmd: '/provider', help: '…', arg: { name: 'provider', completer: 'provider' } },
{ cmd: '/model',    help: '…', arg: { name: 'model',    completer: 'model' } },
{ cmd: '/trainer',  help: '…', arg: { name: 'spec', completer: 'trainerSpec', after: ['set', 'fallback'] } },
{ cmd: '/orchestrator', help: '…', arg: { name: 'spec', completer: 'orchestratorSpec', after: ['planner', 'worker'] } },
{ cmd: '/agent',    help: '…', arg: { name: 'name', completer: 'agentName', after: ['edit', 'show', 'remove'] } },
```
`after` (optional) = the subcommand token(s) that must precede the completable arg.

- [ ] **Step 2: Write the failing test**

```js
// tests/p4-slash-args.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { argSpecFor } from '../tui/slash_args.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';

test('argSpecFor matches /model arg position', () => {
  const s = argSpecFor('/model gpt', SLASH_COMMANDS);
  assert.equal(s.completer, 'model');
  assert.equal(s.partial, 'gpt');
});

test('argSpecFor requires the subcommand for /trainer', () => {
  assert.equal(argSpecFor('/trainer sh', SLASH_COMMANDS), null);      // typing the subcommand, not the spec
  const s = argSpecFor('/trainer set anth', SLASH_COMMANDS);
  assert.equal(s.completer, 'trainerSpec');
  assert.equal(s.partial, 'anth');
});

test('argSpecFor returns null for a command with no arg spec', () => {
  assert.equal(argSpecFor('/help foo', SLASH_COMMANDS), null);
});
```

- [ ] **Step 3: Run it, verify it fails** → FAIL (module missing).

- [ ] **Step 4: Implement `argSpecFor` + `ARG_COMPLETERS`**

```js
// tui/slash_args.mjs — slash-command argument completion. argSpecFor() is
// PURE (catalog data only) so the REPL can decide whether the value being
// typed after a command is completable. ARG_COMPLETERS run the actual pick
// (they may call pickProviderModel / openPicker) and return the string to
// fill into the buffer, or null on cancel.

import { pickProviderModel } from './model_pick.mjs';

// Resolve which completer (if any) applies to `buffer`. Returns
// { cmd, name, completer, partial } or null.
export function argSpecFor(buffer, catalog) {
  if (!buffer || !buffer.startsWith('/')) return null;
  const sp = buffer.indexOf(' ');
  if (sp < 0) return null;                       // still typing the command
  const cmd = buffer.slice(0, sp);
  const entry = (catalog || []).find((c) => c.cmd === cmd);
  if (!entry || !entry.arg) return null;
  const rest = buffer.slice(sp + 1);
  const tokens = rest.split(/\s+/);
  const partial = tokens[tokens.length - 1];
  if (Array.isArray(entry.arg.after)) {
    // the value is completable only once a required subcommand is present
    // AND the user is past it (typing token >= 2)
    const sub = tokens[0];
    if (!entry.arg.after.includes(sub) || tokens.length < 2) return null;
  }
  return { cmd, name: entry.arg.name, completer: entry.arg.completer, partial };
}

export const ARG_COMPLETERS = {
  async model(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, { includeSwitch: true });
    if (!r) return null;
    return r.provider === ctx.getActiveProvName() ? r.model : `${r.provider}/${r.model}`;
  },
  async provider(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, { includeSwitch: true });
    return r ? r.provider : null;
  },
  async trainerSpec(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, { includeAuto: true });
    if (!r) return null;
    return r.provider === 'auto' ? 'auto' : (r.model ? `${r.provider}:${r.model}` : r.provider);
  },
  async orchestratorSpec(ctx, registry) {
    const r = await pickProviderModel(ctx, registry, { exclude: ['orchestrator', 'mock'], includeDefault: true, includeSwitch: false });
    if (!r) return null;
    return r.model ? `${r.provider}:${r.model}` : r.provider;
  },
  async agentName(ctx, registry, agentsMod) {
    if (typeof ctx.openPicker !== 'function') return null;
    const names = (agentsMod ? agentsMod.listAgents(ctx.cfgDir) : []).map((a) => a.name);
    if (!names.length) return null;
    const picked = await ctx.openPicker({ kind: 'menu', title: 'agent', items: names.map((n) => ({ id: n, label: n })) });
    return picked && typeof picked === 'object' ? picked.id : (picked || null);
  },
};

// Run the completer named by `spec.completer`. Returns the fill string or null.
export async function runArgCompleter(spec, ctx, registry, agentsMod) {
  const fn = ARG_COMPLETERS[spec.completer];
  if (!fn) return null;
  return fn(ctx, registry, agentsMod);
}
```

- [ ] **Step 5: Run** `node --test tests/p4-slash-args.test.mjs` → PASS.

- [ ] **Step 6: Commit + push**

```bash
git add tui/slash_args.mjs tui/slash_commands.mjs tests/p4-slash-args.test.mjs
git commit -m "feat(tui): slash-argument completion registry (argSpecFor + ARG_COMPLETERS)"
git push origin main
```

### Task 2.3: `openPicker` query seeding

**Files:**
- Modify: `tui/repl.mjs:435-448` (`openPicker`), `:437-438` (init state)
- Test: covered by 2.5 integration; add a focused render check.

- [ ] **Step 1: Seed the modal filter from `opts.query`**

In `openPicker`, change `setModalQuery('')` → `setModalQuery(typeof opts.query === 'string' ? opts.query : '')` and store nothing else new. This lets `ARG_COMPLETERS` pass the partial so the modal opens pre-filtered.

> Note: the current pickers don't pass `query`, so default stays `''` — no regression. Wire `opts.query` through `ARG_COMPLETERS` later only if desired; the partial is already in the buffer, so seeding is a nicety, not required for correctness.

- [ ] **Step 2: Commit + push**

```bash
git add tui/repl.mjs
git commit -m "feat(tui): openPicker honors opts.query to pre-seed the modal filter"
git push origin main
```

### Task 2.4: Editor Tab-in-arg trigger + buffer inject

**Files:**
- Modify: `tui/editor.mjs` (props :108-140, key handler :230-290, new inject effect)
- Test: `tests/p4-editor-arg-complete.test.mjs` (**NEW**)

- [ ] **Step 1: Write the failing test** (renders `<Editor/>` directly with a mock `onArgComplete`)

```js
// tests/p4-editor-arg-complete.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { Editor } from '../tui/editor.mjs';

function mkStdio() {
  const stdout = new PassThrough(); stdout.columns = 80; stdout.rows = 24;
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
  return { stdin, stdout, stderr: new PassThrough() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Tab in arg position calls onArgComplete with the buffer', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let seen = null;
  const inst = render(React.createElement(Editor, {
    history: [], onSubmit: () => {}, onBufferChange: () => {},
    argCompletable: true,
    onArgComplete: (buf) => { seen = buf; },
  }), { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false });
  try {
    stdin.write('/model gpt');
    await sleep(60);
    stdin.write('\t');
    for (let i = 0; i < 20 && seen === null; i++) await sleep(20);
    assert.equal(seen, '/model gpt');
  } finally { try { inst.unmount(); } catch {} try { inst.cleanup(); } catch {} }
});
```

- [ ] **Step 2: Run it, verify it fails** → FAIL (`onArgComplete` not wired).

- [ ] **Step 3: Add props + Tab branch + inject effect**

Add to the `Editor({...})` destructure (after the modal props):
```js
  argCompletable,        // boolean — current buffer has a completable arg
  onArgComplete,         // (buffer: string) => void — host opens the picker
  argInject,             // { value: string, nonce: number } | null — host pushes the chosen value
```
After the `slashOpen` block and before the final `applyKey`, add:
```js
    // Arg completion: Tab while typing a command's value opens the host
    // picker (modal). Only when the slash popup is closed (args present).
    if (!slashOpen && key.tab && argCompletable && onArgComplete) {
      onArgComplete(stateRef.current.buffer);
      return;
    }
```
Add an inject effect near the other effects:
```js
  const injectNonceRef = useRef(0);
  useEffect(() => {
    if (argInject && argInject.nonce !== injectNonceRef.current && typeof argInject.value === 'string') {
      injectNonceRef.current = argInject.nonce;
      const next = fillArgToken(stateRef.current, argInject.value);
      commit(next);
      if (onBufferChange) { try { onBufferChange(next.buffer); } catch {} }
    }
  }, [argInject]);
```
Import `fillArgToken` from `./editor_keys.mjs` at the top of `editor.mjs`.

- [ ] **Step 4: Run test, verify PASS** → PASS.

- [ ] **Step 5: Commit + push**

```bash
git add tui/editor.mjs tests/p4-editor-arg-complete.test.mjs
git commit -m "feat(tui): Editor Tab opens arg completion + injects the picked value"
git push origin main
```

### Task 2.5: Wire ReplApp + chat.mjs end-to-end

**Files:**
- Modify: `tui/repl.mjs` (arg-spec memo, hint render past the space-guard, Editor props, `handleArgComplete`, `argInject` state)
- Modify: `commands/chat.mjs` (build `onArgComplete` from the dispatch ctx, pass to `ReplApp`)
- Test: `tests/p4-arg-complete-e2e.test.mjs` (**NEW**)

- [ ] **Step 1: ReplApp — compute arg spec + render hint + wire Editor**

After the slash-popup `filtered` memo (repl.mjs:~371), add:
```js
const argSpec = useMemo(() => argSpecFor(bufferPeek, catalog), [bufferPeek, catalog]);
const argCompletable = !!argSpec && typeof onArgComplete === 'function';
const [argInject, setArgInject] = useState(null);
const argNonceRef = useRef(0);
const handleArgComplete = useCallback(async (buf) => {
  if (typeof onArgComplete !== 'function') return;
  const value = await onArgComplete(buf);              // opens openPicker internally
  if (typeof value === 'string' && value) {
    argNonceRef.current += 1;
    setArgInject({ value, nonce: argNonceRef.current });
  }
}, [onArgComplete]);
```
Add `onArgComplete` to ReplApp's props. Pass to the `<Editor/>`: `argCompletable`, `onArgComplete: handleArgComplete`, `argInject`.

Show the arg hint past the space-guard: when `!showSlashPopup && argSpec && !modalOpen`, render a one-line dimmed hint (`↹ pick ${argSpec.name}`) in the same slot as the slash popup. Reuse `SlashPopup`'s inline-hint render or a small inline `Text`:
```js
(!showSlashPopup && argSpec && !modalOpen)
  ? React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { dimColor: true }, `↹ pick ${argSpec.name}`))
  : null,
```

- [ ] **Step 2: chat.mjs — build and pass `onArgComplete`**

> Read the Ink mount in `commands/chat.mjs` (where `ReplApp` is rendered and the dispatch ctx `_inkCtx` is assembled with `openPicker`/`setActiveModel`/etc.). Build:
```js
import { argSpecFor, runArgCompleter } from '../tui/slash_args.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';
// ... where _inkCtx (with openPicker, getActiveProvName, cfg, resolveAuthKey…) exists:
const _registryMod = await import('../providers/registry.mjs');
const _agentsMod = await import('../agents.mjs');
const onArgComplete = async (buffer) => {
  const spec = argSpecFor(buffer, SLASH_COMMANDS);
  if (!spec) return null;
  return runArgCompleter(spec, _inkCtx, _registryMod, _agentsMod);
};
```
Pass `onArgComplete` as a prop to `ReplApp`. (The `_inkCtx.openPicker` is the same `pickerRef`-injected modal ReplApp owns, so the picker renders correctly.)

- [ ] **Step 3: Write the e2e test**

```js
// tests/p4-arg-complete-e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { ReplApp } from '../tui/repl.mjs';
import { SLASH_COMMANDS } from '../tui/slash_commands.mjs';

function mkStdio() {
  const stdout = new PassThrough(); stdout.columns = 80; stdout.rows = 24;
  const stdin = new PassThrough(); stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.setEncoding = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
  return { stdin, stdout, stderr: new PassThrough() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Tab after /model fills the value the host returns', async () => {
  const { stdin, stdout, stderr } = mkStdio();
  let submitted = null;
  const inst = render(React.createElement(ReplApp, {
    splashProps: { provider: 'mock', model: 'm', version: '6.x', cwd: '/tmp', tools: [], skills: [] },
    slashCommands: SLASH_COMMANDS,
    onSlashCommand: async (line) => { submitted = line; return 'ok'; },
    onArgComplete: async (buf) => (buf.startsWith('/model') ? 'gpt-4.1' : null),
    runTurnFactory: () => async () => {},
  }), { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false });
  try {
    stdin.write('/model gpt');
    await sleep(60);
    stdin.write('\t');                 // arg-complete → buffer becomes "/model gpt-4.1"
    await sleep(80);
    stdin.write('\r');                 // submit
    for (let i = 0; i < 30 && submitted === null; i++) await sleep(25);
    assert.equal(submitted, '/model gpt-4.1');
  } finally { try { inst.unmount(); } catch {} try { inst.cleanup(); } catch {} }
});
```

- [ ] **Step 4: Run** `node --test tests/p4-arg-complete-e2e.test.mjs tests/f-slash-args.test.mjs tests/v53-slash-popup.test.mjs` → PASS. The space-guard change must NOT break `f-slash-args` (args still submit) — the hint is non-interactive, Enter still submits the full line.

- [ ] **Step 5: Commit + push**

```bash
git add tui/repl.mjs commands/chat.mjs tests/p4-arg-complete-e2e.test.mjs
git commit -m "feat(tui): wire slash-arg completion end-to-end (Tab opens modal, fills value)

A command with an arg completer keeps a '↹ pick <arg>' hint after the space;
Tab opens the shared modal picker and injects the choice into the buffer."
git push origin main
```

---

## Phase 3 — Docs + full verification

### Task 3.1: Update CHANGELOG + README

**Files:** `CHANGELOG.md`, `README.md` (+ `README.ko.md` if present)

- [ ] **Step 1: CHANGELOG** — add an `### Added` / `### Fixed` block (Keep a Changelog format): `/trainer set|fallback` and `/agent edit` now open the model picker; Tab autocompletes the value after `/model`,`/provider`,`/trainer`,`/orchestrator`,`/agent`; default models bumped; `config validate` recognizes `trainer`/`orchestrator`/etc.

- [ ] **Step 2: README** — document `/agent edit`, the picker on `/trainer`, and Tab arg-completion in the slash-command section.

- [ ] **Step 3: Commit + push**

```bash
git add CHANGELOG.md README*.md
git commit -m "docs: model picker unification + arg completion (changelog, readme)"
git push origin main
```

### Task 3.2: Full suite + manual smoke

- [ ] **Step 1: Run the whole test suite**

Run: `node --test tests/*.test.mjs` (or the repo's `npm test`).
Expected: all green. Fix any regression before proceeding.

- [ ] **Step 2: Manual smoke (use the `run` skill or launch the TUI)**

Verify by hand: `/trainer set` → drill picker; `/agent edit scout` → drill picker; type `/model gpt` + Tab → modal opens, pick fills buffer; `/orchestrator` → planner pick still works.

- [ ] **Step 3: Final push** — ensure `main` is green and pushed.

---

## Self-Review (completed during planning)

- **Spec coverage:** D1 (canonical extraction) → Tasks 1.1–1.5. D2 (persistence unchanged) → 1.2 explicitly keeps `/model` session-only. D3 (modal reuse) → 2.3–2.5. D4 (bundled fixes) → Phase 0. D5 (completers in `slash_args.mjs`, not `slash_commands.mjs`) → 2.2.
- **Symbols:** `pickProviderModel`, `buildModelItems`, `pickProviderForModel`, `argSpecFor`, `runArgCompleter`, `ARG_COMPLETERS`, `fillArgToken`, `argCompletable`/`onArgComplete`/`argInject` are each defined in a task before first use.
- **Type consistency:** `pickProviderModel` returns `{provider, model}|null` everywhere; completers return `string|null`; `argSpecFor` returns `{cmd,name,completer,partial}|null`.
- **Risks:** the `_trainer` `set` edit shadows the existing `const spec` — Task 1.3 Step 3 moves that declaration; verify no double-declaration lint error. `chat.mjs` wiring (2.5 Step 2) requires reading the exact Ink mount; that is an explicit read step, not a placeholder.
