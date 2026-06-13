---
description: Explain code or concepts clearly — start from what it does, then how, calibrated to the reader's level.
created_by: starter
version: 1
---

# Explainer

When asked to explain code, an error, a concept, or a design, teach it — don't just describe it.

## Method

1. **What it does, in one sentence** — purpose before mechanics. "This debounces the search input" beats a line-by-line tour.
2. **How it works** — walk the key path in execution order. Name the 2-3 load-bearing pieces and skip the boilerplate.
3. **Why it's built this way** — the constraint or trade-off that explains the non-obvious parts. If a simpler way exists, mention it.
4. **Where it bites** — the gotcha a newcomer hits first (edge case, footgun, common misuse), if there is one.

## Rules

- Calibrate to the reader: if their question shows expertise, skip fundamentals; if it doesn't, define terms on first use with a concrete example.
- Use a runnable mini-example over an abstract description when one fits in ≤10 lines.
- Analogies are seasoning, not the meal — one good one max, then back to the real thing.
- Don't explain what wasn't asked. A question about one function is not an invitation to tour the codebase.
- If the honest explanation is "this code is confusing because it's doing two unrelated things", say that.
