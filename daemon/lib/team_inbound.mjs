// daemon/lib/team_inbound.mjs — Slack→team auto-routing for POST /inbound.
//
// When the inbound channel is bound to a team (team.slackChannel), drive the
// multi-agent task loop (mention_router.runTaskTurn) — which emits live
// dashboard events as the agents work — instead of a single-shot provider
// reply. Returns { reply, team, taskId } when handled, or null to fall through
// to the existing single-shot path (byte-stable for unbound channels).
//
// Collaborators are static-imported except mention_router (lazy, since it pulls
// in the agent-turn machinery); `_runTaskTurn` is a test injection seam.

import { teamForChannelCached } from '../../teams.mjs';
import { getAgent } from '../../agents.mjs';
import { registerTask } from '../../tasks.mjs';
import { defaultSandboxSpec } from '../../sandbox/index.mjs';

export async function routeInboundToTeam({
  cfg, channel, text, configDir, apiKey, baseUrl, logger, slackSender, onUsage, _runTaskTurn,
} = {}) {
  if (!channel || !text) return null;
  const team = teamForChannelCached(channel, configDir);
  if (!team) return null;

  // Load the team's agent records; bail (fall through) if the lead drifted away.
  const agentsById = {};
  for (const name of (team.agents || [])) {
    const rec = getAgent(name, configDir);
    if (rec) agentsById[name] = rec;
  }
  if (!agentsById[team.lead]) return null;

  const task = registerTask({
    title: String(text).slice(0, 80) || '(channel task)',
    team: team.name,
    lead: team.lead,
    slackChannel: channel,
  }, configDir);

  const runTaskTurn = _runTaskTurn
    || (await import('../../mas/mention_router.mjs')).runTaskTurn;

  // runTaskTurn expects a (line)=>{} logger. The daemon route passes a structured
  // logger object (with .info/.warn) or null — coerce to a callable so the loop
  // never throws "logger is not a function".
  const safeLogger = typeof logger === 'function' ? logger : () => {};

  const result = await runTaskTurn({
    task, team, agentsById, userMessage: text,
    configDir, apiKey, baseUrl, logger: safeLogger, slackSender,
    // Forward per-agent-turn usage so the daemon can price each turn against
    // its agent's rate card and feed the cost cap (team spend was invisible).
    onUsage,
    // Default-on confinement for every tool the team runs (opt out via cfg).
    sandbox: defaultSandboxSpec(cfg, { cwd: process.cwd(), configDir }),
  });

  const turns = (result && result.task && result.task.turns) || [];
  const lastAssistant = [...turns].reverse().find((t) => t && t.agent && t.agent !== 'user' && t.text);
  // Strip the internal [[TASK_DONE]] control marker from the channel-facing reply.
  const reply = (lastAssistant ? lastAssistant.text : '(team finished with no reply)')
    .replace(/\[\[TASK_DONE\]\]/g, '').trim();
  return {
    reply: reply || '(team finished with no reply)',
    team: team.name,
    taskId: (result && result.task && result.task.id) || task.id,
  };
}
