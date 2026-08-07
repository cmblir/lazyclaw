// channels/slack_socket.mjs — Slack Socket Mode transport.
//
// Split out of channels/slack.mjs, which had reached the 500-line file-size gate.
// This is the natural seam: the WebSocket lifecycle (apps.connections.open, the
// reconnect ladder, envelope ack/dispatch) is a separate responsibility from the
// adapter's inbound/outbound message surface, and was over half the file.
//
// Bodies are moved verbatim; the only change is that the method's `this` became
// an explicit `ch` parameter, so SlackChannel._connectSocketMode now delegates
// here. Everything it touches is a field on that instance.

import { SlackError, validateEnv } from './slack_env.mjs';
import { shouldDispatchEvent } from './slack.mjs';

export async function connectSocketMode(ch, { logger = () => {}, maxReconnects = Infinity, onDead } = {}) {
  validateEnv(ch._env, { requireInbound: true });
  // `slack listen` reaches the adapter through here, not start(), so this is
  // where the production diagnostic sink actually gets attached.
  ch._logger = logger;
  if (typeof globalThis.WebSocket !== 'function') {
    throw new SlackError(
      'global WebSocket is not available — Node 22+ required for Socket Mode',
      'SLACK_NO_WS'
    );
  }
  const apiBase = ch._env.apiBase.replace(/\/$/, '');
  const appToken = ch._env.appToken;
  const seenEnvelopes = new Set();
  let closed = false;
  let ws = null;
  let attempts = 0;

  const openConnection = async () => {
    const url = `${apiBase}/apps.connections.open`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    if (!res.ok) {
      throw new SlackError(`apps.connections.open HTTP ${res.status}`, 'SLACK_OPEN_HTTP');
    }
    const json = await res.json().catch(() => ({}));
    if (!json.ok || !json.url) {
      throw new SlackError(`apps.connections.open failed: ${json.error || 'no url'}`, 'SLACK_OPEN_FAIL');
    }
    return json.url;
  };

  // Resolve our own identity so dispatchEvent can refuse loops where
  // the router posted a message with chat:write.customize (Slack
  // strips bot_id / subtype from those events, so the original
  // filter missed them and we replied to ourselves). Best-effort —
  // a failed auth.test leaves the filter relying on the legacy
  // bot_id / subtype check; better than refusing to start.
  let selfUserId = null;
  let selfBotId = null;
  try {
    const authUrl = `${apiBase}/auth.test`;
    const r = await fetch(authUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ch._env.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      if (j && j.ok) {
        selfUserId = j.user_id || null;
        selfBotId = j.bot_id || null;
        logger(`[slack] auth.test OK — self user=${selfUserId} bot=${selfBotId}\n`);
      }
    }
  } catch (err) {
    logger(`[slack] auth.test failed: ${err?.message || err}\n`);
  }
  ch._selfUserId = selfUserId;
  ch._selfBotId = selfBotId;

  // (channel, ts) dedupe — a single user message can fire both
  // `message` and `app_mention` events in the same channel. Both
  // arrive as separate Socket Mode envelopes (different envelope_id),
  // so the envelope_id-level dedupe upstream doesn't catch them. We
  // claim the pair on first dispatch and reject the second.
  const seenMessages = new Map();  // key → expiresAt(ms)
  const MSG_TTL_MS = 60_000;
  const claimMessage = (channel, ts) => {
    const key = `${channel}:${ts}`;
    const now = Date.now();
    // Sweep expired entries opportunistically so the map doesn't grow
    // unbounded over a long-running session.
    if (seenMessages.size > 256) {
      for (const [k, exp] of seenMessages) if (exp < now) seenMessages.delete(k);
    }
    const exp = seenMessages.get(key);
    if (exp && exp >= now) return false;
    seenMessages.set(key, now + MSG_TTL_MS);
    return true;
  };

  const dispatchEvent = async (event) => {
    if (!shouldDispatchEvent(event, { selfUserId: ch._selfUserId, selfBotId: ch._selfBotId })) {
      // shouldDispatchEvent already encodes the "skip the bot's own
      // chat:write.customize message" trap that caused the v4.2.0
      // listener loop. Bail before the reaction / handler call.
      if (event && (event.type === 'message' || event.type === 'app_mention')) {
        logger(`[slack] skipping ${event.type} from ${event.channel || '?'}:${event.ts || '?'}\n`);
      }
      return;
    }
    // For DMs (`im`) channel_type is 'im'; for channel mentions we only
    // get app_mention events. Either way we have channel + ts.
    const text = typeof event.text === 'string' ? event.text : '';
    const channel = event.channel;
    const senderId = event.user != null ? String(event.user) : null;  // the human who sent it
    const sourceTs = event.ts;                       // the message we react to
    const replyTs = event.thread_ts || event.ts;     // the thread root for replies
    if (!channel || !sourceTs) return;
    if (!claimMessage(channel, sourceTs)) {
      logger(`[slack] duplicate ${event.type} for ${channel}:${sourceTs} — skipping\n`);
      return;
    }
    const threadId = `${channel}:${replyTs}`;
    // Native message id for daemon-side dedup: ts is unique per channel,
    // so channel:ts is unique bot-wide (and identical for the app_mention
    // and message events of the same message — exactly what dedup wants).
    const messageId = `${channel}:${sourceTs}`;
    logger(`[slack] inbound ${event.type} from ${channel} (${text.length} chars)\n`);

    // Immediate acknowledgement. _ackInbound is silent when
    // reactions:write is missing (Phase 19.2 — no more text-ack
    // spam).
    const eyesOk = await ch._ackInbound(channel, sourceTs, logger);

    try {
      await ch._simulateInbound(text, threadId, senderId, messageId);
      if (eyesOk) {
        // Swap the "working" reaction for a "done" one so the user can
        // tell at a glance which messages have been answered.
        await ch._reaction('remove', channel, sourceTs, 'eyes');
        await ch._reaction('add', channel, sourceTs, 'white_check_mark');
      }
    } catch (err) {
      logger(`[slack] handler error: ${err?.message || err}\n`);
      if (eyesOk) {
        await ch._reaction('remove', channel, sourceTs, 'eyes');
        await ch._reaction('add', channel, sourceTs, 'x');
      }
    }
  };

  const dead = (err) => {
    if (typeof onDead === 'function') return onDead(err);
    // Surface the permanent failure instead of staying alive-but-deaf:
    // throwing from a fresh tick reaches the process crash handlers.
    setImmediate(() => { throw err; });
  };

  // Reschedule after ANY reconnect failure — including apps.connections.open
  // rejecting — so one bad negotiation can't permanently kill the chain.
  const scheduleReconnect = () => {
    if (closed) return;
    attempts++;
    if (attempts > maxReconnects) {
      logger(`[slack] giving up after ${attempts - 1} reconnect attempts\n`);
      dead(new SlackError(`socket-mode reconnect gave up after ${attempts - 1} attempts`, 'SLACK_SOCKET_DEAD'));
      return;
    }
    const backoff = Math.min(30000, 1000 * Math.pow(2, Math.min(attempts, 5)));
    logger(`[slack] reconnecting in ${backoff}ms (attempt ${attempts})\n`);
    setTimeout(() => {
      if (closed) return;
      connectOnce().catch((e) => {
        logger(`[slack] reconnect failed: ${e?.message || e}\n`);
        scheduleReconnect();
      });
    }, backoff);
  };

  const connectOnce = () => new Promise((resolve, reject) => {
    // Settle exactly once: a socket that closes (or errors) before 'open'
    // REJECTS instead of leaving the promise pending forever — the initial
    // caller surfaces it as a start failure; the reconnect path's .catch
    // schedules the next attempt.
    let settled = false;
    let wsUrl;
    openConnection()
      .then((u) => { wsUrl = u; })
      .catch((e) => { settled = true; reject(e); })
      .then(() => {
        if (!wsUrl) return;
        logger(`[slack] socket-mode dialing wss gateway\n`);
        ws = new WebSocket(wsUrl);
        ws.addEventListener('open', () => {
          attempts = 0;
          settled = true;
          logger(`[slack] socket-mode connected\n`);
          resolve();
        });
        ws.addEventListener('message', async (ev) => {
          let frame;
          try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
          catch { return; }
          if (frame.type === 'hello') {
            logger(`[slack] hello (num_connections=${frame.num_connections || '?'})\n`);
            return;
          }
          if (frame.type === 'disconnect') {
            logger(`[slack] disconnect requested (reason=${frame.reason || '?'})\n`);
            try { ws.close(1000); } catch { /* best-effort */ }
            return;
          }
          if (frame.type === 'events_api') {
            if (frame.envelope_id) {
              if (seenEnvelopes.has(frame.envelope_id)) return;
              seenEnvelopes.add(frame.envelope_id);
              // Bound the dedupe set so it doesn't grow forever.
              if (seenEnvelopes.size > 1024) {
                const trimTo = 512;
                const it = seenEnvelopes.values();
                while (seenEnvelopes.size > trimTo) seenEnvelopes.delete(it.next().value);
              }
              try { ws.send(JSON.stringify({ envelope_id: frame.envelope_id })); }
              catch (err) { logger(`[slack] ack send failed: ${err?.message || err}\n`); }
            }
            const event = frame.payload?.event;
            await dispatchEvent(event);
          }
        });
        ws.addEventListener('close', () => {
          logger(`[slack] socket closed\n`);
          if (!settled) {
            // Closed before 'open': settle the pending connect attempt.
            // The caller's .catch (initial start OR scheduleReconnect)
            // decides what happens next — never double-schedule here.
            settled = true;
            reject(new SlackError('socket closed before open', 'SLACK_SOCKET_CLOSED_EARLY'));
            return;
          }
          if (closed) return;
          scheduleReconnect();
        });
        ws.addEventListener('error', (ev) => {
          // The 'error' event fires before 'close'; we let 'close' drive
          // the reconnect so we don't reconnect twice for one failure.
          logger(`[slack] socket error: ${ev?.message || 'unknown'}\n`);
        });
      });
  });

  await connectOnce();
  ch._socketHandle = {
    disconnect: async () => {
      closed = true;
      try { ws?.close(1000); } catch { /* best-effort */ }
    },
  };
  return ch._socketHandle;
}
