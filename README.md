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

## What's new in 5.0.x

The 5.0.3 → 5.0.9 maintenance line is mostly a launcher and splash overhaul. `lazyclaw` with no arguments now drops you straight into chat — the arrow-key picker has moved to `lazyclaw menu`. The splash itself is responsive: a Larry-3D gradient wordmark, braille-rendered sloth hero, a tool catalog driven by `mas/tools/registry.mjs` (no more hand-edited lists), grouped skills, and a Hermes-style status bar that auto-collapses to a single column on narrow terminals.

Per-release notes live in [CHANGELOG.md](./CHANGELOG.md).

## Known limitations (v5.1 roadmap)

Calibrate expectations before reading the rest:

- Recall today is reachable via `lazyclaw loop --recall "<query>" ...` and `lazyclaw goal ... --recall "<query>"`; the `/recall` slash command and top-level `lazyclaw recall ...` CLI shape both ship in v5.1.
- `lazyclaw sandbox` exposes `list | test | add | use`; the `sandbox run --backend ...` shape lands in v5.1.
- `codex-cli` and `gemini-cli` provider modules are tracked but not yet registered in the main runtime.
- The E2E matrix in `tests/e2e/phaseH-e2e-matrix.spec.ts` still has a number of flows marked `test.skip` pending v5.1 wiring; the min-green-set is documented at the top of that file.

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
```

Output reports the current installed version, Node version, and platform. See [CHANGELOG.md](./CHANGELOG.md) for release notes.

Requires **Node 18+**. macOS / Linux / WSL are first-class. Native PowerShell runs but ghost-text and the ANSI banner fall back to plain prompts.

## First run

```bash
lazyclaw onboard         # arrow-key picker; defaults to claude-cli (no key)
# → writes ~/.lazyclaw/config.json
```

<img src="docs/screenshots/onboard.png" alt="lazyclaw onboard --non-interactive" width="720">

```bash
lazyclaw                 # no-arg → chat (since v5.0.6)
lazyclaw menu            # arrow-key launcher (formerly the no-arg default)
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

### Tool registry — 12 categories plus MCP

A single registry (`mas/tools/registry.mjs`) aggregates every first-party tool across twelve categories:

`agents` · `browser` · `coding` · `exec` · `fs` · `git` · `iot` · `learning` · `media` · `net` · `os` · `scheduling`

Tools flagged `sensitive: true` (writes, network egress, shell exec, sensitive git ops) route through an approval hook before execution. The splash renderer, the agent toolset resolver, and the runtime all read from the same registry, so a new tool group lights up everywhere at once. External servers extend the registry over stdio MCP.

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

Ink-based UI with a responsive splash (Larry-3D gradient wordmark, sloth braille hero, grouped subcommand catalog, registry-backed tool list, filename-grouped skills, Hermes-style status bar — auto-collapses to single-column on narrow terminals), Cursor-style ghost autocomplete (`→` accepts, `Tab` cycles), interrupt-and-redirect REPL, and multiline editor.

## Command reference

| Command | Purpose |
|---|---|
| `lazyclaw` | No-arg → drops into chat (since v5.0.6) |
| `lazyclaw menu` | Arrow-key launcher (formerly the no-arg default) |
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
| `lazyclaw dashboard` | Local web UI on `127.0.0.1:19600` |
| `lazyclaw migrate v5` | v4 → v5 with backup |
| `lazyclaw recall` | (v5.1) Top-level recall over the FTS5 index — today, use `loop`/`goal` with `--recall "<query>"` |
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
| Recall across history | `lazyclaw loop --recall "<query>" ...` (slash + top-level v5.1) | `lazyclaw loop --recall "<query>" ...` (channel-side `/recall` v5.1) |
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
