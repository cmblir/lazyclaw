# Unified Model Picker + Slash-Argument Completion — Design

Date: 2026-06-15
Status: Approved for planning
Repo: `/Users/o/lazyclaw`

## 1. Problem & Goals

Today only `/model` (and `/provider`) give the user an interactive provider→model
picker with a "type a custom id" row. Other model-setting commands make the user
hand-type a `provider:model` spec (`/trainer set`), silently default
(`/agent add` → `claude-cli`), or use a divergent flat menu (`/orchestrator`).
There are **three parallel model-picker implementations** that drift apart
(Ink `_pickModelLoop`, orchestrator `pickModelForProvider`, legacy readline
`_pickModelInteractive`).

Separately, the slash popup **dismisses the moment a space is typed** — so a
command's *argument* (e.g. the model id after `/model `) gets no completion at
all.

**Goals**

1. Every interactive model-setting command picks a model the same way `/model`
   does — pick from a list **and** enter a custom id.
2. When a command takes a value argument, that value autocompletes: a preview
   list the user navigates with ↑/↓ and confirms — reusing the existing modal
   picker.
3. Collapse the three picker implementations into one canonical builder.

**Non-goals**

- Shell-level completion for the non-interactive CLI (`lazyclaw agent add --model …`,
  `--provider` flags on `loop`/`cron`/`channels`). Those are headless; out of scope.
- Changing the live streaming-chat path (`run_turn.mjs`) — it already inherits the
  active model.
- A config override for `mas/tools/media.mjs` hardcoded image models (see §10).

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Picker unification depth | **Canonical extraction + migrate all + delete the orchestrator twin.** One `pickProviderModel()`. |
| D2 | Persistence semantics | **Keep existing behavior (surgical).** `/model`·`/provider` no-arg picks stay session-only; `/trainer`·`/orchestrator`·`/agent` keep their current persist behavior. The session-only vs persisted inconsistency is reported, not changed here. |
| D3 | Arg-completion UI | **Reuse the modal picker.** Inline hint announces; a keystroke opens `openPicker` seeded with the partial; result fills the arg token. No new inline-dropdown widget. |
| D4 | Bundled bug fixes | **Include** the stale `defaultModel` bump (`claude-opus-4-7`→`claude-opus-4-8`), the gemini fallback inconsistency, and the `KNOWN_KEYS` schema drift. `media.mjs` handled separately. |
| D5 | Completer location | Completer functions live in a **new `tui/slash_args.mjs`**, NOT in `slash_commands.mjs` (which must stay a pure-data module to avoid the documented `tui/ → cli.mjs` circular import). |

## 3. Architecture

Two pillars + one bundled cleanup. They are independent enough to land as
separate commits but share the canonical picker.

### 3.1 Pillar A — one canonical provider→model picker

New module **`tui/model_pick.mjs`** built by hoisting the existing Ink helpers
out of `slash_dispatcher.mjs` (they are already the reference implementation):

```
// tui/model_pick.mjs
export async function pickProviderModel(ctx, registry, opts = {})
//   opts: {
//     title?: string,
//     includeSwitch?: boolean,   // show "⇄ pick a different provider" (default true)
//     includeAuto?: boolean,     // show "auto (claude-cli on Pro/Max, else chat)" — trainer only
//     includeDefault?: boolean,  // show "(provider default)" row — orchestrator/agent
//     exclude?: string[],        // provider ids to hide (orchestrator: ['orchestrator','mock'])
//     startProvider?: string,    // skip the provider step if given
//   }
//   returns: { provider, model } | null   (null = user cancelled)
```

Internals = the current `_pickProviderDrillIn` (slash_dispatcher.mjs:171),
`_buildModelItems` (:409), `_pickModelLoop` (:445), generalized to honor
`opts`. The `⇄ switch provider` / `__custom_model__` (freeText) / live-fetch
rows are preserved. `exclude` filters the family→provider drill-in;
`includeAuto`/`includeDefault` add pinned rows ahead of the model list.

**Consumers after migration** (all in the Ink REPL path):

| Command | Call | Persist (unchanged per D2) |
|---------|------|-----------------------------|
| `/model` | `pickProviderModel(ctx, reg, {includeSwitch:true})` → `setActiveModel` | session-only (existing) |
| `/provider` | drill provider, then model via same fn | session-only (existing) |
| `/trainer set` | `pickProviderModel(ctx, reg, {includeAuto:true})` → `cfg.trainer` | writes `cfg.trainer` (existing) |
| `/trainer fallback` | same → `cfg.trainer.fallback` | writes (existing) |
| `/orchestrator planner` / `worker add` | `pickProviderModel(ctx, reg, {exclude:['orchestrator','mock'], includeDefault:true})` → spec string | writes `cfg.orchestrator` (existing) |
| `/agent add` + **new** `/agent edit <name>` | `pickProviderModel(ctx, reg, {includeDefault:true})` → agent record | writes `agents/<name>.json` |

`orchestrator_flow.mjs` `pickModelForProvider` (the twin) and
`pickProviderModelSpec`'s flat provider menu are **deleted**;
`pickProviderModelSpec` becomes a thin wrapper that calls `pickProviderModel`
and formats the result as the `provider` / `provider:model` spec string the
orchestrator config expects.

**Legacy readline pickers** (`tui/pickers.mjs`, `commands/chat.mjs` non-Ink
paths) are **left as-is** — they only run when Ink is unavailable (non-TTY /
fallback). Consolidating them is explicitly out of scope to keep the change
surgical; a code comment will point them at `model_pick.mjs` as the canonical
version.

### 3.2 Pillar B — slash-argument completion

Three small pieces:

**(a) Arg spec on the command catalog.** Extend each `SLASH_COMMANDS` entry
(`tui/slash_commands.mjs`) with an optional pure-data marker:

```js
{ cmd: '/model', help: '…', arg: { name: 'model', completer: 'model' } }
```

`completer` is a **string key**, not a function — keeps `slash_commands.mjs` a
pure-data module (D5). The string maps to a function in `tui/slash_args.mjs`:

```js
// tui/slash_args.mjs  (may import registry — outside the circular-import path)
export const ARG_COMPLETERS = {
  model:    (ctx, partial) => Promise<ModalItem[]>,   // _buildModelItems-derived
  provider: (ctx, partial) => Promise<ModalItem[]>,   // family→provider list
  agent:    (ctx, partial) => Promise<ModalItem[]>,   // existing agent names
};
export function argSpecFor(cmd, args)  // resolves which arg/completer applies,
                                       // incl. subcommands (/trainer set <model>)
```

Subcommand-aware: `/trainer` resolves to the `model` completer only after
`set`/`fallback`; `/orchestrator planner` → model completer, `worker remove` →
current-workers completer.

**(b) Editor token fill.** Add `fillArgToken(state, value)` beside
`fillSlashCommand` (`tui/editor_keys.mjs:174`) — replaces only the token under
the cursor (the partial arg), not the whole buffer.

**(c) REPL trigger.** `tui/repl.mjs` currently hides the popup once
`bufferPeek` contains a space (the `showSlashPopup` guard). Change: when the
buffer is `/<known-cmd> <partial>` **and** `argSpecFor` returns a completer,
render a one-line inline hint (`↹ pick <argName>`) instead of dismissing.
Pressing **Tab** calls `ctx.openPicker({ kind, title, items, defaultIdx, query:<partial> })`
(the existing blocking modal — ↑/↓, filter, desc-preview already built), then
applies `fillArgToken` with the chosen value. Cancel (Esc) returns to the
buffer unchanged.

This satisfies the request ("the value after the command autocompletes, ↑/↓
selectable, with preview") while reusing the modal per D3 — no new widget.

### 3.3 Bundled fixes (D4)

- **Stale defaults**: `providers/registry.mjs` `claude-cli` (:194) and
  `anthropic` (:237) `defaultModel` `claude-opus-4-7` → `claude-opus-4-8`
  (already present in their `suggestedModels`). Adapter fallbacks that hardcode
  `'claude-opus-4-7'` (`providers/anthropic.mjs:194`, `providers/tool_use/anthropic.mjs:71`)
  → `claude-opus-4-8`.
- **Gemini inconsistency**: streaming fallback `gemini-1.5-pro`
  (`providers/gemini.mjs:188`) and tool_use `gemini-2.5-flash`
  (`providers/tool_use/gemini.mjs:91`) → align to registry default
  `gemini-2.5-pro`.
- **Schema drift**: `config-validate.mjs` `KNOWN_KEYS` (:9) currently
  `{provider, model, api-key, rates}` → add `trainer, orchestrator, persona,
  customProviders, chat` so `config validate` stops flagging first-class keys as
  unknown. (Type-checking only; no provider↔model cross-validation added — that
  is a larger change, noted as a risk not undertaken.)

## 4. Components & file-level changes

| File | Change |
|------|--------|
| `tui/model_pick.mjs` | **NEW** — `pickProviderModel()` (hoisted from dispatcher). |
| `tui/slash_dispatcher.mjs` | `/model`,`/provider`,`/trainer`,`/agent` handlers call `pickProviderModel`. Remove hoisted helpers (re-export or import from `model_pick.mjs`). |
| `tui/orchestrator_flow.mjs` | Delete `pickModelForProvider` + flat menu; `pickProviderModelSpec` wraps `pickProviderModel({exclude:[…]})`. |
| `tui/slash_commands.mjs` | Add pure-data `arg:{name,completer}` to `/model`,`/provider`,`/trainer`,`/orchestrator`,`/agent`. |
| `tui/slash_args.mjs` | **NEW** — `ARG_COMPLETERS`, `argSpecFor()`. |
| `tui/editor_keys.mjs` | **NEW** `fillArgToken(state, value)`. |
| `tui/repl.mjs` | Relax space-guard; render arg-hint; Tab→`openPicker`→`fillArgToken`. |
| `tui/slash_popup.mjs` | Arg-hint render variant (or reuse existing inline-hint path at :100). |
| `providers/registry.mjs`, `providers/anthropic.mjs`, `providers/tool_use/anthropic.mjs`, `providers/gemini.mjs`, `providers/tool_use/gemini.mjs` | Default/fallback model bumps (§3.3). |
| `config-validate.mjs` | Extend `KNOWN_KEYS` (§3.3). |
| `CHANGELOG.md`, `README` | Document new `/agent edit`, `/trainer set` picker, arg completion (§4.5 of global guide). |

## 5. Data flow

**Arg completion** (`/model gpt` then Tab):
1. Editor buffer `= "/model gpt"`. `onBufferChange` → `repl.mjs` peeks buffer.
2. `argSpecFor('/model', 'gpt')` → `{name:'model', completer:'model'}`.
3. Popup renders inline hint `↹ pick model`.
4. Tab → `ARG_COMPLETERS.model(ctx, 'gpt')` builds items → `ctx.openPicker({kind:'model', items, query:'gpt'})`.
5. Modal filters live on `gpt`; ↑/↓ select; Enter resolves → `id` or `{id,query}` (custom).
6. `fillArgToken(state, picked)` → buffer `= "/model gpt-4.1"`; user presses Enter to run.

**Trainer pick** (`/trainer set`, no spec):
1. Handler calls `pickProviderModel(ctx, reg, {includeAuto:true})`.
2. User drills family→provider→model (or picks `auto`, or types custom id).
3. Returns `{provider, model}` → existing `cfg.trainer` read-merge-write.

## 6. Error handling

- `ctx.openPicker` returns `null` on cancel → handlers return a no-op message
  ("cancelled"), never mutate config. Existing pattern.
- Non-Ink REPL (`ctx.openPicker` absent) → handlers fall back to the current
  typed-spec path (e.g. `/trainer set anthropic:claude-opus-4-8`). No crash; the
  arg-completion hint simply never shows.
- Unknown provider/model typed as custom id → validated by existing
  `registry.parseProviderModel` / provider validation; bad input returns an
  error string, no write.
- Live model fetch failure inside `_buildModelItems` → existing catch keeps the
  suggested list (no regression).

## 7. Testing

- **Unit (pure):** `argSpecFor` subcommand resolution; `fillArgToken` token
  replacement (cursor mid-arg, trailing space, multi-word); `ARG_COMPLETERS`
  item shape.
- **Unit:** `pickProviderModel` opts matrix (includeSwitch/includeAuto/exclude)
  via a mock `ctx.openPicker` that scripts selections; assert returned
  `{provider,model}` and that `exclude` hides providers.
- **Integration:** each migrated handler (`/trainer set`, `/orchestrator planner`,
  `/agent add`/`edit`) with mocked picker → asserts the correct config write.
- **Regression:** `/model`/`/provider` behavior + persistence unchanged
  (session-only); legacy readline path untouched.
- Follow the repo's existing CLI test harness; per memory, use the
  `runCliAsync` pattern (no same-process mock-server + `spawnSync`).

## 8. Migration & back-compat

- Typed-spec forms keep working (`/trainer set anthropic:claude-opus-4-8`,
  `/model gpt-4.1`) — completion is additive.
- No config schema migration: `cfg.trainer`/`cfg.orchestrator`/agent records
  unchanged. `KNOWN_KEYS` widening only *reduces* false "unknown key" warnings.
- `pickProviderModelSpec` keeps its signature (wrapper) so
  `commands/setup_channels.mjs` and other callers are unaffected.

## 9. Success criteria

1. `/trainer set`, `/agent add`, `/agent edit`, `/orchestrator planner|worker`
   each open the same provider→model picker as `/model`, including the
   custom-id row.
2. Typing a value after `/model`,`/provider`,`/trainer set`,`/orchestrator`,
   `/agent` shows the arg hint; Tab opens a filtered, ↑/↓-navigable modal whose
   choice fills the token.
3. Only one provider→model picker implementation remains in the Ink path
   (`pickProviderModel`); the orchestrator twin is gone.
4. `config validate` no longer reports `trainer`/`orchestrator`/etc. as unknown;
   default models report `claude-opus-4-8` / `gemini-2.5-pro`.
5. All new + existing tests pass; `/model`·`/provider` persistence behavior
   unchanged.

## 10. Out of scope (reported, not done)

- **`mas/tools/media.mjs`** hardcodes `gpt-4o-mini` (:27) and `gpt-image-1`
  (:58) with no config key. Adding an override is a separate feature; flagged.
- **Persistence inconsistency** (`/model`·`/provider` session-only vs others
  persisted) — kept as-is per D2; documented for a future decision.
- **Provider↔model cross-validation** in `config-validate.mjs` — larger change;
  not undertaken.
- **Legacy readline picker consolidation** (`tui/pickers.mjs`) — fallback path
  left intact.
