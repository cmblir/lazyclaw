# QA — Dashboard "Scheduling" tab — 2026-06-29 (autonomous Q1)

New dashboard tab surfacing the three CLI-owned scheduling surfaces (cron jobs,
durable goals, loop runs), closing the "no dashboard visibility for scheduling"
gap that the audit found.

## Scope / security posture
- `GET /scheduling` → `{ cron, goals, loops }` (read).
- `DELETE /cron/<name>` → removes a cron job (config = source of truth, OS
  teardown best-effort), **guarded by `ctx.writeConfig`** (read-only daemon → 405).
- **No create endpoint by design.** Scheduling a job installs a launchd/cron entry
  that runs a command, and `lazyclaw dashboard` is loopback-but-unauthenticated, so
  creation stays in the trusted CLI. Goals/loops are read-only here; only cron
  exposes a delete (the safe, reversible direction).

## Verification
- Routes unit-tested: `tests/f-dashboard-scheduling.test.mjs` — list aggregates
  cron+goals+loops; delete removes from cfg; 405 when read-only; 404 for unknown. 4/4.
- Full suite: `node --test tests/*.test.mjs` → **1445 pass / 0 fail**.
- Live (daemon on :19600, demo cron injected into config without installing launchd):
  - `GET /scheduling` returned the demo cron + empty goals/loops.
  - Tab rendered: cron table (name/schedule/command/Delete), goals + loops empty
    states. `1 cron · 0 goals · 0 loops`.
  - Delete flow: click Delete → confirm → row gone, `0 cron`, and
    `config.json` `cfg.cron = {}` (demo entry cleaned up). Delete path verified +
    test data reverted.

## 3-viewport
| Viewport | Page overflow | Table overflow | Console | Visual |
|---|---|---|---|---|
| 1280×800 | none | — | 0 | pass (`scheduling-tab-1280.png`) |
| 768×800  | none | — | 0 | pass (`scheduling-tab-768.png`) |
| 375×667  | none (scrollWidth 360) | none (cell wrap) | 0 | pass (`scheduling-tab-375.png`) |

Result: **PASS** at all three.

## Files
`daemon/routes/scheduling.mjs` (new), `daemon/route_table.mjs`, `web/dashboard.html`,
`web/dashboard.js`, `tests/f-dashboard-scheduling.test.mjs`.
