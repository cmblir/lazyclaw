# Dashboard Operations (Phase 2) — Design

**Goal:** every routine operation completes in the dashboard — no terminal.
Phase 1 (motion shell) made the dashboard pleasant to read; this phase makes it
the place work gets done.

**Decisions locked during brainstorming:**

| Axis | Decision |
|---|---|
| Phase-2 track | Operational completeness (extensibility and observability depth deferred to phase 3+) |
| Authorization | Token = full authority. A browser holding the `--auth-token` bearer has the same rights as the CLI; a loopback daemon with no token is already unauthenticated-full-rights. No daemon-side write gate beyond the existing bearer check. Destructive actions get a UI confirm dialog (two-step, below) |
| Write path | The slash dispatcher is the ONLY write path. One new mutating route; panels compose slash commands. Typed-REST-per-resource was rejected: ~20 routes, each a drift point between CLI and dashboard validation |
| Done bar | "Terminal-zero week": the representative operating loop runs end-to-end in the dashboard, pinned by one Playwright scenario |

## Architecture

One new mutating route on the daemon, behind the existing bearer gate:

```
POST /slash        { line: "/team add crew --agents dev,qa", confirm?: "c_…" }
GET  /slash/commands                      (read-only: name + description list)
```

The daemon builds an **HTTP ctx** and calls the existing
`dispatchSlash(cmd, args, ctx, write)` from `tui/slash_dispatcher.mjs` — no
command code moves. The adapter lives in `daemon/lib/slash_http.mjs`:

- `write(...)` calls are collected in order into `lines`.
- A returned string is appended to `lines`; `'EXIT'` is a no-op over HTTP
  (there is no session to leave); `void` means the handler streamed.
- Long-streaming commands (agent runs) use the same SSE shape as
  `POST /conversation`: the route upgrades to SSE when the handler is in the
  `STREAMING` set, emitting `line` events and a final `done`.

`parseSlashLine` (already exported) splits `line` into `cmd`/`args`, so the
route accepts exactly what a user would type in the REPL.

## Envelope contract

```js
// success
{ ok: true, lines: ["team crew created", …], data?: { … } }
// failure (handler threw, or returned an error string the adapter classified)
{ ok: false, error: "unknown team: crwe", code: "SLASH_ERR" }
// interactive-only command
{ ok: false, code: "TTY_ONLY", error: "…", hint: "run in the terminal: pompos …" }
// destructive command awaiting confirmation
{ ok: false, code: "CONFIRM_REQUIRED", prompt: "delete team crew and its 2 agents?", token: "c_…" }
```

`data` is optional and introduced per-command as panels need structure; `lines`
is always present on success so the chat surface can render any command today.

**Confirm tokens:** server-memory map `token → {line, expiresAt}`; 60s TTL;
single-use (deleted on redemption); redeeming with a mismatched `line` is a
400. A restart clears pending confirmations — acceptable, the UI just re-asks.

## Capability gating

The HTTP ctx deliberately omits every TTY affordance (Ink approve, pickers,
cursor control). Most handlers already degrade to an explanatory string when a
ctx function is absent (the `readConfig`/`writeConfig` guard pattern in
slash_dispatcher.mjs:115 is the precedent). Commands that reach for the TTY
directly are listed in an explicit `TTY_ONLY` set in `slash_http.mjs` and
rejected with the hint envelope.

**Gate-coverage test:** dry-run every key of `SLASH_HANDLERS` through the HTTP
ctx with empty args; the test fails if any handler throws an unhandled
TypeError (the signature of an unlisted TTY reach-through). This is what keeps
a future command from crashing the route instead of degrading.

## Destructive actions

Commands that today prompt in the REPL (delete/remove/clear family) return
`CONFIRM_REQUIRED` over HTTP with a one-line prompt describing the blast
radius. The UI shows a dialog; on accept it re-POSTs the same `line` plus the
`token`. The adapter — not each panel — owns this translation, keyed off the
same prompt mechanism the REPL uses.

## Panels (write actions on the existing five — no new panels)

| Panel | Actions (all composed as slash lines) |
|---|---|
| agents | create, edit role/model/tools, set avatar, remove |
| teams | create, add/remove member, change reporting edge (existing tree UI gains drag targets), remove |
| tasks | issue to team/agent, retry, cancel |
| config | key-level get/set/unset via `/config …` — the dedicated-endpoint refusals in daemon/routes/config.mjs stay authoritative because the dispatcher enforces the same rules |
| workflows | run, resume, stop |

Buttons compose the exact command a user would type; the UI never invents a
second grammar.

## Chat

- Input starting with `/` → `POST /slash`; anything else → existing
  `POST /conversation` (unchanged).
- Autocomplete: `GET /slash/commands` returns `[{ name, description }]` built
  from `SLASH_HANDLERS`; the input shows a filtered popover. Adding a command
  in the dispatcher surfaces it in both the REPL and the dashboard with zero
  extra wiring — that is the point of the shared path.

## Done bar — the pinned E2E (Playwright)

One scenario, terminal-zero, against a daemon with a fake provider:

1. create a team with two agents (teams panel)
2. issue a task to it (tasks panel) → progress arrives over SSE
3. an approval request appears → approve inline (chat/approvals surface)
4. inspect the result; edit one config key (config panel)
5. re-run → succeeds

## Unit tests

- envelope: success lines order, error classification, `'EXIT'` no-op
- confirm: token single-use, TTL expiry, line-mismatch 400, restart clears
- gate coverage: full `SLASH_HANDLERS` dry-run (described above)
- equivalence sample: the same `/team add` through the REPL ctx and the HTTP
  ctx produces the same persisted team file
- `GET /slash/commands` matches the dispatcher's key set exactly

## Non-goals (phase 3+)

Plugin panel manifest/loader, observability depth (trajectory live view,
learning timeline, cost drill-down), mobile layout, multi-user roles.

## File map

- create: `daemon/lib/slash_http.mjs` (adapter: HTTP ctx, envelope, confirm
  tokens, TTY_ONLY and STREAMING sets)
- create: `web/ui/slash_client.mjs` (compose + POST + SSE consume; used by
  chat and all five panels)
- modify: `daemon/route_table.mjs` (+2 routes), `daemon/routes/` (new
  `slash.mjs` route module)
- modify: `web/ui/panels/{agents,teams,tasks,config,workflows}.mjs` (write
  actions), `web/ui/panels/chat.mjs` (slash routing + autocomplete)
- test: `tests/f-slash-http.test.mjs`, `tests/f-slash-commands-route.test.mjs`,
  E2E `tests/phaseI-dashboard-operations.spec.ts`
