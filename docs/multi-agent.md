# Multi-Agent Slack System — spec v0.1

> Status: **confirmed 2026-05-18** — §10 decisions locked, Phase 9 may begin.

---

## 1. Goals (in user's words)

1. User opens the **dashboard**, registers agents, defines roles, optionally groups them into teams.
2. User assigns a task to **one lead agent** (e.g. `@planner`) via the dashboard.
3. The lead agent picks up the task in **one Slack thread**, decides which teammates to involve, and **@-mentions** them in the same thread.
4. Mentioned agents (e.g. `@backend`, `@frontend`) do their part — they may call tools (read files, run commands, edit code) — and post their results in the same thread.
5. Results bubble back to the lead. Lead synthesises and reports the final outcome to the user (dashboard + thread summary).
6. All conversation history per task lives in one Slack thread + one pompos session, so anyone (incl. the user) can audit.

Concretely: **one Slack channel, many virtual agents, mention-driven routing, with tool-use enabled per agent.**

---

## 2. Vocabulary

| Term | Definition |
|---|---|
| **Agent** | A named identity with a role (system prompt), a provider/model, a tool whitelist, and a persona/avatar. Not a Slack user — a virtual identity surfaced through the one real bot. |
| **Team** | A named set of agents + a default Slack channel + a default lead. Teams scope routing: `@backend` in team `shop` is a different agent than `@backend` in team `growth`. |
| **Task** | A unit of work with a title, description, owning team, lead agent, status, and a Slack thread ts. Each task = exactly one thread. |
| **Turn** | One agent saying one thing in a thread. Stored as `{ agent, text, tool_calls?, tool_results?, ts }`. |
| **Handoff** | An agent's turn that contains `@OtherAgent` mention(s). The router schedules `OtherAgent` to take the next turn(s) with full thread history. |

---

## 3. Data model

Files live under `~/.pompos/`, gitignored, schema versioned via `version` field.

### 3.1 Agent — `~/.pompos/agents/<name>.json`

```jsonc
{
  "version": 1,
  "name": "planner",                     // unique identifier, used in @mentions
  "displayName": "Planner",              // shown in dashboard + Slack header
  "role": "You are the project planner. Break work down…",  // system prompt
  "provider": "claude-cli",              // any pompos provider name
  "model": "claude-opus-4-7",
  "tools": ["bash", "read", "write", "grep", "web_search"],  // whitelist
  "tags": ["lead"],                      // free-form labels (used by router for fallback)
  "createdAt": "2026-05-18T…",
  "updatedAt": "2026-05-18T…"
}
```

### 3.2 Team — `~/.pompos/teams/<name>.json`

```jsonc
{
  "version": 1,
  "name": "shop",
  "displayName": "Shop squad",
  "agents": ["planner", "backend", "frontend"],
  "lead": "planner",                     // default task lead, overridable per task
  "slackChannel": "C0B5AGCP8PJ",         // channel id (preferred) or "#shop"
  "createdAt": "2026-05-18T…"
}
```

### 3.3 Task — `~/.pompos/tasks/<id>.json`

```jsonc
{
  "version": 1,
  "id": "t_2026-05-18_001",
  "title": "ship checkout flow",
  "description": "…",
  "team": "shop",
  "lead": "planner",
  "status": "running",                   // pending | running | done | failed | abandoned
  "slackChannel": "C0B5AGCP8PJ",
  "slackThreadTs": "1700000000.000100",  // root message ts
  "createdAt": "…",
  "updatedAt": "…",
  "turns": [
    { "agent": "user",     "text": "ship checkout flow", "ts": "1700000000.000100" },
    { "agent": "planner",  "text": "Step 1 … @backend implement …", "ts": "…" },
    { "agent": "backend",  "text": "Done — diff at …", "tool_calls": […], "ts": "…" }
  ]
}
```

---

## 4. Slack routing model

### 4.1 One bot, many virtual agents

There is **one** real Slack app/bot (the existing pompos bot). Each agent appears in Slack as a message prefixed with the agent name and (optionally) a custom username/icon via `chat.postMessage`'s `username` + `icon_emoji` params (requires `chat:write.customize` scope).

Why not multiple bots:
- Slack workspace pollution (1 app per agent ≠ scalable)
- Re-installation + token management per agent is a ceremony
- Permission model is per-bot, not per-message — easier with one trusted bot

### 4.2 Inbound trigger

A thread becomes "live" when either:
- The user starts a task from the dashboard → pompos posts a root message in the team's channel
- A human posts in any channel where the bot is a member and **@-mentions a specific agent**, e.g. `@planner build me X`. The bot maps `@planner` (by display name → agent name → team) and treats the message as the kickoff turn.

### 4.3 Mention parsing

Agents address each other with **plain text `@AgentName`** (no Slack user_id), because virtual agents have no Slack identity. Router scans every agent-authored message for `@(\w+)` and:

1. Resolves each match to an agent in the **same team** as the speaker (scoped lookup; ambiguous matches across teams are an error reported in-thread).
2. Schedules each mentioned agent for a turn. Turns are taken **sequentially** (not parallel) to keep the conversation linear and avoid token explosions; future enhancement can fan out.
3. After the last mentioned agent finishes, **control returns to the lead** if the lead wasn't part of the mentions — the lead gets a synthesised view and decides whether to keep iterating or mark the task done.

### 4.4 Termination

A task is `done` when:
- The lead emits a turn containing the literal marker `[[TASK_DONE]]` (chosen over `DONE` to avoid false positives when agents discuss the word "done" naturally), **or**
- A per-task `maxTurns` budget is exhausted (default 30, configurable), **or**
- The user marks it done from the dashboard or via slash command.

### 4.5 Bot's own messages

Slack delivers `message` events for the bot's own posts. The router **must** filter `subtype === 'bot_message'` and `bot_id === <our bot>` so the bot never reacts to its own agent posts. This is already done in `channels/slack.mjs`.

---

## 5. Tool-use per agent

This is the largest delta vs current code. Today, the Slack handler calls `prov.sendMessage(messages, …)` once and returns text. Multi-agent needs a **tool-use loop**: the model returns either a final text or a tool call; pompos executes the tool and feeds results back; repeat until final text.

### 5.1 Tool whitelist (per agent)

```
bash         — run a shell command, get stdout/stderr/exit
read         — read a file (path-scoped)
write        — write/edit a file
grep         — search the workspace
web_search   — call Tavily / Serper / duckduckgo
web_fetch    — fetch a URL
slack_post   — post a message into the task's thread (rarely needed — output text auto-posts)
```

Each agent declares the subset it can use. Tools the agent didn't request are not advertised to the model. **Default whitelist for a dashboard-created agent: `[bash, read, write, grep]`** (per §10 #3 — user opted for the full set; restrict per-agent if needed).

### 5.2 Permission and audit

- Every tool call is logged to `~/.pompos/tasks/<id>.audit.jsonl` with `{ agent, tool, args, result_hash, ts }`.
- Bash commands are *not* sandboxed by default (per user decision §0). Workspace is constrained to the cwd of the pompos process.
- **Bash destructive-pattern confirmation is OFF by default** (per §10 #6). The dashboard exposes a per-team toggle so individual teams can opt into the "ask before `rm -rf` / `git push --force` / `DROP TABLE` …" gate; the patterns themselves live in a config file the user can edit.
- Audit log captures destructive commands either way so post-hoc forensics is possible.

### 5.3 Provider compatibility

Tool-use is supported on **anthropic, openai, and gemini** from Phase 12 (per §10 #5 — user opted for parallel implementation). Each provider has its own tool-call schema; the implementation routes through a small adapter layer (`providers/tool_use.mjs`) that normalises:

- Anthropic: `tools` array + `tool_use` / `tool_result` content blocks
- OpenAI: `tools` (functions) + `tool_calls` / `tool` role messages
- Gemini: `function_declarations` + `function_call` / `function_response` parts

claude-cli (subprocess) does NOT support tool-use — those agents are flagged "tool-use disabled" in the dashboard and can only chat.

---

## 6. Dashboard UX

The existing `pompos dashboard` (browser-rendered HTML, served by the daemon) gets four new screens:

```
┌─────────────────────────────────────────────────────────┐
│ Lazyclaw dashboard                          [search …]  │
├─[ Agents ][ Teams ][ Tasks ][ Live threads ][ …existing ]┤
│                                                         │
│  Agents                                  [ + New agent ]│
│  ┌──────────────────────────────────────────────────┐  │
│  │ planner     Planner       claude-opus-4-7   ✎ ✕  │  │
│  │ backend     Backend dev   claude-sonnet-4-6 ✎ ✕  │  │
│  │ frontend    Frontend dev  claude-haiku-4-5  ✎ ✕  │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

- **Agents tab** — list / create / edit / delete agents. Edit form has role textarea, provider+model dropdown, tool checkboxes.
- **Teams tab** — list / create / edit teams. Team form picks agents from registered list + Slack channel selector (calls `conversations.list`).
- **Tasks tab** — list of recent tasks with status, links to live Slack thread, and a "View transcript" detail view that renders the `turns` array as a chat-like timeline.
- **Live threads** — currently-running tasks with a kill button (sets `status: abandoned`, posts a closing message in thread).

CLI parity (so anyone can manage without a browser):

```
pompos agent add planner --role "…" --provider claude-cli --model claude-opus-4-7 --tools bash,read,write
pompos agent list / show / edit / remove
pompos team  add shop  --lead planner --agents planner,backend,frontend --channel C0B5AGCP8PJ
pompos team  list / show / edit / remove
pompos task  start --team shop --title "ship checkout flow"
pompos task  list / show / abandon / done
```

REPL slash equivalents (`/agent`, `/team`, `/task`).

---

## 7. Phase plan

Each phase exits 0 on its Playwright suite before the next phase starts.

| Phase | Scope | Tests |
|---|---|---|
| **9** | Agent registry + CRUD CLI + dashboard list view | `phase9-agent-registry.spec.ts` |
| **10** | Team registry + CRUD CLI + dashboard. Channel resolver. | `phase10-team-registry.spec.ts` |
| **11** | Task registry + `pompos task start` opens a Slack thread with the lead's intro turn. | `phase11-task-start.spec.ts` |
| **12** | **Tool-use loop** (the big one). Provider abstraction for tool calls, audit log, file/path scoping. | `phase12-tool-use.spec.ts` |
| **13** | Mention router — agent A's `@B` schedules B for next turn, with full thread context. Handoff back to lead when mentions run out. | `phase13-mention-router.spec.ts` |
| **14** | Termination policies (DONE marker, maxTurns, manual). Final summary post. | `phase14-termination.spec.ts` |
| **15** | Dashboard UI screens for agents/teams/tasks. WebSocket live updates. | `phase15-dashboard-mas.spec.ts` |
| **16** | Polish — `chat:write.customize` per-agent username/icon, agent typing indicators, transcript export. | `phase16-polish.spec.ts` |

Phase 9 + 10 + 11 alone get a working "post-from-dashboard-into-Slack" pipeline (no tool-use, no handoff yet) — that's the first user-visible milestone, ~3-4 days of work.

---

## 8. Cross-cutting

- **Security** — tokens stay in `~/.pompos/.env`, never logged, never in task records. Bash tool runs as the user (no privilege drop) — *only* enable for trusted teams/workspaces.
- **Rate limits** — each agent turn counts against its provider's RL. Router pauses (not crashes) when an agent hits 429.
- **Concurrency** — one task = one thread; multiple tasks can run concurrently. Per-task state is independent.
- **Storage** — flat JSON files (matches pompos's existing pattern: `~/.pompos/goals/`, `~/.pompos/loops/`). Migration story: bump `version` field per schema change, write a one-shot migrator.

---

## 9. Out of scope (v0.1 — deferred)

- Cross-team handoffs (`@team:other/agent` syntax)
- Parallel mention fan-out (multiple agents replying at the same time)
- Persistent agent memory / self-improvement (orthogonal — uses `~/.pompos/memory/`)
- Non-Slack channels (Discord/Telegram) — pattern is identical once Phase 7 channel interface lands. Add post-v0.1.
- Multi-workspace (one pompos daemon serving more than one Slack workspace)
- Voice / file attachments inside threads
- Agent-vs-agent direct messages outside a task thread

---

## 10. Decisions — confirmed 2026-05-18

| # | Question | Decision |
|---|---|---|
| 1 | Agent `@mention` form | **Full names** — `@planner`, `@backend`, `@frontend` |
| 2 | Termination marker | **`[[TASK_DONE]]`** — explicit token, no false positives |
| 3 | Default tool whitelist for new agents | **`[bash, read, write, grep]`** — full set, restrict per-agent if needed |
| 4 | Slack channel topology | **One channel per team** — matches §3.2 |
| 5 | Tool-use provider coverage in Phase 12 | **anthropic + openai + gemini** — all three from launch |
| 6 | Bash destructive-pattern confirmation | **OFF by default** — dashboard per-team toggle to enable; audit log always on |

Phase 9 work begins immediately after this commit lands.
