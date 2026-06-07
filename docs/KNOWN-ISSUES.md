# Known issues

## Interactive chat/loop/goal specs failed on node 20 / non-TTY CI — RESOLVED

**Status:** resolved in `b479886` (D7) · **Severity:** was test-infra (no impact
on macOS interactive use)

About 35 Playwright specs that spawn `lazyclaw chat` / `loop` / `goal`
interactively — piping lines into a **non-TTY** child — failed on CI: the
chat produced no output at all (`Received string: ""`) and persisted no turns.

**Actual root cause (mis-diagnosed earlier as a readline/`process.exit`
stdout-flush bug):** a **node-20 readline-adjacency race**, not Linux-specific.
`cmdChat` created the `readline.createInterface` up front, then ran several
`await import(...)` (sandbox / prompt_stack / workspace) before reaching
`for await (const line of rl)`. On **node 20** a piped non-TTY stdin emits its
lines + EOF during that gap, before the async iterator attaches, so every line
is dropped. **node 22 tolerates the gap** — which is why it passed on macOS dev
(node 22) and failed on CI (`actions/setup-node` pins node 20). `engines` is
`node >=18`, so bumping the runtime was not an option.

**Fix:** move `createInterface` (+ ghost autocomplete + prompt) to immediately
before the loop, with no `await` in between, so buffered piped input reaches the
iterator. Verified in a `node:20` container and on the real CI run for
`b479886`: the previously-silent interactive specs pass; CI playwright went from
~35 failures to 6 (the unrelated network bucket below).

## Provider-probe specs crashed without a `claude` binary — RESOLVED

**Status:** resolved in `b9050be` (F8) · **Severity:** was a real product crash
(not just a test issue)

The last 6 CI playwright failures were the `lazyclaw providers test` (CLI) and
daemon `GET /providers/test` specs. They probe every registered provider in
parallel. The claude-cli provider spawned the `claude` binary and only caught
**synchronous** spawn failures — but a missing binary (ENOENT) surfaces
**asynchronously** as a ChildProcess `'error'` event. With no listener, Node
escalated it to an uncaughtException and killed the process mid-probe: the CLI
exited with empty stdout (`Unexpected end of JSON input`) and the daemon dropped
the socket (`other side closed`). It only reproduced where no `claude` binary
exists — i.e. CI, not a dev box — which is why it lingered.

**Fix:** the provider attaches a `proc.once('error', …)` listener and surfaces
the failure as a catchable `CliMissingError` (code `CLI_MISSING`); the probe
now reports `claude-cli` as a normal per-provider failure and the batch returns
valid JSON. The flaky `--parallel ... by topological level` timing assertion was
also widened (250ms node sleeps, 650ms ceiling) so spawn jitter can't trip it.

With these fixed the suite is green offline, so **the `playwright` CI job is now
a hard gate** (F8) — `continue-on-error` removed.
