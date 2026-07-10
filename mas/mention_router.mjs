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
import * as agentMemory from './agent_memory.mjs';
import * as skillSynth from './skill_synth.mjs';
import { resolvePermissionModeForSurface } from '../lib/permission_mode.mjs';
import { detectControl } from './tools/control.mjs';
import { finalizeTerminalStop } from './router_termination.mjs';
import { postToThread, postTypingPlaceholder, clearTypingPlaceholder } from './router_posting.mjs';
import { emit as emitEvent } from './events.mjs';
// Turn-context helpers (extracted, behavior-preserving) — re-exported
// below so the module's public surface is unchanged.
import {
  DONE_MARKER,
  extractMentions,
  renderTranscript,
  buildTurnContext,
  buildSkillsBlock,
} from './turn_context.mjs';

export { DONE_MARKER, extractMentions, renderTranscript, buildTurnContext, buildSkillsBlock };

export class MentionRouterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MentionRouterError';
    this.code = code || 'ROUTER_ERR';
  }
}

const DEFAULT_MAX_AGENT_TURNS = 12;

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
//
// The Slack thread I/O helpers (postToThread / postTypingPlaceholder /
// clearTypingPlaceholder) live in ./router_posting.mjs.

// The agents that actually spoke during a task — the set both the
// reflection and skill-synthesis post-task hooks iterate. 'user' and
// 'system' pseudo-agents are excluded so an agent who never spoke
// doesn't get a hook fired for a task they weren't in.
export function collectParticipants(task) {
  const participants = new Set();
  if (!task || !Array.isArray(task.turns)) return participants;
  for (const t of task.turns) {
    if (t.agent && t.agent !== 'user' && t.agent !== 'system') participants.add(t.agent);
  }
  return participants;
}

async function autoReflect({ task, agentsById, apiKey, baseUrl, fetchImpl, configDir, logger = () => {} }) {
  if (!task || !Array.isArray(task.turns)) return;
  for (const name of collectParticipants(task)) {
    const agentRecord = agentsById[name];
    if (!agentRecord) continue;
    if ((agentRecord.memoryWrite ?? 'auto') !== 'auto') continue;
    try {
      const body = await agentMemory.reflectOnce({
        agent: agentRecord,
        task,
        apiKey,
        baseUrl,
        fetchImpl,
      });
      if (body && body.trim()) {
        agentMemory.prependEntry(name, { taskId: task.id, title: task.title, body }, configDir);
        logger(`[memory] ${name} reflected on ${task.id}\n`);
      }
    } catch (err) {
      logger(`[memory] reflection failed for ${name}: ${err?.message || err}\n`);
    }
  }
}

// Phase 20 / v5 Group A (M3) — fire one skill-synthesis LLM call per
// participating agent whose skillWrite is 'auto' (the default since
// v5). Installs the resulting SKILL.md into the shared skills dir.
// Legacy v4 agents (no explicit skillWrite field) inherit the new
// 'auto' default via the `?? 'auto'` guard below — without a forced
// migration. Best-effort: a failed synthesis is logged, never thrown,
// so it can't poison a finished task.
async function autoSynthSkills({ task, agentsById, apiKey, baseUrl, fetchImpl, configDir, logger = () => {} }) {
  if (!task || !Array.isArray(task.turns)) return;
  for (const name of collectParticipants(task)) {
    const agentRecord = agentsById[name];
    if (!agentRecord) continue;
    if ((agentRecord.skillWrite ?? 'auto') !== 'auto') continue;
    try {
      const result = await skillSynth.synthesizeSkill({ agent: agentRecord, task, apiKey, baseUrl, fetchImpl });
      if (result) {
        // installSynthesized never clobbers a human-authored skill and
        // version-bumps when it improves its own prior skill.
        const installed = skillSynth.installSynthesized(
          { name: result.name, description: result.description, body: result.body, sourceTask: task.id },
          configDir,
        );
        logger(`[skill] ${name} synthesised "${installed.skill}" (v${installed.version}) → ${installed.path}\n`);
      }
    } catch (err) {
      logger(`[skill] synthesis failed for ${name}: ${err?.message || err}\n`);
    }
  }
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
  approve,
  security,
  // Fired with { provider, model, usage } after each agent turn that reported
  // usage, so the caller prices each turn against that agent's rate card and
  // feeds the cost cap (mixed-provider teams account correctly). No-op default.
  onUsage,
  // Default-on isolation — the flat sandbox spec applied to every tool the
  // agents run this task. Threaded from the entrypoint (task tick / REPL),
  // which builds it via defaultSandboxSpec. undefined → bare (byte-stable).
  sandbox,
  // E3 — a long-lived caller (e.g. the daemon) can pass a pre-started
  // SlackChannel to reuse across many task turns; run() then neither
  // creates nor stops it. When omitted, run() opens + closes its own.
  slackSender: providedSender,
  // Test seam — inject a fake turn runner. Defaults to the real
  // agentTurn.runAgentTurn so production callers are byte-identical.
  runAgentTurnImpl,
  // Phase 1c (default-provider security) — the surface running this task.
  // Default TRUE = the interactive/CLI behavior (no permission-mode override,
  // claude-cli keeps its bypass default). When FALSE (an unattended surface such
  // as the daemon answering an inbound channel message), the claude-cli
  // permission mode is resolved via resolvePermissionModeForSurface(cfg,
  // 'unattended') — fail-closed to read-only "plan" unless the operator opted in
  // with cfg.security.unattendedExec=true — and threaded into every agent turn.
  attended = true,
  // The loaded config, needed only to resolve the unattended permission posture
  // above. Optional; when omitted the fail-closed resolver still returns "plan".
  cfg,
} = {}) {
  const runAgentTurn = typeof runAgentTurnImpl === 'function' ? runAgentTurnImpl : agentTurn.runAgentTurn;
  // Resolve the claude-cli permission mode for this surface ONCE. undefined for
  // an attended run means "don't override" — the claude-cli adapter keeps its
  // bypassPermissions default and every existing caller is byte-stable.
  const permissionMode = attended === false
    ? resolvePermissionModeForSurface(cfg, 'unattended')
    : undefined;
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

  // E3 — open ONE Slack client for the whole run and reuse it for every
  // thread post + typing placeholder, instead of constructing + starting +
  // stopping a fresh SlackChannel (a network auth handshake) on each of the
  // ~3-4 posts per agent turn. Posts fall back to a per-call owned client
  // when no shared sender is available (no thread, or start failure).
  let slackSender = providedSender || null;
  let ownSlackSender = false;
  if (!slackSender && current.slackChannel && current.slackThreadTs) {
    try {
      const { SlackChannel } = await import('../channels/slack.mjs');
      slackSender = new SlackChannel({ requireInbound: false });
      await slackSender.start(async () => '', {});
      ownSlackSender = true;
    } catch (err) {
      logger(`[router] slack start failed, falling back to per-post clients: ${err?.message || err}\n`);
      slackSender = null;
    }
  }

  // Seed: append the user message if provided, and (also) push it to
  // Slack so anyone reading the thread sees the prompt.
  if (userMessage && String(userMessage).trim()) {
    current = tasksMod.appendTurn(current.id, { agent: 'user', text: String(userMessage), ts: new Date().toISOString() }, configDir);
    await postToThread({ task: current, agentRecord: null, text: `*User*: ${userMessage}`, logger, sender: slackSender });
  }

  const queue = [team.lead];
  let iterations = 0;
  let stoppedBy = 'idle';

  // Live activity events for the dashboard (mas/events bus → GET /events SSE).
  // emit() never throws, so these are pure side-channels that can't affect the turn.
  emitEvent('task.start', { taskId: current.id, team: team.name, title: current.title || '' });

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
    const ctx = buildTurnContext({ task: current, team, agent: speaker, agentRecord, teammates, configDir });

    // Post a "thinking…" placeholder so the user sees the bot picked
    // up the turn before the LLM finishes. Cleared right after the
    // real reply lands so we never leave a stale placeholder in the
    // thread.
    const typing = await postTypingPlaceholder({ task: current, agentRecord, logger, sender: slackSender });

    emitEvent('turn.start', { taskId: current.id, agent: speaker, provider: agentRecord.provider, model: agentRecord.model });
    emitEvent('agent.status', { agent: speaker, status: 'working' });

    let result;
    try {
      result = await runAgentTurn({
        agent: { ...agentRecord, role: ctx.system },
        // Group B / C10 — feed the transcript as a proper messages
        // history. The kickoff + prior turns + "your turn" marker
        // live in ctx.history; we leave userMessage empty so the
        // adapter doesn't double-append a redundant user turn.
        userMessage: '',
        history: ctx.history,
        taskId: current.id,
        configDir, cwd, apiKey, fetchImpl, baseUrl, signal, approve, security, sandbox,
        // C9 — enable Anthropic prompt caching for the static system
        // prefix + tool definitions. Non-anthropic adapters ignore
        // the flag (it's a no-op for OpenAI/Gemini/claude-cli).
        cache: true,
        // Phase 1c — forward the surface-resolved permission mode ONLY on an
        // unattended run; attended runs omit the key so runAgentTurn / the
        // claude-cli adapter keep today's bypass default (byte-stable).
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      });
    } catch (err) {
      await clearTypingPlaceholder(typing, logger);
      logger(`[router] agent "${speaker}" threw: ${err?.message || err}\n`);
      current = tasksMod.appendTurn(current.id, { agent: speaker, text: `(error: ${err?.message || err})`, ts: new Date().toISOString(), error: true }, configDir);
      emitEvent('turn.end', { taskId: current.id, agent: speaker, stoppedBy: 'error' });
      emitEvent('agent.status', { agent: speaker, status: 'idle' });
      continue;
    }
    await clearTypingPlaceholder(typing, logger);

    // Report this turn's spend with its provider+model. Best-effort — a
    // throwing/absent callback never affects the loop.
    if (result.usage && typeof onUsage === 'function') {
      try { onUsage({ provider: agentRecord.provider, model: agentRecord.model, usage: result.usage }); }
      catch { /* never let cost accounting break the turn */ }
    }

    const replyText = (result.text || '').trim();
    const ts = new Date().toISOString();
    current = tasksMod.appendTurn(current.id, { agent: speaker, text: replyText, ts, toolCalls: result.toolCalls?.length ? result.toolCalls : undefined }, configDir);
    emitEvent('turn.end', { taskId: current.id, agent: speaker, stoppedBy: result.stoppedBy });
    emitEvent('agent.status', { agent: speaker, status: 'idle' });

    // Slack mirror — only the user-visible text, with the agent name
    // prefixed so a human reader can follow who said what.
    if (replyText) await postToThread({ task: current, agentRecord, text: replyText, logger, sender: slackSender });

    // Terminate the task: flip status, post the close note, fire the
    // post-task learning hooks. Shared by the structured `finish` control
    // path and the legacy DONE_MARKER path below so both end identically.
    const terminateDone = async () => {
      current = tasksMod.patchTask(current.id, { status: 'done' }, configDir);
      emitEvent('task.done', { taskId: current.id, status: 'done' });
      await postToThread({ task: current, agentRecord: null, text: `:white_check_mark: ${DONE_MARKER} — task closed by *${agentRecord.displayName || speaker}*.`, logger, sender: slackSender });
      stoppedBy = 'done';
      // Phase 18: fire one reflection LLM call per participating agent
      // whose memoryWrite is 'auto'. We pick "participating" off the
      // task.turns rather than team.agents so an agent who never spoke
      // doesn't reflect on a task they weren't really in.
      await autoReflect({
        task: current,
        agentsById,
        apiKey, baseUrl, fetchImpl,
        configDir, logger,
      });
      // Phase 20: opt-in self-improving skill synthesis (skillWrite=auto).
      await autoSynthSkills({
        task: current,
        agentsById,
        apiKey, baseUrl, fetchImpl,
        configDir, logger,
      });
    };

    // Structured control protocol (primary): if the agent ran the `finish`
    // or `handoff` control tool this turn, that first-class signal drives
    // termination / delegation — it can't be defeated by a paraphrase, a
    // code-fenced marker, or a user pasting the marker. Only when NO
    // structured control call is present do we fall back to the legacy
    // [[TASK_DONE]] substring + @mention regex behaviour (below), which
    // existing tests pin — so the string protocol stays a working fallback.
    const control = detectControl(result);
    if (control && control.control === 'finish') {
      await terminateDone();
      break;
    }
    if (control && control.control === 'handoff') {
      // Validate the target against team.agents (mirrors extractMentions):
      // an unknown or self target is ignored, so a hallucinated name can't
      // enqueue a phantom speaker.
      const canonical = team.agents.find((a) => a.toLowerCase() === String(control.to).toLowerCase());
      if (canonical && canonical.toLowerCase() !== String(speaker).toLowerCase()) {
        emitEvent('delegate', { taskId: current.id, from: speaker, to: canonical });
        queue.push(canonical);
      } else if (speaker !== team.lead) {
        // No valid handoff target from a non-lead — hand back to the lead so
        // the task doesn't strand (same guard as the mention path below).
        queue.push(team.lead);
      }
      continue;
    }

    if (replyText.includes(DONE_MARKER)) {
      await terminateDone();
      break;
    }

    const mentions = extractMentions(replyText, team.agents, speaker);
    for (const m of mentions) {
      emitEvent('delegate', { taskId: current.id, from: speaker, to: m });
      queue.push(m);
    }

    // When a non-lead speaker doesn't hand off, return control to the
    // lead so the conversation doesn't strand mid-team. The lead can
    // choose to terminate next turn.
    if (mentions.length === 0 && speaker !== team.lead) {
      queue.push(team.lead);
    }
  }
  if (iterations >= maxAgentTurns) stoppedBy = 'budget';
  // C3 — strand-proof a non-DONE exit: terminal status + stop note (no-op for 'done'); task activates post-failure learning.
  current = await finalizeTerminalStop({ stoppedBy, iterations, current, configDir, tasksMod, postToThread, slackSender, logger, task: current });
  // A non-DONE exit (idle/budget/abort) still ends the task — the DONE path
  // already emitted task.done above, so only emit here for the other exits.
  if (stoppedBy !== 'done') {
    emitEvent('task.done', { taskId: current.id, status: current.status, stoppedBy });
  }
  // Close the Slack client for the whole run, but only if WE opened it.
  if (ownSlackSender && slackSender) await slackSender.stop().catch(() => {});
  return { task: current, iterations, stoppedBy };
}
