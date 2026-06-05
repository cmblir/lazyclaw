# lazyclaw

<img src="docs/assets/sleepy-sloth-source.png" alt="lazyclaw sloth" width="120" align="right">

**A terminal agent whose learning loop runs free on your Claude Pro subscription.**

Chat with any provider. Train the skill bank, user model, and reflection pass on `claude-cli` — $0. One SQLite + FTS5 store remembers every session. Hand the same conversation off between TUI, Slack, Discord, Telegram, Matrix, Email, and Voice.

[![npm](https://img.shields.io/npm/v/lazyclaw.svg)](https://www.npmjs.com/package/lazyclaw)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-blue.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

```bash
npx lazyclaw onboard   # 15 seconds to a working CLI
```

<img src="docs/screenshots/help.png" alt="lazyclaw subcommand reference" width="820">

*한국어: [README.ko.md](./README.ko.md)*

---

## Why lazyclaw

Four things no other terminal agent CLI does together:

1. **Split chat and trainer providers.** Pay-per-token for chat, $0 subscription for the learning loop. Or vice versa.
2. **Recall across every CLI.** One FTS5 index over sessions, skills, trajectories, and memory.
3. **Cross-channel handoff.** `/handoff slack <channel-id>` moves the live conversation; context follows.
4. **Six sandbox backends, one API.** `local` / `docker` / `ssh` / `singularity` / `modal` / `daytona`.

## Known limitations (v5.1 roadmap)

Calibrate expectations before reading the rest:

- `recall` is callable from inside chat today; the top-level `lazyclaw recall ...` CLI shape ships in v5.1.
- `lazyclaw sandbox` exposes `list | test | add | use`; the `sandbox run --backend ...` shape lands in v5.1.
- `codex-cli` and `gemini-cli` provider modules are tracked but not yet registered in the main runtime.
- E2E matrix ships with 32 of 48 flows marked `test.skip` pending v5.1 wiring; the min-green-set is documented in `tests/e2e/phaseH-e2e-matrix.spec.ts`.

## Install

```bash
# Try it (no install)
npx lazyclaw onboard && lazyclaw chat

# Keep it
npm install -g lazyclaw

# Hack on it
git clone https://github.com/cmblir/lazyclaw && cd lazyclaw
npm install && npm link
```

```bash
lazyclaw version
# → { "version": "5.0.0", "nodeVersion": "v20.11.0", "platform": "darwin" }
```

Requires **Node 18+**. macOS / Linux / WSL are first-class. Native PowerShell runs but ghost-text and the ANSI banner fall back to plain prompts.

## First run

```bash
lazyclaw onboard         # arrow-key picker; defaults to claude-cli (no key)
# → writes ~/.lazyclaw/config.json
```

<img src="docs/screenshots/onboard.png" alt="lazyclaw onboard --non-interactive" width="720">

```bash
lazyclaw status          # → { provider, model, hasApiKey }
lazyclaw doctor          # validates config + provider registry + index.db
```

Move the config dir with `LAZYCLAW_CONFIG_DIR=/elsewhere`. For automation, add `--non-interactive --provider X --model Y [--api-key Z]`.

## The trainer split — $0 learning on your Claude Pro subscription

v5 separates two provider slots in your config: `provider` (chat — the hot path) and `trainer.provider` (skill synthesis, user-model updates, reflection — bursty, cheap). They are wired independently, so a Pro/Max subscription can power the learning loop while chat runs through any provider, paid or local. lazyclaw is the **only** terminal agent CLI that splits these two roles.

```jsonc
// ~/.lazyclaw/config.json
{
  "provider": "openai",                  // chat: pay-per-token
  "model": "gpt-4.1",
  "trainer": {
    "provider": "claude-cli",            // trainer: $0 on Pro/Max
    "model": "claude-haiku-4-5",
    "schedule": "nightly",
    "budget": { "maxCallsPerDay": 200, "usdPerDay": 0.50 }
  }
}
```

The canonical default is `trainer.provider = "auto"` — resolves to `claude-cli` when a Pro/Max session is detected, else mirrors the chat provider.

**Three configs covering the common cases:**

| Setup | `provider` | `trainer.provider` | Cost |
|---|---|---|---|
| Subscription only | `claude-cli` | `claude-cli` | $0 |
| Hybrid (recommended) | `openai` / any | `claude-cli` | chat-only |
| Pure API | `openai` / any | `openai` / any | both metered |

Full JSONC examples and the `auto` resolution rules: [docs/trainer-recipes.md](./docs/trainer-recipes.md).

## Provider matrix

| Chat provider | Trainer provider | Auth |
|---|---|---|
| `claude-cli` | `claude-cli` | subscription (Pro/Max) |
| `anthropic` | `anthropic` | API key |
| `openai` | `openai` | API key |
| `gemini` | `gemini` | API key |
| `ollama` | `ollama` | local (no key) |
| `nim` / `openrouter` / `groq` / `together` / `xai` / `deepseek` / `mistral` / `fireworks` | — | API key (OpenAI-compatible) |

Plus two meta-providers, usable in either slot:
- `orchestrator` — composes any of the above into a multi-agent pipeline ([docs/multi-agent.md](./docs/multi-agent.md))
- `custom` — any OpenAI-compatible v1 endpoint with your own base URL + key

<img src="docs/screenshots/providers.png" alt="lazyclaw providers info — model list + capabilities" width="720">

## What it ships

### Around 50 tools plus MCP
A unified registry covers fs, exec, web, os, coding, git (5 read + 2 sensitive), scheduling, delegation, media, ha, clarify, browser, and learning groups. Sensitive tools route through an approval hook. Bring external servers in over stdio MCP.

### Channels that hand off
First-class channels for Slack, Discord, Telegram, Matrix, Email, and Voice. Signal and WhatsApp ship as full implementations with external runtime dependencies (`signal-cli` for Signal; `whatsapp-web.js` browser automation with QR-on-first-run for WhatsApp). Move a live conversation between any two with `/handoff <target> <externalId>` — no other agent CLI does cross-channel handoff.

```bash
lazyclaw channels install @lazyclaw/channel-discord
# inside Slack:   /handoff discord <channel-id>
# inside Discord: /handoff tui <thread-id>
```

Slack is built-in and does not need `channels install`. The plugin loader expects `@lazyclaw/channel-<name>` npm package names.

### Personas that compose
Swap personality per channel without losing session memory. Layers compose top-down: global SOUL → workspace SOUL → active personality → agent role → user model (USER.md) → skill bank → memory core → recent trajectory tail. See [docs/persona-cookbook.md](./docs/persona-cookbook.md).

### Loops and scheduled goals
Durable foreground or `--detach` loops; cron-scheduled goals with channel fan-out. State lives in `~/.lazyclaw/loops/<id>/` and survives restart. See [docs/loop-goal-preflight.md](./docs/loop-goal-preflight.md).

### A TUI that ghosts the right answer
Ink-based UI with two-column splash, sloth ASCII banner, Cursor-style ghost autocomplete (`→` accepts, `Tab` cycles), interrupt-and-redirect REPL, multiline editor, and a fixed 4-line footer with live cost rate cards.

## Command reference

| Command | Purpose |
|---|---|
| `lazyclaw` | Interactive menu; type a slash command or pick a subcommand |
| `lazyclaw onboard` | Arrow-key setup; writes `~/.lazyclaw/config.json` |
| `lazyclaw status` | Print active provider / model / masked key |
| `lazyclaw doctor` | Validate config, provider registry, FTS5 index |
| `lazyclaw chat` | Interactive REPL with ghost autocomplete + slash commands |
| `lazyclaw agent "<prompt>"` | One-shot generate; supports stdin |
| `lazyclaw run \| resume \| inspect` | DAG / sequential / persistent workflow jobs (`--dir <state-dir>`) |
| `lazyclaw config get\|set\|list\|edit\|validate` | Dotted-key config access |
| `lazyclaw sandbox list\|test\|add\|use` | Manage sandbox backends |
| `lazyclaw channels install\|list\|remove` | Channel plugin lifecycle (`@lazyclaw/channel-<name>`) |
| `lazyclaw trajectories export --format ...` | Export to atropos / axolotl / openai-ft / jsonl |
| `lazyclaw personality use\|list\|show` | Activate / inspect personas |
| `lazyclaw migrate v5` | v4 → v5 with backup |
| `lazyclaw version` / `lazyclaw help` | Version + subcommand help |

In-REPL slash commands include `/help`, `/status`, `/provider`, `/model`, `/skill`, `/loop`, `/goal`, `/memory`, `/agent`, `/team`, `/handoff`, `/personality`, `/exit`. Depth lives in `lazyclaw <cmd> --help` and the docs below.

## Migrating from v4

> [!IMPORTANT]
> `lazyclaw migrate v5` backs up your existing `~/.lazyclaw/` to `backup-v4-<ts>/` before rewriting anything. Don't skip the backup — the SQLite schema and skill frontmatter both change shape.

- **What changed**: split `trainer` provider block, new `~/.lazyclaw/index.db` (SQLite + FTS5), per-day JSONL trajectory sink, persona file directory, kebab-case provider IDs (`claude-cli`, `gemini-cli`, ...), additive SKILL.md frontmatter (`group`, `trained_by`, `confidence`, `cross_cli_tested`).
- **Migrate**:
  ```bash
  npm install -g lazyclaw@5
  lazyclaw migrate v5
  ```
- **Rollback**: restore `~/.lazyclaw/backup-v4-<ts>/` and `npm install -g lazyclaw@4`.

Full guide: [docs/migration-v4-to-v5.md](./docs/migration-v4-to-v5.md).

## CLI vs Channels — quick reference

| Capability | TUI | Slack / Discord / Telegram |
|---|---|---|
| Start a chat | `lazyclaw chat` | `@lazyclaw <message>` |
| Hand off to another surface | `/handoff slack <channel-id>` | `/handoff tui <thread-id>` |
| Recall across history | `/recall "<query>"` inside chat (top-level CLI v5.1) | `/recall "<query>"` inside chat |
| Switch persona | `/personality use terse` | `/personality use terse` |
| Switch model | `/model <name>` | `/model <name>` |
| Show status | `lazyclaw status` | `@lazyclaw status` |

Channel plugins implement a shared `channels/base.mjs` contract, so the surface you address them through is interchangeable.

## Configuration

```jsonc
// ~/.lazyclaw/config.json
{
  "provider": "claude-cli",
  "model": "claude-opus-4-7",
  "trainer": {
    "provider": "auto",                  // "auto" | claude-cli | anthropic | openai | gemini | ollama
    "model": "claude-haiku-4-5",
    "schedule": "nightly",
    "budget": { "maxCallsPerDay": 200, "usdPerDay": 0.50 }
  },
  "sandbox": { "backend": "local" },     // local | docker | ssh | singularity | modal | daytona
  "channels": { "slack": { "enabled": true } },
  "persona": { "active": "default" },
  "orchestra": { "learning": { "crossCliDampenFactor": 0.85 } }
}
```

Override the config directory with `LAZYCLAW_CONFIG_DIR=/path`. Workflow state moves with `LAZYCLAW_WORKFLOW_STATE_DIR=/path`. Channel tokens live exclusively in `~/.lazyclaw/.env`. Full schema in `lazyclaw config --help` and the docs.

## Security and privacy

> [!WARNING]
> **`~/.lazyclaw/config.json` is trusted code.** Values resolved with `$(...)` execute at config load. Treat the file like a shell rc — never paste an untrusted snippet without reading it first.

- **Trainer transcripts stay local.** Skill synthesis and user-model writes go through your configured trainer provider only; there is no hosted lazyclaw service.
- **Sandbox backends enforce different blast radii.** `local` runs as you; `docker` / `singularity` / `daytona` isolate; `ssh` / `modal` move execution off-host. Pick per task.
- **Secrets are redacted** from trajectories and synthesised skills (`sk-...`, `ghp_...`, `AKIA...`, bearer tokens, `*_KEY=...`, PEM blocks). Channel tokens live in `~/.lazyclaw/.env` and are never logged.

## Documentation

- [docs/migration-v4-to-v5.md](./docs/migration-v4-to-v5.md) — full v4 → v5 walkthrough + rollback
- [docs/trainer-recipes.md](./docs/trainer-recipes.md) — $0, hybrid, offline, and `auto` trainer configs
- [docs/persona-cookbook.md](./docs/persona-cookbook.md) — layered persona compose stack + skin import
- [docs/multi-agent.md](./docs/multi-agent.md) — orchestrator pipeline + Slack team data model
- [docs/loop-goal-preflight.md](./docs/loop-goal-preflight.md) — durable loops and cron-scheduled goals
- [docs/agent-memory.md](./docs/agent-memory.md) — per-agent memory, reflection, and skill synthesis
- [CHANGELOG.md](./CHANGELOG.md) — release notes (Keep a Changelog)
- [README.ko.md](./README.ko.md) — Korean companion

## Community

Source and issues: [cmblir/lazyclaw](https://github.com/cmblir/lazyclaw). PRs welcome.

## License

[MIT](./LICENSE)
