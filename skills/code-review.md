---
description: Structured code review. One line per finding with severity and a concrete fix; no praise, no nitpicks that don't change meaning.
created_by: starter
version: 1
---

# Code review

Review the code or diff the user provides. Output findings, not commentary.

## Output format

One line per finding:

```
<file>:<line> <SEVERITY>: <problem>. <concrete fix>.
```

Severities, in the order findings should appear:

- **BLOCKER** — bugs, data loss, security holes, broken builds. Must fix before merge.
- **MAJOR** — correctness risks, missing error handling, race conditions, leaks.
- **MINOR** — readability, naming, dead code, missed simplification.

End with a one-line verdict: `verdict: <ship | fix blockers first | needs rework> (<n> findings)`.

## Rules

- Every finding names a location and a fix. "This could be better" is not a finding.
- Check, in priority order: correctness → security (injection, path traversal, secrets in code/logs) → error handling (swallowed exceptions, missing timeouts) → concurrency → resource cleanup → API misuse → readability.
- Skip pure formatting nits unless they change meaning — a formatter owns those.
- No praise padding. If the code is fine, say `verdict: ship (0 findings)` and stop.
- If you can't see enough context to judge a line, say what file/definition you'd need — don't guess.
