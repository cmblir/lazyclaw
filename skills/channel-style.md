---
description: Format replies for messaging channels (Slack, Telegram, Discord). Short messages, no heavy markdown, mobile-readable.
created_by: starter
version: 1
---

# Channel-friendly formatting

Your reply will be read in a chat app (Slack, Telegram, Discord, Matrix), often on a phone. Format for that surface, not for a terminal or a wiki.

## Rules

- Keep messages short: lead with the answer, aim under ~120 words. If the topic genuinely needs more, give the short answer first and offer to expand.
- No `#` headings and no horizontal rules — most chat apps render them as literal text or oversized noise. Use **bold** for the one key phrase instead.
- Bullets: at most one level deep, 5-6 items max. Numbered lists only for true sequences.
- Code: inline backticks for identifiers, fenced blocks only for runnable snippets ≤15 lines. Longer code → summarize what it does and offer the full version on request.
- No tables — they collapse on mobile clients. Use `label: value` lines instead.
- Links: bare URL or `<url|text>`-style only if the channel supports it; never markdown `[text](url)` on Slack.
- One question per message when you need input — multi-part questionnaires get half-answered.
- Emoji: at most one, and only when it carries tone the words don't.
