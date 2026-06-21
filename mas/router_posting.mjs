// mas/router_posting.mjs — Slack thread I/O for the mention router.
//
// Extracted from mention_router.mjs (which one-file-one-responsibility kept
// pushing over its size ceiling). These three helpers own every post the
// multi-agent loop makes into a task's Slack thread: the agent reply, the
// "thinking…" placeholder, and the placeholder cleanup. They are pure I/O —
// no router state — so they live here and the router imports them.
//
// Each helper is best-effort: a missing Slack wiring or a failed post returns
// a null-ish result and logs, never throws, so a Slack hiccup can't break the
// task loop. A long-lived caller passes a started `sender` to reuse across the
// whole run; when none is given the helper opens (and closes) its own client.

// Post an agent reply (or a user/system note when agentRecord is null) into the
// task's thread. Returns the message ts, or null when Slack isn't wired/failed.
export async function postToThread({ task, agentRecord, text, logger = () => {}, sender }) {
  if (!task.slackChannel || !task.slackThreadTs) return null;
  let slack = sender;
  let owned = false;
  if (!slack) {
    const { SlackChannel } = await import('../channels/slack.mjs');
    slack = new SlackChannel({ requireInbound: false });
    owned = true;
    try {
      await slack.start(async () => '', {});
    } catch (err) {
      logger(`[router] slack start failed: ${err?.message || err}\n`);
      return null;
    }
  }
  const threadId = `${task.slackChannel}:${task.slackThreadTs}`;
  // When we have a real agent persona, push the text under that persona's
  // username + icon. Otherwise (user message or system note) fall back to the
  // bot's default identity with no decoration.
  let body;
  const sendOpts = {};
  if (agentRecord) {
    body = String(text);
    if (agentRecord.displayName) sendOpts.username = agentRecord.displayName;
    if (agentRecord.iconEmoji) sendOpts.icon_emoji = agentRecord.iconEmoji;
  } else {
    body = String(text);
  }
  try {
    const res = await slack.send(threadId, body, sendOpts);
    return res?.ts || null;
  } catch (err) {
    logger(`[router] slack send failed: ${err?.message || err}\n`);
    return null;
  } finally {
    if (owned) await slack.stop().catch(() => {});
  }
}

// "X is thinking…" placeholder posted into the thread before an agent turn so a
// human reader knows work is happening. Returns the placeholder's ts (+ the
// sender used) so the caller can delete it once the real reply lands. No-op
// when Slack isn't wired or the post fails.
export async function postTypingPlaceholder({ task, agentRecord, logger = () => {}, sender }) {
  if (!task.slackChannel || !task.slackThreadTs) return { ts: null, sender: null };
  let slack = sender;
  let owned = false;
  if (!slack) {
    const { SlackChannel } = await import('../channels/slack.mjs');
    slack = new SlackChannel({ requireInbound: false });
    owned = true;
    try {
      await slack.start(async () => '', {});
    } catch (err) {
      logger(`[router] slack start failed: ${err?.message || err}\n`);
      return { ts: null, sender: null };
    }
  }
  const threadId = `${task.slackChannel}:${task.slackThreadTs}`;
  const sendOpts = {};
  if (agentRecord?.displayName) sendOpts.username = agentRecord.displayName;
  if (agentRecord?.iconEmoji)   sendOpts.icon_emoji = agentRecord.iconEmoji;
  try {
    const res = await slack.send(threadId, `_:hourglass_flowing_sand: thinking…_`, sendOpts);
    return { ts: res?.ts || null, sender: slack, owned, channel: task.slackChannel };
  } catch (err) {
    logger(`[router] slack typing post failed: ${err?.message || err}\n`);
    if (owned) await slack.stop().catch(() => {});
    return { ts: null, sender: null, owned: false };
  }
}

// Delete a "thinking…" placeholder once the real reply is in. Only stops a
// client this helper opened (a shared sender is closed once by run()).
export async function clearTypingPlaceholder(placeholder, logger = () => {}) {
  if (!placeholder?.ts || !placeholder?.channel || !placeholder?.sender) return;
  const slack = placeholder.sender;
  try { await slack.deleteMessage(placeholder.channel, placeholder.ts); }
  catch (err) { logger(`[router] slack typing delete failed: ${err?.message || err}\n`); }
  finally { if (placeholder.owned) await slack.stop().catch(() => {}); }
}
