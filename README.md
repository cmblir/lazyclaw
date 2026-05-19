# 🦞 lazyclaw

[![npm](https://img.shields.io/npm/v/lazyclaw.svg)](https://www.npmjs.com/package/lazyclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-blue.svg)](https://nodejs.org/)

**A lazy, elegant terminal CLI for Claude / OpenAI / Gemini / Ollama.**

One Node CLI that talks to every major LLM provider, runs multi-step workflows as a DAG, exposes a local HTTP gateway, and ships with the niceties you actually want at the prompt: an ASCII banner on launch, Cursor-style slash-command ghost autocomplete (right-arrow accepts), persistent chat sessions, and cost rate cards.

> Standalone CLI. A companion dashboard, [LazyClaude](https://github.com/cmblir/LazyClaude), wraps the same providers in a web UI — but `lazyclaw` needs nothing from it: `npm i -g lazyclaw` and go.

Every subcommand at a glance — `lazyclaw --help`:

<img src="docs/screenshots/help.png" alt="lazyclaw --help — full subcommand reference" width="760">

---

## Install

```bash
npm install -g lazyclaw
lazyclaw version
```

Requires **Node 18+**. Works on macOS / Linux / WSL. Windows native PowerShell mostly works but the ghost-text + ANSI banner are TTY-gated and may fall back to plain prompts.

## First run

```bash
lazyclaw onboard         # arrow-key picker; defaults to claude-cli (no key)
lazyclaw status          # current provider/model + masked key
lazyclaw doctor          # validate config + provider registry
```

`onboard` writes `~/.lazyclaw/config.json`. Move it with `LAZYCLAW_CONFIG_DIR=/elsewhere`. For automation: `--non-interactive --provider X --model Y [--api-key Z]`.

<img src="docs/screenshots/onboard.png" alt="lazyclaw onboard --non-interactive — writes config.json, prints JSON result" width="760">

<img src="docs/screenshots/doctor.png" alt="lazyclaw doctor — config + provider registry health check" width="760">

### Subscription mode (no API key)

If you already have **Claude Code** installed and signed in (Pro / Max / Team subscription), pick the **`claude-cli`** provider during onboard. lazyclaw shells out to the local `claude` binary, so requests bill against your existing subscription quota instead of pay-per-token API credit. No `sk-ant-` key needed.

```bash
lazyclaw onboard --non-interactive --provider claude-cli --model claude-opus-4-7
lazyclaw status
# → { provider: "claude-cli", model: "claude-opus-4-7", hasApiKey: false }
```

Same flow for `ollama` (local models, also keyless).

### Pay-per-token mode (API key)

Pick `anthropic` / `openai` / `gemini` and supply the matching key:

```bash
lazyclaw onboard --non-interactive --provider openai \
  --model gpt-4.1 --api-key sk-...
```

`onboard` only prompts for an api-key when the picked provider's `requiresApiKey` is true (the picker labels each row `[subscription]` / `[api key]` / `[no key]` so the choice is explicit).

### Built-in OpenAI-compatible vendors

Eight popular OpenAI-compatible services ship as first-class providers — pick one in the setup picker (no `+ Add custom` walkthrough needed) or set the matching environment variable and they Just Work:

| Provider | Models include | Env var |
|---|---|---|
| `nim`        | `meta/llama-3.1-405b-instruct`, `nvidia/llama-3.1-nemotron-70b-instruct`, `deepseek-ai/deepseek-r1`, `mistralai/mixtral-8x22b-instruct-v0.1` | `NVIDIA_API_KEY` (or `NIM_API_KEY`) |
| `openrouter` | `anthropic/claude-3.5-sonnet`, `openai/gpt-4o`, `meta-llama/llama-3.1-405b-instruct`, `deepseek/deepseek-r1` | `OPENROUTER_API_KEY` |
| `groq`       | `llama-3.3-70b-versatile`, `mixtral-8x7b-32768`, `deepseek-r1-distill-llama-70b` | `GROQ_API_KEY` |
| `together`   | `meta-llama/Llama-3.3-70B-Instruct-Turbo`, `Qwen/Qwen2.5-72B-Instruct-Turbo`, `deepseek-ai/DeepSeek-V3` | `TOGETHER_API_KEY` |
| `xai`        | `grok-2-latest`, `grok-2-vision-1212` | `XAI_API_KEY` (or `GROK_API_KEY`) |
| `deepseek`   | `deepseek-chat`, `deepseek-reasoner` | `DEEPSEEK_API_KEY` |
| `mistral`    | `mistral-large-latest`, `codestral-latest`, `pixtral-large-latest` | `MISTRAL_API_KEY` |
| `fireworks`  | `accounts/fireworks/models/llama-v3p3-70b-instruct`, `…/deepseek-r1` | `FIREWORKS_API_KEY` |

```bash
# NVIDIA NIM via env var — no `lazyclaw onboard` needed
export NVIDIA_API_KEY=nvapi-...
lazyclaw chat --provider nim --model meta/llama-3.1-405b-instruct

# Or commit the choice to ~/.lazyclaw/config.json
lazyclaw onboard --non-interactive --provider nim \
  --model nvidia/llama-3.1-nemotron-70b-instruct --api-key nvapi-...
```

Need a vendor that's **not** built-in? `+ Add a custom OpenAI-compatible endpoint…` inside the setup picker (or `lazyclaw providers add <name> --base-url <url>`) still works for vLLM / LM Studio / private gateways / anything else that speaks the OpenAI v1 wire format.

### `orchestrator` — multi-agent dispatch as a provider

`orchestrator` is a synthetic provider that composes the others. A chat message hitting `PROVIDERS.orchestrator` triggers a three-phase pipeline instead of a single 1:1 call:

1. **PLAN** — the *planner* provider decomposes the request into 2–5 parallel subtasks (JSON-only system prompt; fences / prose tolerated).
2. **EXECUTE** — each subtask is dispatched round-robin across the *workers*. Replies stream inline so you watch progress in real time.
3. **SYNTHESIS** — the planner re-enters with every worker's output and writes the final user-facing answer.

Configure in `~/.lazyclaw/config.json`:

```json
{
  "provider": "orchestrator",
  "orchestrator": {
    "planner": "claude-cli:claude-opus-4-7",
    "workers": [
      "claude-cli:claude-sonnet-4-6",
      "openai:gpt-4o",
      "gemini:gemini-2.5-pro",
      "nim:meta/llama-3.1-405b-instruct"
    ],
    "maxSubtasks": 5
  }
}
```

Then `lazyclaw chat` (or any other entry point that ends up calling a provider — `lazyclaw agent`, the daemon's `POST /agent` / `POST /chat`, the dashboard chat tab) routes through the orchestrator. Each worker's api-key is resolved through the same chain a direct chat would use (`authProfiles` → `customProviders` → built-in env var → legacy `cfg['api-key']`).

Defaults fall back gracefully: `planner` defaults to `cfg.provider`/`cfg.model`, `workers` defaults to `[planner]` (single-agent chain, still benefits from plan + synthesis structure). Self-recursion (`planner: "orchestrator"`) is rejected up front.

You can skip the JSON entirely and configure via `lazyclaw onboard` / `lazyclaw setup` (the picker lands on the orchestrator and walks you through a planner + workers wizard) **or** via the dedicated CLI:

```bash
lazyclaw orchestrator status
lazyclaw orchestrator set-planner claude-cli:claude-opus-4-7
lazyclaw orchestrator workers add openai:gpt-4o
lazyclaw orchestrator workers add gemini:gemini-2.5-pro
lazyclaw orchestrator workers set claude-cli:claude-sonnet-4-6,nim:meta/llama-3.1-405b-instruct   # bulk replace
lazyclaw orchestrator set-max-subtasks 5
lazyclaw orchestrator clear                                                                       # wipe cfg.orchestrator
lazyclaw config set provider orchestrator                                                          # route chats through it
```

## Launcher (no-arg `lazyclaw`)

Running `lazyclaw` with no subcommand drops into an arrow-key launcher with every subcommand laid out as a menu. Navigation:

| Key | What it does |
|---|---|
| `↑` / `↓` / `Home` / `End` / `PgUp` / `PgDn` | Move the selection |
| `Enter` | Run the highlighted item |
| `q` / `Esc` / `Ctrl-C` | Leave lazyclaw |
| `/` | Open an inline slash-command prompt |

Slash commands at the launcher (typed after `/`):

| Slash | What it does |
|---|---|
| `/exit` / `/quit` | Leave lazyclaw |
| `/help` | List launcher slash commands inline |
| `/version` | Print version + node + platform |

The slash buffer lives just below the menu — backspace edits it, deleting past `/` returns to menu mode, and `Esc` cancels slash mode without leaving lazyclaw.

## Interactive chat

```bash
lazyclaw chat                      # banner + active provider/model + REPL
lazyclaw chat --pick               # arrow-key picker before the prompt
lazyclaw chat --session daily      # persist turns to ~/.lazyclaw/sessions/daily.jsonl
lazyclaw chat --skill review,style # compose named skills as the system prompt
```

What you see on launch (TTY only):

```text
  ╭──────────────────────────────╮
  │   _                          │
  │  | |__ _ _____  _ _          │
  │  | / _` |_ / || | '_|         │
  │  |_\__,_/__\_, |_|            │
  │  LazyClaw  |__/  3.99.11     │
  ╰──────────────────────────────╯

  provider · anthropic
  model    · claude-opus-4-7
  slash    · /help · /model · /provider · /exit
  hint     · → to accept the suggested command, Tab to cycle

›
```

Slash commands inside the REPL:

| Slash | What it does |
|---|---|
| `/help` | List slash commands |
| `/status` | Print provider + model + masked key |
| `/provider` | Open the family / provider / model arrow picker |
| `/provider X` | Switch active provider directly by name |
| `/model` | Open the per-provider model picker (type-filter + live `/v1/models` fetch) |
| `/model X` | Switch model directly. Accepts unified `provider/model` form |
| `/skill a,b` | Replace the system prompt with a composition of named skills |
| `/loop "<prompt>" [--max N] [--until "<regex>"]` | Repeat one prompt N times (default 3, cap 50). `--until` short-circuits when the regex matches. Ctrl-C aborts the loop. |
| `/loop "..." --use-memory --recall "<query>"` | Inject `~/.lazyclaw/memory/core.md` and the top-3 matching episodic/recent fragments into the system slot per iteration |
| `/goal` | List active goals |
| `/goal <name>` | Switch the chat to the goal's session (subsequent turns persist to `goal:<name>.jsonl`) |
| `/goal add <name> [--desc "..."] [--cron "<spec>"]` | Register a persistent goal; `--cron` schedules `lazyclaw goal tick <name>` |
| `/goal close <name> [done\|abandoned]` | Close the goal and uninstall its cron entry |
| `/memory [core\|recent\|episodic [topic]]` | Show layered memory contents |
| `/dream` | Consolidate `recent.jsonl` into per-topic `episodic/<topic>.md` files |
| `/agent` / `/agent list` | List registered multi-agent agents |
| `/agent show <name>` | Print the agent's JSON record |
| `/agent add <name> [role text…]` | Register an agent with the default tool whitelist `[bash, read, write, grep]` |
| `/agent remove <name>` | Delete the agent's record |
| `/team` / `/team list` | List teams + lead + members + Slack channel |
| `/team add <name> --agents a,b,c [--lead a] [--channel #x]` | Create a team |
| `/team remove <name>` | Delete the team |
| `/usage` | Message count + chars + cumulative token totals |
| `/new` / `/reset` | Wipe history and start over |
| `/exit` | Leave the chat REPL (returns to the launcher when chat was opened from it) |

**Cursor-style ghost autocomplete**: type `/` and the longest matching slash command appears in dim grey after the cursor. **`→`** accepts; **`Tab`** cycles. **Ctrl-C** during a streaming reply aborts that turn (not the whole process); **Ctrl-C** at an empty prompt exits.

## One-shot (no REPL)

```bash
lazyclaw agent "summarize: $(cat file.md)"
lazyclaw agent - < prompt.txt                 # stdin
lazyclaw agent "..." --provider openai --model gpt-4.1
lazyclaw agent "..." --skill review           # compose system prompt
lazyclaw agent "..." --usage                  # token counts on stderr
lazyclaw agent "..." --cost                   # USD when rates configured
```

## Loops and goals (durable agents)

```bash
# Repeat one prompt N times against the active provider. Foreground
# blocks the terminal; --detach forks a worker and prints {loopId,
# pid, statePath}. Worker state under ~/.lazyclaw/loops/<id>/.
lazyclaw loop "fix the failing tests" --max 5 --until "DONE"
lazyclaw loop "ship checklist" --max 10 --detach --session daily
lazyclaw loops list
lazyclaw loops show <loopId>
lazyclaw loops tail <loopId>
lazyclaw loops kill <loopId>      # SIGTERM; repeat within 5s for SIGKILL

# Goals: persistent objectives with optional cron schedule + channel fan-out.
lazyclaw goal add ship-v4 --desc "Ship v4" --cron "0 9 * * 1-5"
lazyclaw goal list
lazyclaw goal tick ship-v4 --force
lazyclaw goal channel add ship-v4 slack:#deploys
lazyclaw goal close ship-v4 done  # also uninstalls the cron entry

# Memory: ~/.lazyclaw/memory/{core.md,recent.jsonl,episodic/*.md}
lazyclaw memory show core
lazyclaw memory show recent
lazyclaw memory dream             # consolidate recent → episodic files
lazyclaw memory edit core         # open $EDITOR
```

For Slack fan-out, set `SLACK_BOT_TOKEN` (xoxb-...) in `~/.lazyclaw/.env`.
Tokens never appear in goal records or logs. Socket Mode inbound also
needs `SLACK_APP_TOKEN` (xapp-...) and `SLACK_SIGNING_SECRET`.

## Multi-agent Slack teams (v4.1)

Drive a small team of named agents through a single Slack thread. The
lead agent receives the user's request, decides who else on the team
should weigh in, `@mentions` them, and the router runs each mentioned
agent in turn through the full tool-use loop (bash / read / write /
grep) before handing control back. The thread terminates when the lead
emits the literal marker `[[TASK_DONE]]` or the per-task iteration
budget runs out. Each agent's reply is mirrored into the Slack thread
under its own persona (`chat:write.customize` makes the username + icon
match the agent in Slack's UI).

```bash
# 1) Register agents — system prompt + provider + per-agent tool whitelist
lazyclaw agent add planner  --role "Project planner"   --provider anthropic --model claude-opus-4-7
lazyclaw agent add backend  --role "Backend engineer"  --provider anthropic --model claude-opus-4-7
lazyclaw agent add frontend --role "Frontend engineer" --provider openai    --model gpt-4.1
lazyclaw agent list

# 2) Group them into a team that talks in a specific Slack channel
lazyclaw team add shop --agents planner,backend,frontend --lead planner --channel '#shop'

# 3) Open a task — posts a root message into the team's channel, returns
#    the task id and the Slack thread_ts.
lazyclaw task start --team shop --title "ship checkout flow" --description "MVP scope"

# 4) Drive one user turn through the mention router. The lead replies,
#    @mentions teammates, they run tool-use loops, hand back to the lead.
lazyclaw task tick t_20260518_xxxxxx "go" --max-turns 12

# 5) Inspect the conversation (text, markdown, or raw JSON)
lazyclaw task transcript t_20260518_xxxxxx --format md > thread.md
lazyclaw task show       t_20260518_xxxxxx
lazyclaw task done       t_20260518_xxxxxx   # or `abandon` — also posts a closing message
```

Slack inbound (a user pings `@lazyclaw` in a channel, the bot replies)
runs through the Socket Mode listener:

```bash
lazyclaw slack listen     # foreground; connects, reacts with :eyes:, replies in thread
```

The CLI is mirrored by daemon HTTP routes (`GET/POST/PATCH/DELETE
/agents|teams|tasks`, `GET /tasks/<id>/transcript`) and by the
browser dashboard's Agents / Teams / Tasks tabs:

```bash
lazyclaw dashboard       # opens http://127.0.0.1:<port>/ in the default browser
```

Slack app prerequisites — bot token scopes `app_mentions:read`,
`chat:write`, `chat:write.customize`, `im:history`, `im:read`,
`im:write`, `channels:history`, `reactions:write`; Socket Mode enabled;
app token scope `connections:write`; invite the bot into every team
channel. Tokens live exclusively in `~/.lazyclaw/.env` and never appear
in agent/team/task records or logs.

For the full data model + phase plan, see `docs/multi-agent.md`.

## Providers / sessions / skills

```bash
lazyclaw providers list                       # all registered providers
lazyclaw providers info anthropic
lazyclaw providers test anthropic             # 1-token reachability probe

lazyclaw sessions list                        # persisted chats
lazyclaw sessions show daily
lazyclaw sessions search "deploy"
lazyclaw sessions export daily > daily.md
lazyclaw sessions clear daily

lazyclaw skills list                          # markdown skill bundles
lazyclaw skills show review
lazyclaw skills install ./my-skill.md
lazyclaw skills remove review
```

<img src="docs/screenshots/providers.png" alt="lazyclaw providers info anthropic — model list + capabilities" width="760">

## Workflows (DAG / sequential / persistent)

```bash
lazyclaw run my-job ./flow.mjs                              # sequential, resumable
lazyclaw run my-job ./flow.mjs --parallel --concurrency 4   # in-memory DAG
lazyclaw run my-job ./flow.mjs --parallel-persistent        # DAG + checkpoints
lazyclaw resume my-job ./flow.mjs                           # resume a stalled run

lazyclaw inspect                                            # list every session
lazyclaw inspect my-job --summary
lazyclaw inspect my-job --critical-path ./flow.mjs          # bottleneck finder
lazyclaw inspect my-job --slowest 5
```

State at `./.workflow-state/<id>/` (override with `LAZYCLAW_WORKFLOW_STATE_DIR=...`).

## Local HTTP gateway

```bash
lazyclaw daemon                               # bind a free port; prints { port, url }
lazyclaw daemon --port 19600
lazyclaw daemon --auth-token $(openssl rand -hex 16)
lazyclaw daemon --rate-limit 60 --log info    # 60 req/min/IP, JSON access logs
lazyclaw daemon --once                        # serve a single request, then exit
```

## Cost rate cards

```bash
lazyclaw rates list
lazyclaw rates set anthropic/claude-opus-4-7 \
  --in 15 --out 75 --cache-read 1.5 --cache-create 18.75
lazyclaw rates copy anthropic/claude-opus-4-7 anthropic/claude-opus-4-6
lazyclaw rates delete openai/gpt-3.5-turbo
lazyclaw rates validate
```

`/usage` and `--cost` use these to compute USD totals locally — no provider call.

## Config + bundles

```bash
lazyclaw config path                          # → ~/.lazyclaw/config.json
lazyclaw config get provider
lazyclaw config set provider openai
lazyclaw config list
lazyclaw config edit                          # opens $EDITOR
lazyclaw config validate

lazyclaw export > backup.json                 # config + skills (+ optional sessions)
lazyclaw import --from backup.json
```

## Shell completion

```bash
lazyclaw completion bash >> ~/.bashrc
lazyclaw completion zsh  >> ~/.zshrc
```

## File locations

| Path | Purpose |
|---|---|
| `~/.lazyclaw/config.json` | provider, model, api-key, skills, rates |
| `~/.lazyclaw/sessions/*.jsonl` | persisted chat sessions |
| `~/.lazyclaw/skills/*.md` | installed skill bundles |
| `./.workflow-state/<id>/` | per-session workflow checkpoints (cwd-relative) |

`LAZYCLAW_CONFIG_DIR=...` moves the first three; `LAZYCLAW_WORKFLOW_STATE_DIR=...` moves the last.

---

## Issues / contributing

Source lives in [cmblir/lazyclaw](https://github.com/cmblir/lazyclaw). Issues and PRs welcome.

## License

[MIT](./LICENSE)
