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

## Flaky network / timing-sensitive spawn specs (same non-blocking bucket)

A few Playwright specs spawn the CLI and assert on wall-clock or live network
probes, so they flake under load / restricted networks independent of the
interactive-stdin bug above:

- `phase6-openclaw-parity.spec.ts` › `lazyclaw run --parallel executes a DAG by
  topological level` — asserts `elapsed < 500ms`; flakes when the machine is
  busy (passes in isolation).
- `phase6-openclaw-parity.spec.ts` › `lazyclaw providers test (no name) …` —
  probes every provider endpoint, so it is slow (~1.5m) and depends on outbound
  network reachability.

These ride in the non-blocking `playwright` CI job. Phase F8 will make them
deterministic (output-driven waits, stubbed provider probes, retries on the
spawn-heavy specs).
