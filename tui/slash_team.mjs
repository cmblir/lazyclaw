// tui/slash_team.mjs — the /team slash-command handler, extracted from
// slash_dispatcher.mjs (fix round 2) to make room under that file's pinned
// size ceiling for the /team member branch and its ctx.__persistFailed
// refusal paths. Same pattern as slash_trainer.mjs/slash_channels.mjs:
// self-contained (teams/agents/loop-engine are dynamically imported inside),
// never imported by the dispatcher's other handlers, so no cycle.
import { renderRecord } from '../lib/render.mjs';
import { _promptText, _promptConfirm, _refuse } from './slash_helpers.mjs';

export async function _team(args, ctx) {
  let teamsMod, loopMod, agentsMod;
  try {
    teamsMod = await import('../teams.mjs');
    loopMod = await import('../loop-engine.mjs');
    agentsMod = await import('../agents.mjs');
  } catch (e) { return `/team unavailable: ${e?.message || e}`; }
  let tokens;
  try { tokens = loopMod.splitArgs(args); }
  catch (e) { return `/team error: ${e?.message || e}`; }
  const sub = tokens[0];
  const rest = tokens.slice(1);
  const tname = rest[0];
  try {
    if (!sub && typeof ctx.openPicker === 'function') {
      const picked = await ctx.openPicker({
        kind: 'menu', title: 'Teams', subtitle: `${teamsMod.listTeams(ctx.cfgDir).length} registered`,
        items: [
          { id: 'list', label: 'List teams', desc: 'show all' },
          { id: 'add', label: 'Add team…', desc: '/team add <name> --agents a,b --lead a' },
          { id: 'show', label: 'Show team…', desc: 'print one record' },
          { id: 'remove', label: 'Remove team…', desc: 'delete a team' },
        ],
      });
      const pid = picked && typeof picked === 'object' ? picked.id : picked;
      return _team(typeof pid === 'string' && pid ? pid : 'list', ctx);
    }
    if (!sub || sub === 'list') {
      const teams = teamsMod.listTeams(ctx.cfgDir);
      if (teams.length === 0) return 'no teams registered. /team add <name> --agents a,b --lead a [--channel #x]';
      return teams.map((t) => {
        const chLine = t.slackChannel ? ` — ${t.slackChannel}` : '';
        return `• ${t.name} — ${t.displayName} — lead=${t.lead} — agents=[${t.agents.join(',')}]${chLine}`;
      }).join('\n');
    }
    if (sub === 'show') {
      if (!tname) return 'usage: /team show <name> [json]';
      const t = teamsMod.getTeam(tname, ctx.cfgDir);
      if (!t) return `no team "${tname}"`;
      return rest[1] === 'json'
        ? JSON.stringify(t, null, 2)
        : renderRecord(t, { fields: ['name', 'displayName', 'lead', 'agents', 'slackChannel', 'createdAt', 'updatedAt'] });
    }
    if (sub === 'member') {
      // /team member add|remove <team> <agent> — patchTeam already exists for
      // this (teams.mjs); it was just never wired to a slash command, so
      // adding a member meant going around the dispatcher entirely.
      const [action, teamName, agentName] = rest;
      if (!/^(add|remove|rm)$/.test(action || '') || !teamName || !agentName) {
        return _refuse(ctx, 'usage: /team member add|remove <team> <agent>');
      }
      const team = teamsMod.getTeam(teamName, ctx.cfgDir);
      if (!team) return _refuse(ctx, `team not found: ${teamName}`);
      if (action === 'add' && !agentsMod.getAgent(agentName, ctx.cfgDir)) {
        return _refuse(ctx, `agent not found: ${agentName}`);
      }
      const next = action === 'add'
        ? [...new Set([...(team.agents || []), agentName])]
        : (team.agents || []).filter((a) => a !== agentName);
      try {
        teamsMod.patchTeam(teamName, { agents: next }, ctx.cfgDir);
      } catch (e) {
        // e.g. TEAM_NO_AGENTS/TEAM_BAD_LEAD — validates before writing, so
        // the team is unchanged; the outer catch below used to say ok:true.
        return _refuse(ctx, `/team member: ${e?.message || e}`);
      }
      return `team ${teamName}: ${action === 'add' ? 'added' : 'removed'} ${agentName}`;
    }
    if (sub === 'add') {
      let agentsCsv = null, lead = null, channel = '';
      let teamName = tname;
      for (let i = 1; i < rest.length; i++) {
        const t = rest[i];
        if (t === '--agents') agentsCsv = rest[++i] || '';
        else if (t === '--lead') lead = rest[++i] || null;
        else if (t === '--channel') channel = rest[++i] || '';
        else return _refuse(ctx, `/team error: unknown token "${t}"`);
      }
      // Guided fill: no --agents + a modal available → name prompt, then a
      // multi-pick over registered agents, then a lead pick. Typed form
      // (--agents …) and the no-modal path are unchanged.
      let agentsList;
      if (!agentsCsv && typeof ctx.openPicker === 'function') {
        if (!teamName) {
          teamName = await _promptText(ctx, { title: 'New team — name', subtitle: 'short id (Esc cancels)' });
          if (!teamName) return 'team add: cancelled';
        }
        const all = agentsMod ? agentsMod.listAgents(ctx.cfgDir).map((a) => a.name) : [];
        if (!all.length) return _refuse(ctx, 'team add: no agents registered yet — add one with /agent add first');
        const chosen = [];
        for (let guard = 0; guard < 50; guard++) {
          const items = all.filter((n) => !chosen.includes(n)).map((n) => ({ id: n, label: n }));
          if (chosen.length) items.unshift({ id: '__done__', label: `✓ done (${chosen.length} selected)`, pinned: true });
          if (!items.length) break;
          const p = await ctx.openPicker({ kind: 'menu', title: `Team agents — ${chosen.length} picked`, subtitle: 'pick agents one at a time · ✓ done to finish · Esc cancels', items });
          const id = p && typeof p === 'object' ? p.id : p;
          if (!id) { if (chosen.length) break; return 'team add: cancelled'; }
          if (id === '__done__') break;
          chosen.push(id);
        }
        if (!chosen.length) return 'team add: cancelled (no agents picked)';
        const lp = await ctx.openPicker({ kind: 'menu', title: 'Team lead', subtitle: 'who leads this team?', items: chosen.map((n) => ({ id: n, label: n })) });
        lead = (lp && typeof lp === 'object' ? lp.id : lp) || chosen[0];
        agentsList = chosen;
      } else {
        if (!teamName) return _refuse(ctx, 'usage: /team add <name> --agents a,b,c [--lead a] [--channel #x]');
        if (!agentsCsv) return _refuse(ctx, '/team add: --agents is required');
        agentsList = teamsMod.parseListFlag(agentsCsv);
      }
      const ch = channel ? await teamsMod.resolveSlackChannel(channel, {
        botToken: process.env.SLACK_BOT_TOKEN || null,
        apiBase: process.env.SLACK_API_BASE || 'https://slack.com/api',
        logger: () => {},
      }) : '';
      const team = teamsMod.registerTeam({ name: teamName, agents: agentsList, lead, slackChannel: ch }, ctx.cfgDir);
      return `✓ added team ${team.name} (lead=${team.lead}, agents=${team.agents.join(',')})`;
    }
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      if (!tname) return _refuse(ctx, 'usage: /team remove <name>');
      if (typeof ctx.openPicker === 'function') {
        const ok = await _promptConfirm(ctx, { title: `Remove team "${tname}"?`, subtitle: 'This cannot be undone. Enter selects · Esc cancels' });
        if (!ok) return `team remove: cancelled — "${tname}" not removed`;
      }
      teamsMod.removeTeam(tname, ctx.cfgDir);
      return `✓ removed team ${tname}`;
    }
    return `/team: unknown sub "${sub}" — list|show|add|remove`;
  } catch (e) {
    // registerTeam/removeTeam validate (or check existence) BEFORE writing —
    // a duplicate name, an unregistered --agents entry, or a missing team on
    // remove all throw here with nothing having changed on disk. Returning
    // the message directly used to report ok:true over HTTP for exactly the
    // same reason the explicit refusals above exist.
    return _refuse(ctx, `/team error: ${e?.message || e}`);
  }
}
