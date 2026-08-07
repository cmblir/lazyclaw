# Trainer Recipes (spec §2.3–§2.5)

The `trainer` config block separates **runtime learning** (cheap, bursty)
from **chat** (hot path). Three canonical scenarios from spec §2.5:

## Recipe A — Claude Pro/Max subscriber ($0 learning)

```jsonc
{
  "provider": "claude-cli",
  "trainer": {
    "provider": "claude-cli",
    "model": "claude-haiku-4-5",
    "schedule": "nightly",
    "budget": { "maxCallsPerDay": 200 }
  }
}
```

## Recipe B — API user, cost-split

```jsonc
{
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "trainer": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "schedule": "on-tick",
    "budget": { "usdPerDay": 0.50 },
    "fallback": "ollama:llama3.2"
  }
}
```

## Recipe C — Offline (`ollama`)

```jsonc
{
  "provider": "ollama",
  "model": "llama3.2",
  "trainer": { "provider": "ollama", "model": "llama3.2:3b" }
}
```

## Recipe D — `auto` (spec C9)

```jsonc
{
  "trainer": { "provider": "auto", "model": "claude-haiku-4-5" }
}
```

Resolves to `claude-cli` if a Pro/Max session is detected, else mirrors
the chat provider.

## Budget semantics (spec C2)

Both `maxCallsPerDay` (int) and `usdPerDay` (float) may be set. The
**first** cap to hit triggers the `fallback` for the rest of the
24h rolling window.

## SQLite fallback (musl/freebsd)

`better-sqlite3` ships no prebuilt for musl/freebsd. Either:
```bash
npm install -g pompos --build-from-source
```
or install with a glibc-based image (Debian, Ubuntu, Alpine via
`apk add gcompat`).
