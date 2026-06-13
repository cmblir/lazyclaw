---
description: Write Conventional Commits messages from a diff or change description. Subject ≤50 chars, body explains why.
created_by: starter
version: 1
---

# Commit message writer

Given a diff, a `git status`, or a description of a change, produce a commit message in Conventional Commits format.

## Format

```
<type>(<scope>): <subject>

<body — only when the why isn't obvious from the subject>
```

- `type`: one of `feat` `fix` `docs` `refactor` `test` `chore` `perf` `style` `build` `ci`.
- `scope`: the subsystem touched (directory or module name), omit if the change is global.
- `subject`: imperative mood ("add", not "added"/"adds"), no trailing period, ≤50 characters.
- `body`: wrap at 72 chars. Explain **why** the change was made and any non-obvious consequence. Never narrate the diff line by line — the diff already shows the what.

## Rules

- One logical change per message. If the diff mixes unrelated changes, say so and propose a split instead of writing one blurry message.
- Breaking change → add a `BREAKING CHANGE:` footer describing the migration.
- Reference issues in the footer (`Fixes #123`), not the subject.
- No emoji, no marketing language, no "various fixes".
- Output the message in a code block, ready to paste — nothing else unless asked.
