# Today queue — autonomous session 2026-06-29

Entered autonomous mode at user request ("자율모드 시작, 최대 풀로드 풀 에이전트로",
all approved). Direct push to main allowed (Global CLAUDE.md §14.2, overrides the
older aux file); NO PR / git tag / GitHub Release / npm version bump (the publish
workflow skips while package.json stays at the published version — keeps releases
reversible/maintainer-owned). English commits, user identity, no AI attribution.

## [Q0] Ship the verified 14-bug audit fix set — DONE
- 목표: commit + push the audit fixes (already tested: 1441/1441, lint OK, 3-viewport).
- 영향 범위: cron/workflow/chat/providers/tui/dashboard (16 files + 1 test).
- 완료 기준: atomic commits on main, pushed, CI green.
- UI 변경 포함: yes (dashboard.js — verified 375/768/1280).
- 위험도: low (verified).

## [Q1] Dashboard "Scheduling" tab (cron · goals · loops)
- 목표: surface scheduling in the dashboard — daemon read/list/create/delete routes
  for cron jobs, goals, and loops + a new SPA tab. Closes the "no dashboard routes
  for scheduling" gap; complements the now-fixed CLI scheduling.
- 영향 범위: daemon/route_table.mjs, daemon/routes/* (new), web/dashboard.{html,js,css}, cron.mjs/goals.mjs/loops.mjs (read helpers only).
- 완료 기준: tab lists existing cron/goals/loops; create + delete work end-to-end
  against the daemon; tests for the new routes; 3-viewport Playwright pass.
- UI 변경 포함: yes (3-viewport required).
- 위험도: medium.

## [Q2] Accessible tab nav (WAI-ARIA Tabs + keyboard + deep-link)
- 목표: the 18-tab nav gets role=tablist/tab/tabpanel, roving tabindex, arrow-key
  navigation, aria-controls, and History-API deep-linking (#tab).
- 영향 범위: web/dashboard.{html,js,css}.
- 완료 기준: keyboard arrow nav works; refresh/deep-link restores the tab; 3-viewport pass.
- UI 변경 포함: yes.
- 위험도: low-medium.

## [Q3] Status token map (color + icon + label) + tri-state freshness
- 목표: never convey status by color alone (WCAG) — one state→{color,icon,label}
  map reused across rings/badges; extend the live dot to per-stream Live/Stale.
- 영향 범위: web/dashboard.{js,css}.
- 완료 기준: every status has a non-color cue; 3-viewport pass.
- UI 변경 포함: yes.
- 위험도: low.

## Deferred to backlog (NOT autonomous — risk/ambiguity)
- 3-tier approval scope (once/session/always) — touches the security gate; needs a design decision.
- Measurable self-learning trigger + timing — touches the learning loop; ambiguous scope.
- Sandbox-wire the autonomous tool-exec path — security-critical; needs review.
