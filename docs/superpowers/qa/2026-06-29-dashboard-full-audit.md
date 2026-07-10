# Dashboard + full-feature audit & fixes — 2026-06-29

Scope: live Playwright walk of the 18-tab dashboard + deep multi-agent code audit of
every subsystem (scheduling/goals/loops, workflow engine, terminal/REPL, chat,
providers, teams/agents/tasks), then direct fixes for confirmed breaks. Daemon run
from source at `/Users/yoo/project/lazyclaw` (`lazyclaw dashboard --port 19600`),
provider `mock`.

## Method
- Background deep-audit workflow: recon (client calls ↔ daemon routes) → per-subsystem
  bug hunt → adversarial verify. 18 findings confirmed (all adversarially re-checked).
- Live walk: all 18 tabs render with real data (0 blank); Chat send (mock reply),
  Recall FTS5 search (8 hits), Agent/Team create write-paths, Team Live SSE exercised.

## Confirmed breaks fixed (verified)

### Scheduling / goals / loops (user priority)
- **Scheduled jobs used a bare `lazyclaw`** not on launchd/cron PATH → every scheduled
  goal-tick / workflow / cron job silently never launched on Homebrew/nvm/npm-global
  installs. Fixed: `cron.resolveCommand()` rewrites a leading `lazyclaw` → absolute
  `<node> <cli.mjs>` at emit time (plist/crontab/runJob) + `EnvironmentVariables PATH`
  in the plist + `PATH=` in crontab. (`cron.mjs`, `commands/automation.mjs`,
  `workflow/named_cron.mjs`, `goals_cron.mjs` all benefit.)
- **`cron add` dropped the binary** (`-- agent "…"` stored a bare `agent`) → now
  prepends `lazyclaw` when omitted.
- **All-wildcard `* * * * *`** emitted an empty `StartCalendarInterval` dict launchd
  never fires → wildcard minute now enumerates 0..59 (60 dicts, never empty).
- **parseCronSpec rejected** dow `7`, names (`SUN`/`MON-FRI`/`JAN`), and `@daily`-style
  macros → now accepted (`@reboot` rejected with a clear message).

### Workflow engine (scheduling lifecycle)
- **`workflow remove`** left the launchd/cron job installed (OS kept firing a missing
  workflow) → now `detachWorkflowCron`.
- **Re-add without `--cron`** left the old schedule firing → now reconciles (detaches).
- **Invalid `--cron`** reported `ok:true` while installing nothing → now validated
  before persist, exits non-zero.

### Terminal / REPL
- **Typing during a streaming turn double-sent** (2–3×) the message → `handleSubmit`
  now guards on a `streamingRef`; mid-stream input only queues via the reducer.
- **`/handoff`** printed a cryptic `(none):(none)` in the REPL → clearer message.

### Chat / providers
- **Orchestrator-ON dropped the no-fabrication honesty guard** from the user-facing
  synthesis → guard now prepended to the synthesis system prompt.
- **Legacy `/orchestrator on`** reported success but never took effect → `_legacyCtx`
  now has the live-provider setters `refreshLiveProvider` needs.
- **`providers test`** (CLI + dashboard) read only legacy `cfg['api-key']` → now
  `_resolveAuthKey(cfg, provider)` per provider (env / authProfiles / custom).
- **Gemini streaming** hit `/v1` while listing used `/v1beta` (2.5-* 404) → aligned to
  `/v1beta`.

### Dashboard
- **Team Live "connecting…" hung up to 25s** (SSE headers not flushed until the first
  heartbeat/event) → `writeSseHead` now `flushHeaders()`. Verified: `/events` TTFB
  **0.0008s** (was ~25s); browser dot flips to `● live` in **~101ms**.
- **Custom agent avatars 404'd for dotted names** (`data.eng.png`) → route + handler
  regex widened to allow dots (extension whitelisted, `..` still blocked). Regression
  test added.
- **Team-create exposed raw JSON + internal code** (`TEAM_BAD_AGENT`) in a native
  `alert()` and was a chicken-and-egg (needs agents first). Fixed: `api()` surfaces
  only the server's human `error` string (never the JSON envelope/code); `openTeamModal`
  bails early with a clear "create an agent first" hint and pre-fills registered names.

## 3-viewport verification (dashboard.js changed)
| Viewport | Horizontal overflow | Console errors | Visual |
|---|---|---|---|
| 1280×800 | none | 0 | pass (`fix-verify-1280.png`) |
| 768×800  | none (scrollWidth=clientWidth) | 0 | pass (`fix-verify-768.png`) |
| 375×667  | none (incl. Providers tab) | 0 | pass (`fix-verify-375.png`) |

Result: **PASS** at all three. Nav wraps gracefully; cards/badges/Test buttons intact.

## Gates
- `node --test tests/*.test.mjs` → **1441 pass / 0 fail** (incl. new dotted-avatar test).
- `scripts/lint-file-size.mjs` → OK (added lines offset by condensing comments; no
  ceiling raised).
- `scripts/check-pack.mjs` → OK.

## Deferred (documented, not fixed)
- **No dashboard routes for cron/goals/loops** — scheduling is CLI-only; a "Scheduling"
  tab (routes + UI) is a real enhancement, out of scope for this pass.
- **Team Live shows no live activity for CLI-driven tasks** — events are process-local;
  needs a daemon bridge.
- **Dashboard team with a `#name` Slack channel** isn't server-resolved (LOW).

## Files changed
`cron.mjs`, `commands/automation.mjs`, `commands/workflow_named.mjs`, `commands/chat.mjs`,
`commands/providers.mjs`, `daemon/lib/respond.mjs`, `daemon/route_table.mjs`,
`daemon/routes/meta.mjs`, `daemon/routes/providers.mjs`, `providers/gemini.mjs`,
`providers/orchestrator.mjs`, `providers/registry.mjs`, `tui/repl.mjs`,
`tui/slash_dispatcher.mjs`, `web/dashboard.js`, `tests/f-agent-avatar-custom.test.mjs`.
