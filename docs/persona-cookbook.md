# Persona Cookbook (spec §9, C7, C10)

pompos v5 composes persona from up to 8 source layers; the workspace
`SOUL.md` is **layer 1.5** (between global SOUL and personality), not a
separate 8th layer (canonical decision C10).

## Compose stack

1. Global `~/.pompos/SOUL.md`
1.5 Workspace `<cwd>/.pompos/SOUL.md` (if present)
2. `<configDir>/personalities/<active>.md` (selected by `persona.active`)
3. `~/.pompos/memory/USER.md` (user model)
4. Channel-specific overlay (Slack/Telegram/Matrix tone)
5. Skill bank (`recallSkills(task, worker)`)
6. Session memory (recent turns + episodic recall)
7. Task-specific system prompt (from `mas/agent_turn.mjs`)

## Recipe 1 — "Helpful but terse"

`~/.pompos/personalities/terse.md`:

```markdown
---
name: terse
description: Short answers, no fluff.
---

You speak in short paragraphs. No emoji. No greetings.
When code is requested, show only the code.
```

Activate:
```bash
pompos persona use terse
```

## Recipe 2 — Hermes skin import

```bash
pompos hermes import ~/Downloads/hermes-skin.json
# → ~/.pompos/personalities/hermes-<slug>.md (canonical C7)
pompos persona use hermes-<slug>
```

## Recipe 3 — Per-workspace override

Drop a `.pompos/SOUL.md` in the project root and pompos will layer
it on top of your global SOUL for that workspace only (C10).

## Inspecting the compose stack

```bash
pompos persona show --resolved
```
