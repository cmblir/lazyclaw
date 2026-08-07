#!/usr/bin/env node
// One-shot tool to delete the listener-loop garbage that v4.2.0 left
// behind: empty-text bot messages and the "_확인해보겠습니다…_" text-ack
// fallback the listener fired when reactions:write was unavailable.
//
// Use:
//   SLACK_BOT_TOKEN=xoxb-... node scripts/slack-cleanup.mjs <channelId> [--dry-run]
//
// The bot can only chat.delete its own messages; the script filters
// strictly on bot_id (own bot) + text match so a human's message
// never gets touched. --dry-run prints what would be removed without
// hitting chat.delete.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function loadDotenv() {
  const p = path.join(process.env.LAZYCLAW_CONFIG_DIR || path.join(os.homedir(), '.pompos'), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const GARBAGE_PATTERNS = [
  /^\s*$/,                                  // empty text
  /확인해보겠습니다/,                          // text-ack fallback
  /^_:hourglass_flowing_sand: thinking…_$/,  // typing placeholder
  /^_:hourglass_flowing_sand:/,             // typing placeholder (loose)
  /^\(empty message\)$/,                    // listener handler empty reply
  /^\(empty reply\)$/,                      // adapter empty reply
  /^\(provider error/,                      // listener handler provider error
];

async function main() {
  loadDotenv();
  const channel = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!channel || !process.env.SLACK_BOT_TOKEN) {
    console.error('usage: SLACK_BOT_TOKEN=xoxb-... node scripts/slack-cleanup.mjs <channelId> [--dry-run]');
    process.exit(2);
  }
  const apiBase = process.env.SLACK_API_BASE || 'https://slack.com/api';
  const headers = { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` };

  // 1. Resolve our own bot_id via auth.test so the filter is strict.
  const auth = await (await fetch(`${apiBase}/auth.test`, { method: 'POST', headers })).json();
  if (!auth.ok) { console.error(`auth.test: ${auth.error}`); process.exit(1); }
  const selfBotId = auth.bot_id;
  const selfUserId = auth.user_id;
  console.log(`[cleanup] self bot_id=${selfBotId} user_id=${selfUserId} channel=${channel}`);

  // 2. Walk channel history (limit 200 per call; v4.2.0 loop produced
  //    far fewer than that during the demo run). Pagination matters
  //    for larger backlogs — re-run the script until "no garbage
  //    found".
  let cursor;
  let scanned = 0;
  let killed = 0;
  do {
    const params = new URLSearchParams({ channel, limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const histRes = await fetch(`${apiBase}/conversations.history?${params.toString()}`, { headers });
    const hist = await histRes.json();
    if (!hist.ok) { console.error(`conversations.history: ${hist.error}`); process.exit(1); }

    for (const msg of hist.messages || []) {
      scanned++;
      const isSelf =
        msg.bot_id === selfBotId ||
        msg.user === selfUserId ||
        (msg.bot_profile && msg.bot_profile.id === selfBotId);
      if (!isSelf) continue;
      const text = typeof msg.text === 'string' ? msg.text : '';
      const isGarbage = GARBAGE_PATTERNS.some((re) => re.test(text));
      if (!isGarbage) {
        if (dryRun) console.log(`[cleanup] keep ts=${msg.ts} text=${JSON.stringify(text).slice(0, 100)}`);
        continue;
      }
      console.log(`[cleanup] ${dryRun ? 'DRY ' : ''}delete ts=${msg.ts} text=${JSON.stringify(text).slice(0, 80)}`);
      if (!dryRun) {
        const del = await fetch(`${apiBase}/chat.delete`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ channel, ts: msg.ts }),
        });
        const j = await del.json().catch(() => ({}));
        if (j.ok) killed++;
        else console.error(`  chat.delete failed: ${j.error}`);
        // Conservative pacing — Slack rate-limits chat.delete to tier 3
        // (50/min). 1 call every 200ms keeps us well below.
        await new Promise((r) => setTimeout(r, 200));
      }

      // Each top-level message may have a thread. Walk the replies too
      // so the garbage that landed inside a thread (which is exactly
      // where the v4.2.0 loop fired) also gets cleaned.
      if (msg.reply_count > 0 || msg.thread_ts === msg.ts) {
        let replyCursor;
        do {
          const tp = new URLSearchParams({ channel, ts: msg.thread_ts || msg.ts, limit: '200' });
          if (replyCursor) tp.set('cursor', replyCursor);
          const rRes = await fetch(`${apiBase}/conversations.replies?${tp.toString()}`, { headers });
          const r = await rRes.json();
          if (!r.ok) { console.error(`conversations.replies: ${r.error}`); break; }
          for (const reply of (r.messages || []).slice(1) /* index 0 = parent */) {
            scanned++;
            const replyIsSelf =
              reply.bot_id === selfBotId ||
              reply.user === selfUserId ||
              (reply.bot_profile && reply.bot_profile.id === selfBotId);
            if (!replyIsSelf) continue;
            const rt = typeof reply.text === 'string' ? reply.text : '';
            if (!GARBAGE_PATTERNS.some((re) => re.test(rt))) {
              if (dryRun) console.log(`[cleanup] keep thread-reply ts=${reply.ts} text=${JSON.stringify(rt).slice(0, 100)}`);
              continue;
            }
            console.log(`[cleanup] ${dryRun ? 'DRY ' : ''}delete thread-reply ts=${reply.ts} text=${JSON.stringify(rt).slice(0, 80)}`);
            if (!dryRun) {
              const del2 = await fetch(`${apiBase}/chat.delete`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ channel, ts: reply.ts }),
              });
              const j2 = await del2.json().catch(() => ({}));
              if (j2.ok) killed++;
              else console.error(`  chat.delete failed: ${j2.error}`);
              await new Promise((r) => setTimeout(r, 200));
            }
          }
          replyCursor = r.response_metadata && r.response_metadata.next_cursor;
        } while (replyCursor);
      }
    }
    cursor = hist.response_metadata && hist.response_metadata.next_cursor;
  } while (cursor);

  console.log(`[cleanup] scanned ${scanned} messages, ${dryRun ? 'would delete' : 'deleted'} ${killed}.`);
}

main().catch((e) => { console.error(e?.stack || e); process.exit(1); });
