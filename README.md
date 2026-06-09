# lazyclaw

<img src="docs/assets/sleepy-sloth-source.png" alt="lazyclaw sloth" width="110" align="right">

**A terminal agent that learns on your Claude subscription — for $0 — and reaches you on every channel.**

Chat in the terminal. Let the background learning loop distil your conversations into reusable skills on `claude-cli` (your Pro/Max subscription — no API bill). Wire it to Slack, Telegram, Discord, Matrix, Email, Signal, WhatsApp, or Voice. Fan a hard task out to a planner + workers. One small, auditable Node core — no daemon you can't read.

[![npm](https://img.shields.io/npm/v/lazyclaw.svg)](https://www.npmjs.com/package/lazyclaw)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-blue.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

```bash
npx lazyclaw          # first run walks you through setup, then drops into chat
```

<img width="1871" height="1146" alt="image" src="https://github.com/user-attachments/assets/365d05ac-cd24-4451-96b1-01fe82582a2b" />

*한국어: [README.ko.md](./README.ko.md)*

---

## What it is

lazyclaw is a single-binary-feel Node CLI in the "claw" family (Hermes → OpenClaw → nanoclaw). It is **TUI-first**: `lazyclaw` with no arguments opens a chat REPL with a sloth splash, slash commands, and ghost-text autocomplete. Underneath, every turn feeds a learning loop, and the same agent answers from any messaging channel you connect.

You can read the whole thing. No hosted service, no telemetry, config in plain JSON at `~/.lazyclaw/`, secrets in `~/.lazyclaw/.env` (0600).

## Quick start

```bash
npm install -g lazyclaw     # or: npx lazyclaw
lazyclaw                    # fresh install → guided setup, then chat
```

The first run is a **phased wizard** (Hermes-style — get one clean chat working first, then layer the rest):

1. **Provider + model** — arrow-key picker (`claude-cli` is keyless; gemini/openai/anthropic take an API key).
2. **Verify** — a one-token ping confirms the provider answers.
3. **Context window** — how much history to keep per turn (optional).
4. **Channel** — Slack / Telegram / Matrix / HTTP built in; Discord / Email / Signal / Voice / WhatsApp via plugins (optional).
5. **Workspace / skills / webhook** (optional).
6. **Orchestration** — turn on the planner + workers pipeline (optional).

Re-run it any time with `lazyclaw setup`, or `/config` from inside chat.

<img src="docs/screenshots/onboard.png" alt="lazyclaw provider picker" width="680">

## $0 self-learning

lazyclaw splits two provider slots: **`provider`** (chat — the hot path) and **`trainer`** (the learning loop — skill synthesis, reflection, the user model). They are independent, so a Claude Pro/Max subscription can power the learning while chat runs anywhere — or both run on one backend.

After every turn, a fire-and-forget loop records the trajectory and distils reusable skills, tagged `trained_by`. With `trainer: { provider: "auto" }` it auto-detects your `claude-cli` session and runs the loop for free; otherwise it mirrors the chat provider.

```jsonc
// ~/.lazyclaw/config.json
{
  "provider": "openai",            // chat: pay-per-token (or claude-cli, ollama, …)
  "model": "gpt-4.1",
  "trainer": { "provider": "auto" }  // learning: $0 on your Claude subscription
}
```

| Setup | `provider` | `trainer` | Cost |
|---|---|---|---|
| Subscription only | `claude-cli` | `auto` | **$0** |
| Hybrid (recommended) | `openai` / any | `auto` | chat only |
| Pure API | `openai` / any | `openai` | both metered |

## Talk to it anywhere

Connect a channel and the same agent answers there. Slack, Telegram, Matrix, and HTTP are built in; Discord, Email, Signal, Voice, and WhatsApp install as `@lazyclaw/channel-*` plugins.

```bash
# Slack (Socket Mode): set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in ~/.lazyclaw/.env
lazyclaw slack listen                 # receive @mentions, reply in-thread
lazyclaw slack listen --provider orchestrator   # …and orchestrate the reply

lazyclaw channels                     # view configured channels
lazyclaw channels enable|disable slack
lazyclaw channels install @lazyclaw/channel-discord
```

Inbound runs over Slack Socket Mode (no public URL, just an app-level `xapp-` token); outbound `message send` posts via Incoming Webhooks. Set it all up from the wizard's channel step, or `/channels` in chat.

## Multi-agent orchestration

Set the provider to `orchestrator` and a hard request becomes **Plan → Delegate → Synthesise**: a planner decomposes the task, workers run the subtasks in parallel, then the planner merges the results. Workers are real agents with the tool registry.

```bash
lazyclaw orchestrator set-planner claude-cli:claude-sonnet-4-6
lazyclaw orchestrator workers add claude-cli:claude-sonnet-4-6
lazyclaw orchestrator on            # route chats through the pipeline
```

From chat: `/orchestrator` opens an on/off picker, or `/orchestrator on|off|planner <spec>|worker add <spec>`. Details: [docs/multi-agent.md](./docs/multi-agent.md).

## Drive it from chat

The REPL has slash commands for everything you'd otherwise edit config for — point-and-pick, no JSON:

| Slash | Does |
|---|---|
| `/config` | leave chat and re-run the setup wizard |
| `/provider` · `/model` | pick provider / model from a searchable list |
| `/channels [<name> on\|off]` | view / toggle channels |
| `/orchestrator [on\|off\|…]` | view / toggle multi-agent (picker on bare call) |
| `/context [turns N\|tokens N]` | resize the chat history window |
| `/skill` · `/personality` · `/memory` · `/loop` · `/goal` | skills, personas, memory, loops, goals |

`/help` lists them all. Ghost-text autocomplete completes commands as you type; CJK/Hangul input composes inside the box.

## The dashboard

```bash
lazyclaw dashboard          # local web UI on http://127.0.0.1:19600
```

A framework-free SPA over the daemon's JSON API: Chat, Sessions, Workflows, Skills, Providers, Rates, Metrics, Doctor, Config, Status, Agents, Teams, Tasks, Trainer, Recall, Sandbox, Channels — 17 tabs, dark amber theme.

## Providers

| Chat / trainer | Auth |
|---|---|
| `claude-cli` | subscription (Pro/Max) — keyless |
| `anthropic` · `openai` · `gemini` | API key |
| `ollama` | local, no key |
| `nim` · `openrouter` · `groq` · `together` · `xai` · `deepseek` · `mistral` · `fireworks` | OpenAI-compatible API key |
| `custom` | any OpenAI-compatible v1 endpoint (your base URL + key) |
| `orchestrator` | meta-provider — planner + workers over any of the above |

<img src="docs/screenshots/providers.png" alt="lazyclaw providers info" width="680">

## What else it ships

- **Tool registry** — 12 categories (`agents`, `browser`, `coding`, `exec`, `fs`, `git`, `iot`, `learning`, `media`, `net`, `os`, `scheduling`) plus stdio MCP. Sensitive tools (shell, write, network) are **fail-closed** behind an approval hook by default.
- **Durable recall** — one SQLite + FTS5 index over sessions, skills, trajectories, and memory; rebuildable from the corpus.
- **Loops & goals** — durable foreground/`--detach` loops and cron-scheduled goals that survive restart.
- **Personas** — layered SOUL / workspace / personality / role / user-model / skills compose into the system prompt.
- **Sandboxes** — `local` / `docker` / `ssh` / `singularity` / `modal` / `daytona` behind one API.

## Configuration & security

Config is plain JSON at `~/.lazyclaw/config.json`; channel + provider secrets live in `~/.lazyclaw/.env` (written 0600, never logged). Move the dir with `LAZYCLAW_CONFIG_DIR=/path`.

> [!WARNING]
> Treat `~/.lazyclaw/config.json` like a shell rc — values resolved with `$(...)` execute at load. Don't paste an untrusted snippet without reading it.

Sensitive tools deny by default unless an approval hook grants them; `config.json` and workflow state are written owner-only; secrets are scrubbed from the `bash` tool's child env and redacted from trajectories and synthesised skills.

## Install / hack

```bash
npm install -g lazyclaw                 # install
git clone https://github.com/cmblir/lazyclaw && cd lazyclaw && npm install && npm link   # hack
node --test tests/*.test.mjs            # run the suite
```

Requires **Node 18+** (Node 22+ for Slack Socket Mode). macOS / Linux / WSL are first-class.

## Docs

- [docs/multi-agent.md](./docs/multi-agent.md) — orchestrator pipeline + Slack teams
- [docs/trainer-recipes.md](./docs/trainer-recipes.md) — $0, hybrid, and `auto` trainer configs
- [docs/persona-cookbook.md](./docs/persona-cookbook.md) — persona compose stack
- [docs/loop-goal-preflight.md](./docs/loop-goal-preflight.md) — loops + scheduled goals
- [CHANGELOG.md](./CHANGELOG.md) — release notes · [README.ko.md](./README.ko.md) — Korean

## License

[MIT](./LICENSE) · Source & issues: [cmblir/lazyclaw](https://github.com/cmblir/lazyclaw)
