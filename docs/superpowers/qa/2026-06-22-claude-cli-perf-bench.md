# claude-cli performance benchmark — 2026-06-22

Multi-sample latency / token / cost measurement of lazyclaw's `claude` CLI
provider path, produced by `scripts/bench-claude-cli.mjs` (`npm run
test:bench:cli`). Every figure is a **median + p95 + stdev over N samples** —
a single end-to-end turn is model/network-dominated with seconds of run-to-run
noise, so single-sample comparisons are meaningless (an earlier single sample
even showed lean *slower* than non-lean — pure noise).

> Honesty note: this round **re-verified, and in places corrected, prior
> assumptions** (see "Corrections" below). Notably the often-quoted "lean vs
> non-lean = ~1200× fewer input tokens" did **not** reproduce on the current
> CLI; the real lean win is a different, smaller, environment-dependent effect.

## TL;DR

- **Latency is model-dominated.** For a single-turn reply, claude's own
  self-reported API round-trip (`duration_api_ms`) is the bulk of the wall
  time; the lazyclaw + Claude-Code non-API residual (spawn + boot + parse) is
  the small, controllable slice. lazyclaw cannot make the model think faster.
- **The bounded-loop default (`--max-turns 1`) is the biggest controllable
  win.** A single tool-using prompt left unbounded turns into a multi-turn,
  tens-of-seconds, multi-cent autonomous run; bounding it keeps a plain chat
  completion fast and cheap. (See the bounded-vs-unbounded numbers.)
- **The persistent warm session amortizes boot LATENCY (not cost):** turn 2
  (warm) is materially faster than turn 1, but it costs slightly *more* per turn
  as the conversation accumulates — the win is speed, not spend.
- **Lean mode's win is real but environment-dependent and modest on this
  machine** — it skips the user's global `CLAUDE.md` + MCP boot, which here is
  ~13.5k cached tokens + one MCP server, not the "~180k tokens" an older note
  assumed. It scales with how heavy the operator's config is.
- The deterministic, model-independent facts (token *structure*, turn counts)
  are the defensible evidence; the absolute ms/$ are **haiku-only**.

## How to reproduce

```bash
# all conditions, 10 samples each (unbounded: 3), model pinned to haiku
MODEL=haiku npm run test:bench:cli

# a single condition, custom sample count, write JSON
MODEL=haiku CONDITIONS=lean N=10 OUT=/tmp/lean.json npm run test:bench:cli
```

Env knobs: `N` (default 10), `N_UNBOUNDED` (3), `MODEL` (''=account default),
`PROMPT`, `TOOL_PROMPT`, `CONDITIONS` (comma list: lean,nonlean,bounded,
unbounded,persistent), `OUT` (JSON path), `WARMUP` (1; set 0 to skip),
`ONESHOT_TIMEOUT_MS` (90000), `UNBOUNDED_TIMEOUT_MS` (240000), `BIN`.

The deterministic core (stream decomposition, N-sample stats, table rendering)
is unit-tested with a fake stream + fake clock and a quota-free fake `claude`
fixture — `node --test tests/bench_stats.test.mjs tests/bench_claude_cli.test.mjs`
— so the harness is gate-protected without spending a subscription turn.

## Methodology

### Conditions

| condition | what it isolates | how |
|---|---|---|
| **lean** one-shot | lazyclaw's default chat path | `claude -p … --setting-sources '' --strict-mcp-config --max-turns 1 --tools ''` |
| **non-lean** one-shot | cost of inheriting the full Claude Code env | same, **without** the lean flags (loads user `CLAUDE.md` + MCP) |
| **persistent** turn 1 vs turn 2 | warm-session boot amortization | one `--input-format stream-json` session reused for two turns |
| **bounded** vs **unbounded** + tools | the `--max-turns` runaway guard | identical toolset (`Read,Grep,Glob`) + tool-inducing prompt; only `--max-turns` differs (1 vs 12) |

All conditions share `MODEL=haiku` so the model is a constant, not a variable.
Each condition runs a discarded warm-up first (primes the prompt cache), then N
sequential samples (sequential is required — concurrent real calls would
contend and distort the very latency being measured). The one-shot argv is the
provider's own `buildArgs()`, so the measured command is the command lazyclaw
actually runs.

### Metrics

- **wallMs** — external wall clock: process spawn → stream end (spawn + Claude
  Code boot + model round-trip + stream parse).
- **ttftMs / genMs** — time to first streamed token / first-token→done.
- **claudeApiMs** — claude's *self-reported* `duration_api_ms`. For a
  single-turn reply this is one API round-trip; for a multi-turn loop it is the
  **sum across turns** and can exceed external wall.
- **non-API residual** — per-sample `median(wallMs − claudeApiMs)` over samples
  where both are finite (a paired difference, with stdev and its honest sign).
  This approximates "everything that is not the model API call": spawn + Claude
  Code boot + MCP boot + stream parse + teardown. **Meaningful only for
  single-turn conditions** (lean / non-lean). lazyclaw's own code is a small
  slice of this residual; the dominant non-lean term is Claude Code's own boot,
  which lean *avoids* rather than something lazyclaw *adds*.
- **inputTokens / cacheCreationTokens / cacheReadTokens / outputTokens** —
  from the `assistant` event(s), **summed across turns** (the live `result`
  event reports zero usage under `--include-partial-messages`, so reading it
  would under-report; verified on claude 2.1.185). For a fixed prompt+config,
  uncached `inputTokens` is deterministic for a fixed cache state (stdev 0
  here); cache and output columns
  vary run-to-run.
- **numTurns / costUsd** — from the `result` event, cumulative over the loop.

### Why multi-sample

End-to-end turn latency carries seconds of variance (model queueing,
occasional API retries, MCP boot). One sample cannot separate signal from
noise, so the harness reports median + p95 + stdev over N and, for tiny N
(unbounded, N=3), **suppresses p95** (a 3-sample type-7 p95 is essentially the
max and conveys no tail information).

## Environment (this machine — what non-lean loads, lean skips)

Captured 2026-06-22 (`~/.claude.json`, `~/.claude/`):

- **MCP servers (top-level):** 1 — `playwright`. (Per-project: 1, unrelated repo.)
  `settings.json enabledMcpjsonServers`: 0.
- **Global instruction files:** `~/.claude/CLAUDE.md` 302 lines / 17.6 KB
  (imports `RTK.md`, 964 B).
- **User skills:** 0 in `~/.claude/skills`.
- Host: darwin-arm64, node v22.22.2, `claude` 2.1.185.

So on this machine non-lean inherits ~17.6 KB of `CLAUDE.md` + one MCP server +
the full Claude-Code agent system prompt — **not** the "~180k tokens / many MCP
servers" worst case an older code comment/memory assumed. The measured per-turn
cache-read delta is ~19.9k tokens (non-lean 33.4k − lean 13.5k); the 17.6 KB
`CLAUDE.md` is only ~4–5k of that, so the MCP server's injected tool schemas +
system-prompt expansion are the larger share, not `CLAUDE.md`. The lean/non-lean
gap **scales with the operator's config** and is larger on heavily-configured
machines; the numbers below are specific to this one.

## Results

All figures: `MODEL=haiku`, N=10 (unbounded N=3), warm-up discarded, this
machine (darwin-arm64, node v22.22.2, claude 2.1.185), corrected harness
(post-review). Re-run by `MODEL=haiku npm run test:bench:cli`; absolute numbers
shift run-to-run with model load and cache warmth — the *relationships* are the
finding.

### lean vs non-lean (single-turn `-p`)

| metric | lean | non-lean |
|---|--:|--:|
| wall median / p95 (ms) | 3715 / 7419 | 6931 / 8898 |
| **non-API residual** median (ms) | **259** (±590) | **1475** (±124) |
| claude API round-trip median (ms) | 3692 | 5277 |
| uncached input (tokens) | **20** | **20** |
| cache-read per turn (tokens) | 13 534 | 33 394 |
| output (tokens) | 7 | 8 |
| cost median / p95 ($) | 0.0015 / 0.0018 | 0.0028 / 0.0208 |
| ok / dropped / is_error | 10 / 0 / 0 | 10 / 0 / 0 |

- **Uncached input is identical (20 = 20)** — lean's win is *not* fewer input
  tokens. It is (a) ~2.5× less *cached* context re-sent per turn (13.5k vs
  33.4k) and (b) ~1.2 s less non-API overhead per turn (residual 259 ms vs
  1475 ms — the skipped `CLAUDE.md` + MCP boot), plus far steadier cost
  (non-lean p95 cost is ~7× its median, from cache re-creation churn).
- The residual is a *paired* per-sample median, deliberately **not**
  `median(wall) − median(api)` (which here is 3715 − 3692 = 23 ms, misleadingly
  tiny because the two medians come from different sample orderings).

### persistent: cold boot (turn 1) vs warm (turn 2)

| metric | turn 1 (cold) | turn 2 (warm) |
|---|--:|--:|
| wall median / p95 (ms) | 2856 / 4202 | 1662 / 1953 |
| ttft median (ms) | 2820 | 1603 |
| wall stdev (ms) | 727 | 182 |
| cost median ($) | 0.0015 | 0.0025 |

- Reusing the warm session saves **~1194 ms/turn (~42%)** of latency after the
  first turn, and turn 2 is far steadier (stdev 182 vs 727). **The win is
  latency, not cost:** turn 2 actually costs *more* ($0.0025 vs $0.0015) because
  the warm session re-sends the accumulating conversation each turn — persistent
  trades a little per-turn spend for a large, steady latency drop. (claude-API /
  cache / turns are `—`: the session path surfaces text + input/output/cost, not
  those fields.)

### bounded (`--max-turns 1`) vs unbounded (`--max-turns 12`) — same tools + prompt

| metric | bounded | unbounded (N=3) |
|---|--:|--:|
| wall median (ms) | 5952 | **28 885** |
| turns (cumulative) | 2 | **9** |
| cost median ($) | 0.0025 | **0.0874** |
| cache tokens read+created (cumulative) | ~28k | ~203k |
| ok / is_error | 10 / **10** | 3 / 0 |

- A single tool-using prompt, **unbounded, ran ~9 turns / ~29 s / $0.087**;
  bounded to one turn it is **~6 s / $0.0025 — ~4.9× faster, ~35× cheaper.**
  That gap is the `--max-turns 1` default's value. (bounded rows are `is_error`
  by design: a multi-step task can't finish in one turn, which is correct for a
  plain chat completion. unbounded N=3 → p95 suppressed, median indicative.)

### Where the time goes (single-turn → model-dominated)

For a lean turn, ~3692 ms of the ~3715 ms wall is the model API round-trip; the
lazyclaw + Claude-Code non-API residual is ~259 ms (**~7%**). lazyclaw cannot
make the model think faster; what it *can* control — context size (lean), boot
reuse (persistent), and loop bounding (`--max-turns`) — is exactly what these
conditions isolate, and each shows a real, defensible effect.

## Corrections to prior assumptions

These are recorded because the project's memory/notes asserted otherwise; the
multi-sample re-measurement contradicts them, and honesty about that is the
point of the exercise.

1. **"lean vs non-lean ≈ 2 vs 2401 input tokens (~1200×)" — NOT reproduced.**
   On claude 2.1.185 with prompt caching, *uncached* `input_tokens` per turn is
   **identical** for lean and non-lean (both **20** in the authoritative run —
   just the user message; the absolute drifts with session cache state, but the
   lean = non-lean equality is the robust finding). The real differences are
   **cache-read context size** (lean re-sends **13.5k** cached tokens/turn vs
   non-lean **33.4k**, ~2.5×) and **non-API overhead** (lean residual **259 ms**
   vs non-lean **1475 ms**), not a 1200× input-token reduction. The "~180k
   tokens" figure in `providers/claude_cli.mjs`'s comment is likewise not what
   this machine's config (one MCP server + 17.6 KB `CLAUDE.md`) loads.

2. **The provider under-reports usage on the one-shot path.** `claude_cli.mjs`'s
   `onUsage` reads `result.usage`, which is **all zeros** under streaming; the
   real per-turn tokens live on the `assistant` event. Cost
   (`result.total_cost_usd`) is correct; token counts surfaced to lazyclaw's
   usage callback on the one-shot path are 0. → **follow-up** (out of scope for
   this measurement task): read usage from the `assistant` event in the provider.

3. **Persistent path DOES report real input/output/cost.** Unlike the one-shot
   `-p` mode, the `--input-format stream-json` session's `result` event
   populates usage, so persistent token/cost cells are real (not the artifact a
   static read of the code would predict). Cache/api/turns are still unavailable
   on that path (shown as `—`).

## Caveats & limitations (what these numbers do NOT say)

- **Absolute ms/$ are haiku-only.** They do not transfer to opus/sonnet
  (larger models are slower and pricier). The *structural* findings (lean <
  non-lean, warm < cold, bounded ≪ unbounded, token structure) are expected to
  hold across models; the magnitudes are not.
- **The lean/non-lean gap is environment-specific** (see Environment) — do not
  generalize this machine's gap into a fixed product claim.
- **Non-lean wall includes this machine's MCP boot**, which is part of the
  honest non-lean cost but is the operator's environment, not lazyclaw code.
- **Non-API residual is a rough lower bound on overhead, single-turn only.**
  `duration_api_ms` is claude's own clock and can exceed external wall on
  multi-turn loops (reported with its sign, not hidden).
- **Unbounded N=3** — its p95 is suppressed and its median is indicative only;
  unbounded slowness is inseparable from its tendency to hit the turn cap
  (that *is* the finding, not a confound).
- **bounded rows are `is_error`** by design — a multi-step task can't finish in
  one turn, which is correct for a plain chat completion; genuine agentic work
  opts into a higher bound and accepts the cost.
- This is an automated micro-benchmark, **not** a substitute for real-workload
  profiling.

## Provenance

- Harness: `scripts/bench-claude-cli.mjs` + `scripts/bench-stats.mjs`
  (committed; unit-tested in `tests/bench_{stats,claude_cli}.test.mjs`).
- Adversarially reviewed (3-lens workflow: measurement-validity / statistics /
  honesty); the blocker (missing trailing-buffer drain) and the
  token-accumulation / overhead-metric defects it found were fixed before this
  authoritative run.
