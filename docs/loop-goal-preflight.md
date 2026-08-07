# Phase 0 — Pre-flight verification

Spec: `~/Downloads/goals.md` v3.91.0 baseline.
Actual repo: `/Users/o/pompos/` at `package.json` version **3.99.29**.
Repo layout note: spec assumes `src/pompos/<file>.mjs`. Actual files live at the repo root (`/Users/o/pompos/<file>.mjs`). Wiring follows the **actual** layout — no relocation.

## Checks

- [x] **PASS** — `cli.mjs` slash-command switch (line 2436 `handleSlash`) contains:
  `/help` (2439), `/status` (2444), `/provider` (2454), `/model` (2492), `/new` (2527), `/reset` (2528), `/usage` (2539), `/skill` (2558), `/exit` (2603). `SLASH_COMMANDS` table at line 851. No other slash cases — `/loop` and `/goal` are absent as expected.
  - Diff vs spec: spec ordering `/help, /status, /provider, /model, /new, /reset, /usage, /skill, /exit`; actual table order `/help, /status, /new, /reset, /usage, /skill, /provider, /model, /exit`. Set is identical; order is cosmetic, no impact.
  - Extra (informational): top-level prompt path at line 4730 also exposes `/quit` as alias of `/exit`. Not relevant for in-chat REPL handleSlash.

- [x] **PASS** — `cron.mjs` exports all functions named in spec §0:
  `parseCronSpec` (46), `ensureValidName` (136), `upsertJob` (155), `removeJob` (172), `runJob` (351), `installLaunchdJob` (320), `installCrontabJob` (300), `pickBackend` (179).
  - Extras present (will reuse): `getJob`, `listJobs`, `uninstallLaunchdJob`, `uninstallCrontabJob`, `expandField`, `buildPlist`, `buildCrontabLine`, `plistPath`, `CronError`.

- [x] **PASS** — `sessions.mjs` exports `appendTurn(id, role, content, configDir = defaultConfigDir())` at line 69. Signature matches spec: `appendTurn(id, role, content, configDir?)`.
  - Extras present (will reuse): `loadTurns`, `clearSession`, `resetSession`, `exportMarkdown`, `exportJson`, `exportText`, `defaultConfigDir`, `sessionsDir`, `sessionPath`, `listSessions`.

- [x] **PASS** — `daemon.mjs` has `POST /agent` route at line 1489. Comment at line 10 documents SSE-streaming variant.

## Other anchors verified

- `cmdCron` async function at `cli.mjs:3394`. Top-level subcommand dispatch lands at `cli.mjs:4544` (`case 'cron':`). Both will be the pattern for `pompos loop` and `pompos goal`.
- `.gitignore` already contains `.pompos/` (intended for in-repo state) and `node_modules/` `*.tgz` `test-results/` `playwright-report/` `.playwright/`. The home directory `~/.pompos/` is outside the repo so cannot leak via the repo's `.gitignore`; tokens land in `~/.pompos/.env` (created with `chmod 600`).
- `~/.pompos/.env` exists with `SLACK_BOT_TOKEN` populated. `SLACK_APP_TOKEN` and `SLACK_SIGNING_SECRET` pending Phase 8 prerequisites from user.

## Decisions binding the rest of the implementation

1. **No `src/` relocation.** All new modules go to `/Users/o/pompos/`, alongside `cron.mjs` / `sessions.mjs`.
2. **All wiring against v3.99.29 line numbers.** Add `/loop` case in handleSlash after `/skill` (around line 2603, before `/exit`). Add `pompos loop` subcommand after `case 'cron':` in the dispatch around line 4544.
3. **Channel refactor (Phase 7) preserves daemon route shapes byte-identically.** `POST /agent`, `POST /chat`, `GET /sessions[/search]`, `GET /workflows`, `GET /skills` must keep response shape.
4. **Memory store root = `~/.pompos/memory/`.** Goal store root = `~/.pompos/goals/`. Both gitignored (outside repo).

Pre-flight complete. Phase 1 may begin.
