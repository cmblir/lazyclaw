# Agent memory — spec v0.1 (Phase 18)

> Status: **confirmed 2026-05-19** — §6 decisions locked, Phase 18b
> implementation in progress.

Carry forward per-agent knowledge across tasks so the same `planner` /
`backend` / `frontend` doesn't restart from a blank slate every time
the user opens a new thread.

---

## 1. Goal

When `runTaskTurn` calls `buildTurnContext` for an agent, prepend a
"things this agent remembers from past tasks" block to its system
prompt. After a task closes (`status: done` or `abandoned`), give the
lead a chance to write a short reflection back into each participating
agent's memory file.

The user can also read/edit the memory directly — these are plain
markdown files under `~/.lazyclaw/memory/`, the same root the existing
`/dream` and `/memory` commands already manage.

---

## 2. Storage

```
~/.lazyclaw/memory/
├── core.md              ← existing (user/LLM curated, project-wide)
├── recent.jsonl         ← existing (session turn log)
├── episodic/<topic>.md  ← existing (dream() output)
└── agents/<name>.md     ← NEW — one file per agent
```

Each `agents/<name>.md` is a free-form markdown document. Newest
reflections live at the top (latest-first reading order):

```markdown
# planner — memory

## 2026-05-19 — task t_20260519_a1b2c3 (ship checkout flow)
- Backend prefers postgres advisory locks over redis for short-lived
  cross-request locks (see thread).
- The CI matrix runs node 22 + 24; pin LTS in tooling docs.

## 2026-05-18 — task t_20260518_xxxxxx (auth migration)
- …
```

No cap, no automatic truncation — the user is the gardener. A future
phase can add a `dream`-like consolidator when files grow large.

---

## 3. Read path (every agent turn)

`buildTurnContext` adds a memory block between `agent.role` and the
team metadata:

```
<agent.role>

---

What you remember from prior tasks (newest first):
<contents of agents/<name>.md, truncated to ~12 KB / 3000 tokens>

---

You are *<DisplayName>* on team "<team>". Teammates: …
```

If the file is missing or empty the block is omitted entirely so an
agent with no history sees the same prompt it did pre-Phase-18.

Truncation is by *characters* (12 KB by default), keeping the newest
entries because reflections are appended at the top. Configurable per
agent via `agent.memoryMaxChars`.

---

## 4. Write path

Two triggers, controlled by `agent.memoryWrite`:

| value | behavior |
|---|---|
| `auto` (default) | router invokes `reflectAgent(agent, task)` for every participating agent when a task transitions to `done`. Each call is one extra LLM turn that asks the agent to summarise what it learned, prepended to its memory file. |
| `manual` | router never writes. User runs `lazyclaw agent reflect <name> --task <id>` explicitly. |
| `off` | the agent's memory file is read but never written. Useful for "stable persona" agents whose system prompt is the source of truth. |

`reflectAgent` prompt template (auto mode):

```
You just finished task "<task.title>" (id <task.id>). Here is the
full transcript:

<formatted transcript>

Write a SHORT markdown block (≤ 6 bullet points) capturing what you
learned during this task that would be useful next time. Be concrete:
file paths, decisions, gotchas, teammate preferences. Do NOT repeat
generic advice. Do NOT exceed 6 bullets. Reply with the bullets only
— no headers, no preamble.
```

The router prepends the response under a dated heading (`## <iso-date>
— task <id> (<title>)`) so the latest reflection stays on top.

---

## 5. Surface

CLI:

```
lazyclaw agent memory show <name>          # cat ~/.lazyclaw/memory/agents/<name>.md
lazyclaw agent memory edit <name>          # $EDITOR
lazyclaw agent memory clear <name>         # rm (with confirm)
lazyclaw agent reflect <name> --task <id>  # explicit reflection (manual mode)
```

Daemon HTTP:

```
GET    /agents/<name>/memory               # text/markdown body
PUT    /agents/<name>/memory               # bulk replace (dashboard editor)
DELETE /agents/<name>/memory               # clear
```

Dashboard: an "Edit memory" link on each row in the Agents tab opens a
textarea bound to PUT `/agents/<name>/memory`.

---

## 6. Decisions — confirmed 2026-05-19

| # | Decision |
|---|---|
| 1 | Write trigger default = **`auto`** — every participating agent reflects when the task transitions to `done` |
| 2 | Reflection budget = **one LLM call per agent, capped at 6 bullets** |
| 3 | Read truncation = **12 KB / ~3000 tokens, newest-first** |
| 4 | `stoppedBy='budget'` ticks **skip auto-reflection** — only terminal `done` fires the reflection LLM call |
| 5 | `lazyclaw agent reflect` **runs the same LLM prompt as auto mode** (use `agent memory edit` for hand-written entries) |
| 6 | Existing agents (no `memoryWrite` field) default to **`auto`** — the feature lights up without an explicit edit; flip to `off` for a stable persona |

Phase 18b implementation begins immediately.

---

## 7. Out of scope (deferred to Phase 19+)

- Cross-agent memory sharing (planner reads backend's memory)
- `dream()`-style consolidation when the file grows past N KB
- Per-team memory (separate from per-agent)
- Vector-search-backed recall (current implementation is "include
  everything up to the truncation point")
