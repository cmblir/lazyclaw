# Group 1 — Agentic REPL + Plan Mode

Status: design (awaiting decision sign-off)
Date: 2026-06-13
Scope: make the interactive chat REPL able to run tools behind the existing
fail-closed approval gate, plus a read-only "plan first" mode. One spec; two
features (plan mode rides on the agentic turn).

## Problem

Today the interactive chat (`lazyclaw` TUI) is text-only: `tui/run_turn.mjs`
streams `prov.sendMessage()` and never runs a tool (seam confirmed at
`tui/run_turn.mjs:94`). All tool execution lives in the multi-agent path
(`mas/agent_turn.mjs:185-248` loop + `runTool`), reachable only via `/task`.
A user chatting in the REPL cannot ask the agent to read a file, grep, or
(with approval) run a command — the single biggest capability gap vs Claude
Code.

## What already exists (reuse, don't rebuild)

- `mas/agent_turn.mjs` `runAgentTurn({agent, userMessage, history, approve, …})`
  — a complete non-streaming tool loop (`callOnce` → inspect `kind` → run
  tool_calls via `runTool` → loop; returns `{text, iterations, stoppedBy, toolCalls}`).
- `mas/tool_runner.mjs` `runTool` — fail-closed sensitive-tool gate
  (`:54-72`): sensitive tools run only behind an `approve({tool,args,agent})`
  hook or explicit `security.allowUnattendedSensitive`. **This gate is not
  changed by this work (§8).**
- `tui/slash_dispatcher.mjs` `_makeInkApprove(ctx)` (`:264-274`) — an Ink modal
  approve hook (`_promptConfirm`), already used for `/task`. Reused verbatim
  for the chat tool loop.
- `providers/tool_use/{anthropic,openai,gemini,claude_cli}.mjs` `callOnce` —
  the non-streaming envelopes the loop needs.
- `DEFAULT_TOOLS = ['bash','read','write','grep','skill_view']`
  (`mas/tool_runner.mjs:22`).

## Design

### Core decision: streaming vs tool loop

The chat path streams (`sendMessage` generator) for live feedback; the tool
loop needs the non-streaming `callOnce` envelope to see `tool_calls`. These
cannot both drive the same turn. Chosen approach (**Option A**): when agentic
mode is ON, the turn routes through the existing `runAgentTurn` loop instead
of `sendMessage`. Per iteration:

- `callOnce` returns either a final answer or tool_calls.
- Tool activity is rendered to the REPL via the existing `writeFn` sink as
  compact status lines (e.g. `· read(src/x.mjs) → 1.2 KB`, `⚠ bash(...) — awaiting approval`).
- The final answer text is written to `writeFn` when the loop returns
  `stoppedBy:'final'`.

Rejected: streaming tool-use (Option B) — the shipped adapters don't stream
tool calls; it would be a large rewrite (YAGNI). Plain chat stays streaming
when agentic mode is OFF (unchanged path).

### Toggle & default

Agentic mode is **opt-in, OFF by default** — preserves current behavior and
keeps the safety surface unchanged for existing users. Enabled via:
- config `chat.agentic: true`
- `/agentic [on|off]` slash (mirrors `/hud`), persists to `cfg.chat.agentic`.

When OFF, `run_turn` behaves exactly as today (streaming, no tools).

### Chat agent record

When agentic mode is ON, `run_turn` builds a synthetic chat agent record:
`{ name:'chat', provider: activeProvName, model: activeModel, role: <system prompt from messages>, tools: <chat tool whitelist> }`
and calls `runAgentTurn({agent, userMessage:text, history, configDir, approve, cache:true, usePromptStack:false})`.
The approve hook is `_makeInkApprove(ctx)` in the Ink path (fail-closed),
`makeReadlineApprove()` in the legacy readline path.

### Chat tool whitelist

Default chat tools = read-only + safe set: `['read','grep','skill_view']` plus
the sensitive `bash`/`write` **only when the user has them enabled** via
`cfg.chat.tools` (array) — default excludes `bash`/`write`. Rationale: a chat
turn that can silently propose `bash` is higher-risk than `/task`; opt-in per
tool. Sensitive tools still pass through the approval modal regardless.

### Plan mode

`/plan` toggles a read-only mode. Because it rides on the tool loop, turning
`/plan` ON implies agentic-on for the session (read-only); turning it OFF
restores whatever `cfg.chat.agentic` was. Concretely:
- The agent's tool whitelist is intersected with a read-only set
  (`read`, `grep`, `skill_view`, `ls`-likes) — **no** `bash`/`write`/`delegate`.
- A system-prompt addendum instructs: "Propose a plan; do not mutate. List the
  steps you would take and the tools you would use, then stop."
- Exiting `/plan` (or `/plan off`) restores the normal whitelist.

Plan mode is the safe default entry point for agentic exploration: read the
codebase, propose, then the user turns it off to execute. v1 keeps it simple —
no automatic "approve plan → execute" handoff (that's a later iteration).

### Rendering

Tool activity lines and the final answer both go through the existing buffered
`writeFn` (CJK-safe 30 ms coalescing). No new render surface. Tool errors and
denials print as dim status lines, not as the red provider-error style.

## Components touched

- `tui/run_turn.mjs` — branch: agentic ON → `runAgentTurn` loop with a
  tool-activity renderer; OFF → current streaming path. (Owns the agentic turn.)
- `tui/slash_dispatcher.mjs` — `/agentic` and `/plan` slash handlers; expose
  `_makeInkApprove` to the chat turn (already defined there).
- `config_features.mjs` / config schema — `chat.agentic`, `chat.tools`,
  `chat.planMode` keys (validated, defaulted off/safe).
- No change to `mas/agent_turn.mjs`, `mas/tool_runner.mjs`, or the approval
  gate — reused as-is.

## Error handling

- Tool loop budget (existing `maxIterations`) prevents runaway turns; on budget
  exhaustion the partial text + a "stopped after N tool steps" note print.
- Approval denial → the tool returns the existing `TOOL_DENIED_APPROVAL`
  result; the model sees it and continues or concludes.
- Provider/tool errors are surfaced (no silent catch), styled as status lines.

## Testing

- Unit: agentic `run_turn` with a stubbed `runAgentTurn` — assert it routes to
  the loop when `cfg.chat.agentic`, and to `sendMessage` when off.
- Unit: plan mode intersects the whitelist to read-only and injects the
  addendum; sensitive tools are absent from the agent record's tools.
- Unit: the approve hook is threaded (a stubbed sensitive tool call triggers
  the approve callback; denial yields no execution).
- Reuse the existing `runAgentTurn` test scaffolding for the loop itself
  (already covered by phase12 tool-use specs).

## Decisions (defaults chosen — confirm or override)

1. **Agentic mode default**: OFF (opt-in). [recommended]
2. **Chat tool whitelist default**: `['read','grep','skill_view']`; `bash`/`write`
   opt-in via `cfg.chat.tools`. [recommended — conservative]
3. **Approval gate**: reuse existing fail-closed `_makeInkApprove` /
   `makeReadlineApprove`, unchanged. [non-negotiable per §8]
4. **Plan mode v1**: read-only whitelist + prompt addendum; no auto
   plan→execute handoff. [recommended — YAGNI]
5. **Streaming**: agentic turns are non-streaming per iteration (tool activity
   + final answer printed); plain chat stays streaming. [forced by adapters]

## Out of scope (later iterations)

- Streaming tool-use, `@`-file mentions, `!`-bash passthrough, declarative
  permission rules, plan→execute auto-handoff, queued messages during streaming.
  These are separate roadmap items, not Group 1.
