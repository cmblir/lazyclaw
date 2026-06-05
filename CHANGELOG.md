# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/).

## [5.0.0] — 2026-06-05

Hermes-parity release. v5 reorganises lazyclaw around four substrates —
**trainer split**, **SQLite + FTS5 learning index**, **tool registry**, and
**channel plugins** — and adds a polished ink-based TUI plus a personality
compose stack.

### Added

- **Trainer split (spec §3)**: `resolveTrainer()`, dotted `config get
  trainer.provider`, separate trainer model independent from chat provider.
  Canonical default `trainer.provider = "auto"` (decision C9).
- **TrajectoryRecord store (§3.3)**: JSONL append-only persistence under
  `<configDir>/trajectories/<task_id>.jsonl` with secret redaction and
  canonical 3-value outcome enum (C1: `done | failed | escalated`).
- **SQLite + FTS5 index (§4)**: `mas/index_db.mjs` mirrors sessions,
  skills, trajectories, and memory into a queryable BM25 store. Recall
  budget < 50 ms on 10 k rows.
- **Write-through hooks**: every `appendTurn`, `installSynthesized`, and
  `trajectory_store.put` now indexes into FTS5. Source-of-truth writes
  never break on index failure.
- **Learning core (Phase B)**: skill_synth v2 with anti-pattern outcome
  switch, user_modeler (Honcho-equivalent USER.md), recall tool over
  the FTS5 substrate, nudge SSE ticker, Wilson + cross-CLI confidence.
- **Ink-based TUI (Phase C)**: two-column splash with sloth ASCII
  banner, ghost autocomplete editor, interrupt-and-redirect REPL, fixed
  4-line footer, multiline editor.
- **6-backend sandbox abstraction (Phase D)**: local / docker / ssh /
  singularity / modal / daytona. Pluggable OS confiners
  (seatbelt / bubblewrap / firejail / landlock). `lazyclaw sandbox
  list|test|add|use` CLI subcommand.
- **Tool registry + 45 tools (Phase E)**: unified `mas/tools/registry.mjs`
  with `adaptLegacy` for v4-shaped tools. New groups: fs, exec, web, os,
  coding, git (5 read + 2 sensitive), scheduling, delegation, media, ha,
  clarify, browser, learning. Sensitive-tool approval hook in
  `tool_runner.mjs`.
- **MCP support (Phase E)**: stdio client + `server_spawn` driver,
  `lazyclaw toolsets` named bundles.
- **Channel plugins (Phase F)**: plugin loader, `channels install|list|
  remove` CLI, threads.jsonl cross-channel session mapping, `/handoff`
  slash command, skeletons for discord / email / signal / voice /
  whatsapp.
- **Persona + migration (Phase G)**: 8-layer prompt compose stack,
  `lazyclaw personality` subcommand + `/personality` REPL slash,
  v4 → v5 migration with rollback, hermes-import, openclaw-import.
- **Trajectory exporter (Phase H)**: `lazyclaw trajectories export
  --format atropos|axolotl|openai-ft|jsonl` with `--since` and
  `--filter outcome=` filters.
- **Tunable cross-CLI confidence dampening (Phase H)**: configurable via
  `orchestra.learning.crossCliDampenFactor`, default 0.85.
- **Docs (Phase H)**: `docs/migration-v4-to-v5.md`, `docs/persona-
  cookbook.md`, `docs/trainer-recipes.md`, Korean companion
  `README.ko.md`.
- **Perf benchmarks (Phase H)**: `tests/index_store.bench.mjs` (single
  insert, bulk 10 k, recall cold / warm / p95) and `tests/phaseH-
  perf.test.mjs` (cold-start ≤ 400 ms, idle RSS ≤ 180 MB).

### Changed

- Provider IDs are canonical kebab-case (decision C3): `claude-cli`,
  `openai-cli`, `gemini-cli`, `ollama`, `z-ai`.
- `sandbox.mjs` deprecated in favor of `sandbox/` directory backends.
- Tool runner now resolves through registry instead of static map.
- Skill frontmatter v2 with `trained_by` enum (C4) and `group` fallback
  to filename hyphen-prefix or `legacy` (C5).

### Migration

Run `lazyclaw migrate v5` from a v4 install. It backs up `configDir` to
`backup-v4-<ts>/`, rewrites `config.json` with `trainer.provider = "auto"`,
upgrades skill frontmatter, and rebuilds the FTS5 index. See
[`docs/migration-v4-to-v5.md`](docs/migration-v4-to-v5.md) for the full
walkthrough and rollback.

### Known limitations (deferred to v5.1)

- `recall` is a tool, not a top-level CLI subcommand.
- `sandbox run --backend ...` CLI shape not yet wired (only
  `list|test|add|use`).
- `codex-cli` and `gemini-cli` provider modules tracked but not
  registered in main runtime.
- E2E matrix test ships with 32/48 flows marked `test.skip` pending
  v5.1 wiring; min-green-set is documented in
  `tests/e2e/phaseH-e2e-matrix.spec.ts`.

## [4.3.0] — earlier

See git history prior to `5.0.0` for the v4.x line.
