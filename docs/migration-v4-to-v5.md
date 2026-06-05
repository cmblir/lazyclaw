# Migrating lazyclaw v4 → v5

This guide walks you through upgrading an existing lazyclaw v4.x install to
v5.0. The migration is **opt-in self-improvement** — without a `trainer`
config block, v5 behaves like v4 (spec §1.7).

## TL;DR

```bash
npm install -g lazyclaw@5
lazyclaw migrate v5         # backs up to ~/.lazyclaw/backup-v4/
```

## What changes on disk

| Path | v4 | v5 |
|---|---|---|
| `~/.lazyclaw/index.db` | — | new SQLite + FTS5 store |
| `~/.lazyclaw/trajectories/` | — | per-day JSONL trajectory sink |
| `~/.lazyclaw/memory/USER.md` | — | persistent user model (Honcho-equiv) |
| `~/.lazyclaw/SOUL.md` | — | global persona layer 1 |
| `~/.lazyclaw/personalities/<name>.md` | — | persona files (directory) |
| `~/.lazyclaw/skills/*.md` | name/desc/version | adds `group`, `trained_by`, `confidence`, `cross_cli_tested` (spec §3.5) |

## Breaking changes (spec §1.7)

1. **Native dep** — `better-sqlite3` is now a runtime dependency.
   Prebuilt binaries cover darwin/linux/win64 × x64/arm64. musl and
   freebsd users follow `docs/trainer-recipes.md#sqlite-fallback`.
2. **`index.db` disk schema** — managed by `lazyclaw migrate v5`.
3. **SKILL.md frontmatter** — new fields are additive; v4 skills get
   `trained_by: legacy` (spec C4) and `group:` from filename
   hyphen-prefix or `legacy` fallback (spec C5).

## Provider id normalisation (spec C3)

All user-facing config values use kebab-case: `claude-cli`, `codex-cli`,
`gemini-cli`. The migration rewrites underscore variants in your config.

## Trainer config (optional but recommended)

Add a `trainer` block to enable v5's closed learning loop:

```jsonc
{
  "provider": "claude-cli",
  "trainer": {
    "provider": "claude-cli",
    "model": "claude-haiku-4-5",
    "schedule": "nightly",
    "budget": { "maxCallsPerDay": 200, "usdPerDay": 0.50 }
  }
}
```

See `docs/trainer-recipes.md` for more configurations.

## Rollback

```bash
rm -rf ~/.lazyclaw
mv ~/.lazyclaw/backup-v4 ~/.lazyclaw
npm install -g lazyclaw@4
```

## Verifying the migration

```bash
lazyclaw index check                # SQLite + FTS5 integrity
lazyclaw rates --trainer-only --window 7d
lazyclaw recall "test" --scope skills --k 3
```
