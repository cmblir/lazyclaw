# Agent-Team Live Dashboard — Design

Status: approved direction (build order A "full real-time", visual C "hybrid avatar
team" + click-to-drill-down). User delegated the remaining decisions ("추천으로").

## Goal

A real-time visual dashboard where the operator:

1. Builds a **hierarchy of agents** — e.g. a planner, with sub-agents on different
   harnesses: a data-engineer on `gemini`, a backend on `claude-cli` (opus).
2. Assigns work **from Slack** (one message into a team's channel).
3. **Watches the team work live** — who is doing what, on which harness, and the
   real-time agent-A → agent-B delegation, with click-to-drill-down (harness,
   current task, recent activity) per agent.

Visual direction: **C — hybrid avatar team**. Avatar tiles with a status ring
(working / idle), a harness badge (`provider · model`), animated delegation
arrows, and a side detail panel on click. Not a full pixel-art office sim.

## Current state (gaps this design closes)

- Agents/teams are **flat** — no hierarchy field (`agents.mjs`, `teams.mjs`).
- **No event bus** — all delegation is synchronous returns + streamed text + JSONL.
- **No activity SSE** — SSE helpers exist but only stream chat tokens (`/chat`,
  `/agent`). No `/events` endpoint; the dashboard never polls or subscribes.
- **Slack is single-shot** — `POST /inbound` does one `provider.sendMessage`; it
  never touches teams/tasks/`runTaskTurn`. Multi-agent tasks are CLI-only today.

## Architecture — 4 layers

### L1 — Hierarchy data model
- Add an optional `manager` field (parent agent name) to the agent record
  (`agents.mjs` `defaultShape`). A team's tree is derived: `team.lead` is the root,
  members link upward via `manager`.
- Validation: `manager` must be a registered agent; reject cycles (walk the parent
  chain; a repeat = cycle). Surfaced through the existing `PATCH /agents/:name`.
- New read helper `teamTree(team, agentsById)` → nested `{agent, children[]}` for
  the dashboard and for delegation context.

### L2 — Live event bus + SSE
- New zero-dep in-process pub/sub `mas/events.mjs`: `emit(type, payload)`,
  `subscribe(fn) → unsubscribe`, and a bounded **ring buffer** (last ~200 events)
  for replay on connect. Emit is fire-and-forget — it must never throw into a turn.
- Event taxonomy:
  - `task.start { taskId, team, title }`, `task.done { taskId, status }`
  - `turn.start { taskId, agent, provider, model }`
  - `turn.end { taskId, agent, stoppedBy }`
  - `tool.call { taskId, agent, tool, ok, durationMs }`
  - `delegate { taskId, from, to, prompt }` (the A→B arrow)
  - `agent.status { agent, status: 'working' | 'idle' }`
- Emit points: `mention_router.runTaskTurn` (task/turn/status + `delegate` at the
  `@mention` hand-off), `agent_turn` (`tool.call` per tool result),
  `delegation.task_spawn` (`delegate` from→to for spawned sub-agents).
- New daemon route `GET /events` (SSE) — subscribes to the bus, replays the ring
  buffer on connect, streams subsequent events. Auth-gated like other routes;
  reuses `writeSseHead`/`writeSse` (`daemon/lib/respond.mjs`). Lives in a new
  `daemon/routes/events.mjs`, registered in `route_table.mjs`.

### L3 — Slack → team auto-routing
- Extend `POST /inbound`: when the inbound channel is bound to a team
  (`team.slackChannel`), register a task for that team and drive `runTaskTurn`
  (multi-agent loop → emits L2 events), instead of the single-shot send.
- Channel→team resolution via the existing `teams` store. **Fallback**: when no
  team is bound to the channel, keep the current single-shot path byte-stable.
- The task's turns still mirror to the Slack thread (existing behavior); the
  dashboard view is additive.

### L4 — Visual C dashboard ("Team" tab)
- New tab in `web/dashboard.{html,js,css}`. Renders `teamTree` as avatar tiles:
  avatar circle + status ring (working/idle) + harness badge. `delegate` events
  animate an A→B arrow. Click an agent → drill-down panel (harness, current task,
  recent activity feed merged from events + task turns).
- Live via `EventSource('/events')`; initial state from `GET /agents` (+ hierarchy),
  `GET /teams`, `GET /tasks`, plus the SSE replay buffer.
- Responsive 3 viewports (375×667 / 768×800 / 1280×800), accessible (labels,
  keyboard focus, `prefers-reduced-motion`), 5 states (idle/loading/empty/error/
  success). Playwright 3-viewport self-verification + qa note.

## Data flow

```
Slack msg ─▶ POST /inbound ─▶ resolve channel→team ─▶ registerTask + runTaskTurn
                                                          │  emits events
                                                          ▼
                                                   mas/events bus ──▶ GET /events (SSE)
                                                                          │
                                              dashboard EventSource ◀─────┘
                                              renders avatars · status · A→B arrows · drill-down
```

## Error handling
- Bus emit is fire-and-forget (try/catch swallowed) — never breaks an agent turn.
- SSE: `EventSource` auto-reconnects; the server replays the ring buffer on connect
  so a freshly-opened dashboard converges to current state.
- Slack routing falls back to single-shot if team resolution fails (no regression).
- Hierarchy cycles rejected at write with a clear error.

## Testing
- Unit: event bus (pub/sub, ring buffer bound, emit-never-throws); hierarchy
  validation (cycle detection, unknown manager); `teamTree`; Slack→team routing
  (channel match + fallback); `/events` SSE (replay + live emit).
- Playwright (3 viewports): Team tab renders the tree, click opens the drill-down,
  a synthetic `delegate`/`tool.call` event updates the UI. qa note with screenshots.

## Modularity / file-size
- `mas/events.mjs` (bus, small), `daemon/routes/events.mjs` (SSE route),
  hierarchy in `agents.mjs`/`teams.mjs`, Team-tab logic in a focused
  `web/dashboard-team.js` if `dashboard.js` would breach the size ratchet.
- `package.json` `files` already ships `web/`, `mas/`, `daemon/` — new modules under
  those are packed; the new `daemon/routes/events.mjs` is reachable via the route table.

## Build order (A — full real-time)
L1 hierarchy → L2 event bus + SSE → L3 Slack routing → L4 visual view. Each layer is
a shippable increment (TDD, atomic commit, push, test).
