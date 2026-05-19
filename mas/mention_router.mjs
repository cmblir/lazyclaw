// Mention router — drives a multi-agent task through one Slack thread.
//
// Flow per `runTaskTurn` call:
//
//   1. Append the user message (if any) to task.turns.
//   2. Enqueue the team lead for the first turn.
//   3. Pop an agent off the queue, build its turn context from task.turns
//      (system = agent.role + team metadata; user = formatted thread
//      transcript + "your turn as X"), and call runAgentTurn.
//   4. Append the agent's reply to task.turns and (if Slack is wired)
//      post it into the task's thread.
//   5. If the reply contains the [[TASK_DONE]] marker, flip status to
//      'done' and stop. Otherwise, extract @mentions of teammates and
//      enqueue them. When the speaker isn't the lead and made no
//      mentions, hand control back to the lead.
//   6. Loop until queue empties or maxAgentTurns is reached.
//
// History across turns: every agent sees the entire thread transcript
// rendered as one big user message — that's the simplest representation
// that survives multi-speaker alternation rules in all three providers.

import * as agentTurn from './agent_turn.mjs';
import * as agentsMod from '../agents.mjs';
import * as tasksMod from '../tasks.mjs';

export class MentionRouterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MentionRouterError';
    this.code = code || 'ROUTER_ERR';
  }
}

export const DONE_MARKER = '[[TASK_DONE]]';
const DEFAULT_MAX_AGENT_TURNS = 12;

// Extract @AgentName mentions out of an agent's text. Only resolves
// matches that are present in `teamAgents`; everything else (including
// "@channel", "@here", or stray emails) is ignored. Preserves order,
// dedupes, and skips the speaker so an agent that re-mentions itself
// doesn't loop.
export function extractMentions(text, teamAgents, speaker = null) {
  if (typeof text !== 'string' || !text) return [];
  const set = new Set(teamAgents.map((a) => a.toLowerCase()));
  const out = [];
  const seen = new Set();
  const re = /(?:^|[^\w@])@([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    const key = name.toLowerCase();
    if (!set.has(key)) continue;
    if (speaker && key === String(speaker).toLowerCase()) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    // Recover the canonical (original) name from teamAgents.
    const canonical = teamAgents.find((a) => a.toLowerCase() === key) || name;
    out.push(canonical);
  }
  return out;
}

// Render task.turns into a single string. Each turn becomes:
//   "[agentName] text..."
// The "user" pseudo-agent maps to "User"; the "system" pseudo-agent maps
// to "System" (the kickoff turn lazyclaw seeds during task start).
export function renderTranscript(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return '(no turns yet)';
  return turns.map((t) => {
    const who = t.agent === 'user' ? 'User' : t.agent === 'system' ? 'System' : t.agent;
    return `[${who}] ${t.text}`;
  }).join('\n\n');
}

// Build the per-turn prompt the agent sees. System prompt = agent.role
// plus team metadata so the model knows who its teammates are and how
// to terminate; user prompt = task spec + transcript + a tag indicating
// whose turn this is.
export function buildTurnContext({ task, team, agent, agentRecord, teammates }) {
  const memberList = teammates.length
    ? teammates.map((a) => `@${a}`).join(', ')
    : '(no other agents in this team)';
  const role = agentRecord.role || '';
  const system = [
    role,
    role && '\n\n---\n',
    `You are *${agentRecord.displayName || agentRecord.name}* on team "${team.displayName || team.name}".`,
    `Teammates you can mention with @name: ${memberList}.`,
    `When the task is complete, end your message with the marker ${DONE_MARKER}.`,
  ].filter(Boolean).join('\n');
  const userParts = [
    `# Task: ${task.title}`,
    task.description ? `\n${task.description}\n` : '',
    '# Conversation so far:\n',
    renderTranscript(task.turns),
    `\n\n# Your turn (as ${agentRecord.name}):`,
  ];
  return { system, user: userParts.join('') };
}

// Post a single message into the task's Slack thread. Best-effort: log
// + swallow when the bot token is missing or the API call fails so the
// router doesn't crash mid-task on a transient Slack error.
//
// When agentRecord has displayName / iconEmoji, the post is sent under
// the agent's persona via chat.postMessage's `username` / `icon_emoji`
// fields (requires the bot's chat:write.customize scope — Slack
// silently ignores them when the scope is missing). The message text
// is no longer manually prefixed with the agent name because the
// custom username already shows it in Slack's UI.
async function postToThread({ task, agentRecord, text, logger = () => {}, sender }) {
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
  // When we have a real agent persona, push the text under that
  // persona's username + icon. Otherwise (user message or system note)
  // fall back to the bot's default identity with no decoration.
  let body;
  let sendOpts = {};
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

// "X is thinking…" placeholder posted into the thread before an agent
// turn so a human reader knows work is happening. Returns the ts of
// the placeholder so the caller can delete it once the real reply is
// in. No-op when Slack isn't wired or the post fails.
async function postTypingPlaceholder({ task, agentRecord, logger = () => {}, sender }) {
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
    return { ts: res?.ts || null, sender: owned ? slack : null, channel: task.slackChannel };
  } catch (err) {
    logger(`[router] slack typing post failed: ${err?.message || err}\n`);
    if (owned) await slack.stop().catch(() => {});
    return { ts: null, sender: null };
  }
}

async function clearTypingPlaceholder(placeholder, logger) {
  if (!placeholder?.ts || !placeholder?.channel) return;
  const slack = placeholder.sender;
  if (!slack) return;  // sender wasn't owned by us; skip
  try { await slack.deleteMessage(placeholder.channel, placeholder.ts); }
  catch (err) { logger(`[router] slack typing delete failed: ${err?.message || err}\n`); }
  finally { await slack.stop().catch(() => {}); }
}

// Run agents in this team until the queue empties or budget runs out.
//
// Returns { task, iterations, stoppedBy: 'idle' | 'done' | 'budget' }.
//   - 'idle'  — natural end (queue empty, no one to speak)
//   - 'done'  — an agent emitted DONE_MARKER (task.status flipped)
//   - 'budget' — maxAgentTurns hit before queue drained
export async function runTaskTurn({
  task,
  team,
  agentsById,
  userMessage,
  configDir,
  cwd,
  apiKey,
  fetchImpl,
  baseUrl,
  logger = () => {},
  maxAgentTurns = DEFAULT_MAX_AGENT_TURNS,
  signal,
} = {}) {
  if (!task || !team || !agentsById) {
    throw new MentionRouterError('task, team, agentsById are required', 'ROUTER_BAD_INPUT');
  }
  if (!team.lead || !team.agents.includes(team.lead)) {
    throw new MentionRouterError(`team "${team.name}" has no valid lead`, 'ROUTER_NO_LEAD');
  }
  // Closed tasks reject further ticks so a stray `task tick` after a
  // [[TASK_DONE]] or an explicit abandon doesn't reopen the loop.
  if (task.status === 'done' || task.status === 'abandoned') {
    throw new MentionRouterError(`task "${task.id}" is ${task.status} — cannot run further turns`, 'ROUTER_CLOSED');
  }

  let current = task;

  // A pending task (no Slack thread was opened at task start) gets
  // promoted to running on its first tick so the dashboard reflects
  // that work has actually started.
  if (current.status === 'pending') {
    current = tasksMod.patchTask(current.id, { status: 'running' }, configDir);
  }

  // Seed: append the user message if provided, and (also) push it to
  // Slack so anyone reading the thread sees the prompt.
  if (userMessage && String(userMessage).trim()) {
    current = tasksMod.appendTurn(current.id, { agent: 'user', text: String(userMessage), ts: new Date().toISOString() }, configDir);
    await postToThread({ task: current, agentRecord: null, text: `*User*: ${userMessage}`, logger });
  }

  const queue = [team.lead];
  let iterations = 0;
  let stoppedBy = 'idle';

  while (queue.length > 0 && iterations < maxAgentTurns) {
    if (signal?.aborted) { stoppedBy = 'abort'; break; }
    const speaker = queue.shift();
    const agentRecord = agentsById[speaker];
    if (!agentRecord) {
      logger(`[router] no agent record for "${speaker}" — skipping\n`);
      continue;
    }
    iterations++;
    const teammates = team.agents.filter((a) => a !== speaker);
    const ctx = buildTurnContext({ task: current, team, agent: speaker, agentRecord, teammates });

    // Post a "thinking…" placeholder so the user sees the bot picked
    // up the turn before the LLM finishes. Cleared right after the
    // real reply lands so we never leave a stale placeholder in the
    // thread.
    const typing = await postTypingPlaceholder({ task: current, agentRecord, logger });

    let result;
    try {
      result = await agentTurn.runAgentTurn({
        agent: { ...agentRecord, role: ctx.system },
        userMessage: ctx.user,
        history: [],
        taskId: current.id,
        configDir, cwd, apiKey, fetchImpl, baseUrl, signal,
      });
    } catch (err) {
      await clearTypingPlaceholder(typing, logger);
      logger(`[router] agent "${speaker}" threw: ${err?.message || err}\n`);
      current = tasksMod.appendTurn(current.id, { agent: speaker, text: `(error: ${err?.message || err})`, ts: new Date().toISOString(), error: true }, configDir);
      continue;
    }
    await clearTypingPlaceholder(typing, logger);

    const replyText = (result.text || '').trim();
    const ts = new Date().toISOString();
    current = tasksMod.appendTurn(current.id, { agent: speaker, text: replyText, ts, toolCalls: result.toolCalls?.length ? result.toolCalls : undefined }, configDir);

    // Slack mirror — only the user-visible text, with the agent name
    // prefixed so a human reader can follow who said what.
    if (replyText) await postToThread({ task: current, agentRecord, text: replyText, logger });

    if (replyText.includes(DONE_MARKER)) {
      current = tasksMod.patchTask(current.id, { status: 'done' }, configDir);
      await postToThread({ task: current, agentRecord: null, text: `:white_check_mark: ${DONE_MARKER} — task closed by *${agentRecord.displayName || speaker}*.`, logger });
      stoppedBy = 'done';
      break;
    }

    const mentions = extractMentions(replyText, team.agents, speaker);
    for (const m of mentions) queue.push(m);

    // When a non-lead speaker doesn't hand off, return control to the
    // lead so the conversation doesn't strand mid-team. The lead can
    // choose to terminate next turn.
    if (mentions.length === 0 && speaker !== team.lead) {
      queue.push(team.lead);
    }
  }

  if (iterations >= maxAgentTurns) stoppedBy = 'budget';
  return { task: current, iterations, stoppedBy };
}
