# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/).

## [5.0.5] — 2026-06-05

### Fixed

- **Hero banner now reads as a sloth, not negative space.** The 5.0.4
  chafa render used `--invert`, which mapped the sloth itself to gaps
  and the pillow background to dense `⣿`. In a real terminal that
  inverted to a featureless humanoid silhouette. Replaced with the
  operator-curated 48×35 braille rendering of the same source photo
  with the inversion removed — sloth body, head, and arms now show as
  ink instead of cutouts.

## [5.0.4] — 2026-06-05

### Changed

- **Hero banner is a high-resolution chafa braille render**. Both the
  no-arg launcher and the chat splash now share the same 47×35 dense
  braille sloth (rendered from the Pexels sleepy-sloth photo via
  `chafa --symbols=braille --invert`). Replaces the 24×12 hand-drawn
  icon (chat) and the ANSI Shadow `LAZYCLAW` wordmark (launcher) —
  identical visual identity across both entry points.
- **Chat splash layout is now hero-on-top, single-column body**.
  Tools and skills stack full-width (76 cells) below the banner
  instead of competing for a 24-cell gutter. Verb lists no longer
  truncate. `LAZYCLAW_LEGACY_MENU=1` still drops the launcher banner
  back to the v4 figlet box.
- **Banner contract relaxed**. `tui/banner.generated.mjs` no longer
  has to be 24 cells wide; the test now asserts `rows.length ===
  height` and `stringWidth(row) <= width` instead of literal `24/12`.

## [5.0.3] — 2026-06-05

### Changed

- **Chat splash sloth banner**. The Phase C placeholder (chafa output
  of a featureless silhouette PNG) is replaced with a hand-drawn 24×12
  sleepy sloth: ears, closed eyes, mouth, Zzz inside body, claws, and
  the project label. Reads as a creature; the rasterised conversion
  did not. Still 24 East-Asian-Width cells per row to keep the splash
  gutter math intact (`tests/phaseC-build-splash.test.mjs` unchanged
  and passing).
- **No-arg launcher wordmark**. `lazyclaw` (no subcommand) now opens
  with a 6-row ANSI Shadow "LAZYCLAW" wordmark in box-drawing +
  half-block glyphs (67 cols, single-tone orange). Replaces the v5.0.1
  caption-on-sloth experiment which was visually weak at launcher
  width. Set `LAZYCLAW_LEGACY_MENU=1` to fall back to the v4 figlet
  box; the arrow-key menu beneath is unchanged.

## [5.0.2] — 2026-06-05

### Fixed

- **Critical: `tui/` and `mcp/` directories were missing from the npm
  tarball.** Phase C (ink TUI: splash, repl, editor, ghost, banner,
  theme) and Phase E (MCP stdio client + server_spawn driver) shipped
  in the git tree but were not listed in `package.json#files`, so
  `npm install -g lazyclaw@5.0.0` / `@5.0.1` produced a package that
  silently fell through to the v4 figlet REPL on `lazyclaw chat`
  because `import('./tui/repl.mjs')` threw `ERR_MODULE_NOT_FOUND`.
  Both directories are now in the file list and verified present in
  the tarball.

## [5.0.1] — 2026-06-05

### Changed

- **No-arg launcher banner** now matches the chat splash. Typing
  `lazyclaw` shows the same sloth ASCII art as `lazyclaw chat` (the
  Phase C banner) instead of the v4 figlet box. Visual identity is
  consistent across both entry points.

### Added

- `LAZYCLAW_LEGACY_MENU=1` env var restores the v4 figlet banner in
  the no-arg launcher for users who prefer it. The arrow-key menu
  itself is unchanged.

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
