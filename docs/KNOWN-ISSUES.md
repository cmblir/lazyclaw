# Known issues

## Interactive chat/loop/goal specs fail on Linux / non-TTY CI (tracked → Phase D)

**Status:** open · **Severity:** test-infra (no impact on macOS interactive use) · **Owner fix:** Phase D legacy-chat-loop rewrite

About 35 Playwright specs that spawn `lazyclaw chat` / `loop` / `goal`
interactively — piping lines into a **non-TTY** child — fail on Linux CI: the
streamed turn reply never reaches the child's stdout (`Received string: ""`).

Diagnosis (reproduced in a `node:20` Linux container):

- The shared turn core `tui/run_turn.mjs::makeRunTurn` produces the reply
  correctly on Linux when driven directly (writeFn receives `mock-reply: …`).
- The loss is in the **legacy readline chat loop** in `cli.mjs` (`cmdChat`,
  the `useTerminal = !!process.stdin.isTTY` / `readline.createInterface` path):
  a readline async-handler / `process.exit` / async-pipe-flush interaction that
  only manifests on Linux + non-TTS stdin. Early startup writes (e.g.
  `resumed session …`) DO reach the pipe, so it is specific to the per-turn
  streamed reply.
- They pass on macOS, which is why the suite was green locally and these specs
  had **never run on Linux** — there was no CI before `.github/workflows/test.yml`.

This is **pre-existing** and unrelated to the v6 security/correctness work.

**Interim handling:** the CI `playwright` job runs `continue-on-error` so it
reports without blocking the workflow; the `node` job (552 node:test
assertions, green on Linux) is the hard gate.

**Proper fix (Phase D):** replace the legacy readline loop with a shared,
properly-awaited non-TTY chat path — await each line's turn before processing
the next, and drain stdout before `process.exit`. Then re-enable the Playwright
job as a hard gate and remove this entry.

**Affected files (interactive subset):** `tests/phase1-loop-repl.spec.ts`,
`tests/phase3-goal-register.spec.ts`, `tests/phase4-terminal.spec.ts`,
`tests/phase5-memory.spec.ts`, and the interactive tests within
`tests/phase6-openclaw-parity.spec.ts`.
