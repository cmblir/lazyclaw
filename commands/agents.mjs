// Multi-agent commands: cmdAgent (one-shot run), cmdTask, cmdTeam, and the
// agent registry (cmdAgentRegistry), extracted from cli.mjs (Phase D3).
import path from 'node:path';
import { configPath, readConfig, _resolveAuthKey, _resolveBaseUrl } from '../lib/config.mjs';
import { ensureRegistry, getRegistry } from '../lib/registry_boot.mjs';
import { loadDotenvIfAny as _loadDotenvShared } from '../dotenv_min.mjs';
import { defaultSandboxSpec } from '../sandbox/index.mjs';

// Thin .env loader wrapper kept local so the module stays self-contained.
export function _loadDotenvIfAny(cfgDir) { return _loadDotenvShared(cfgDir); }

export async function cmdAgent(prompt, flags) {
  // OpenClaw-style one-shot: send a single prompt, stream the response,
  // exit. Useful in scripts and pipelines. Honors --provider and --model
  // flags as overrides over config.json. Reads stdin when prompt is "-"
  // so callers can pipe input.
  await ensureRegistry();
  const skillsMod = await import('../skills.mjs');
  const cfg = readConfig();
  const provName = flags.provider || cfg.provider || 'mock';
  let prov = getRegistry().PROVIDERS[provName];
  if (!prov) { console.error(`unknown provider: ${provName}`); process.exit(2); }
  // --fallback "openai,ollama" wraps the primary in a withFallback chain so
  // RATE_LIMIT/CONNECTION_REFUSED/5xx on the primary trips through to the
  // listed providers in order. Unknown names exit 2 — better than a silent
  // skip, the chain lengths matter for user expectations.
  const fallbackList = (flags.fallback ? String(flags.fallback) : '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (fallbackList.length > 0) {
    const chain = [prov];
    for (const fb of fallbackList) {
      const fp = getRegistry().PROVIDERS[fb];
      if (!fp) { console.error(`unknown fallback provider: ${fb}`); process.exit(2); }
      chain.push(fp);
    }
    const { withFallback } = await import('../providers/fallback.mjs');
    prov = withFallback(chain);
  }
  // --retry N wraps the chosen provider with the rate-limit-aware retry
  // helper. N is exclusive of the initial call (--retry 3 = up to 4 tries).
  // Default 0 keeps behavior identical to before for callers that don't
  // explicitly opt in.
  const retryN = flags.retry !== undefined ? parseInt(flags.retry, 10) : 0;
  if (Number.isFinite(retryN) && retryN > 0) {
    const { withRateLimitRetry } = await import('../providers/retry.mjs');
    prov = withRateLimitRetry(prov, { attempts: retryN });
  }

  // --skill resolves a comma-separated list to a composed system prompt.
  // Defaults from config.skills (same shape) if --skill not passed.
  const skillNames = (flags.skill ? String(flags.skill) : (Array.isArray(cfg.skills) ? cfg.skills.join(',') : ''))
    .split(',').map(s => s.trim()).filter(Boolean);
  // --workspace <name> stitches AGENTS.md / SOUL.md / TOOLS.md from
  // <configDir>/workspaces/<name>/ at the head of the system prompt.
  // Workspace + skill compose: workspace block first, skill block
  // after — same order as `lazyclaw workspace show` so the user can
  // preview exactly what the LLM will see.
  const workspaceName = flags.workspace || cfg.workspace || '';
  const promptParts = [];
  if (workspaceName) {
    try {
      const ws = await import('../workspace.mjs');
      const wsPrompt = ws.composeWorkspacePrompt(path.dirname(configPath()), workspaceName);
      if (wsPrompt) promptParts.push(wsPrompt);
    } catch (e) { console.error(`workspace error: ${e.message}`); process.exit(2); }
  }
  if (skillNames.length > 0) {
    try {
      const skillPrompt = skillsMod.composeSystemPrompt(skillNames, path.dirname(configPath()));
      if (skillPrompt) promptParts.push(skillPrompt);
    } catch (e) { console.error(`skill error: ${e.message}`); process.exit(2); }
  }
  const systemPrompt = promptParts.length ? promptParts.join('\n\n---\n\n') : null;

  let text = prompt;
  if (text === '-' || text === undefined) {
    text = await new Promise(resolve => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', d => { buf += d; });
      process.stdin.on('end', () => resolve(buf));
    });
  }
  if (!text || !String(text).trim()) {
    console.error('agent: empty prompt'); process.exit(2);
  }
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: String(text) });
  // --thinking <budgetTokens> enables Anthropic extended thinking. Other
  // providers ignore the flag silently because their opts shape doesn't
  // carry it.
  const thinkingBudget = flags.thinking ? parseInt(flags.thinking, 10) : 0;
  // --show-thinking prints thinking deltas to stderr while text deltas
  // continue to stream to stdout. This keeps stdout clean for piping.
  const showThinking = flags['show-thinking'];
  // --usage prints normalized token totals to stderr after the response
  // streams. --cost adds a cost line when cfg.rates has a card matching
  // the active provider/model. Both write to stderr so piping the answer
  // text downstream isn't polluted with metadata.
  const showUsage = flags.usage;
  const showCost = flags.cost;
  // Loading rates is lazy: only when --cost is on, and we resolve once
  // up-front so the onUsage callback below doesn't need to import on a
  // hot path.
  let costFromUsage = null;
  if (showCost) {
    const ratesMod = await import('../providers/rates.mjs');
    costFromUsage = ratesMod.costFromUsage;
  }
  // --sandbox docker:<image> routes the underlying subprocess
  // (currently only the claude-cli provider hits this branch)
  // through `docker run`. parseSandboxSpec returns null when the
  // flag is absent / "off" so the no-flag path is bit-identical.
  let sandboxSpec = null;
  if (flags.sandbox) {
    const sb = await import('../sandbox.mjs');
    try { sandboxSpec = sb.parseSandboxSpec(flags.sandbox, flags); }
    catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
    if (sandboxSpec && provName !== 'claude-cli') {
      process.stderr.write(`warn: --sandbox only wraps subprocess providers; ${provName} ignores it\n`);
    }
  }
  try {
    for await (const chunk of prov.sendMessage(messages, {
      apiKey: _resolveAuthKey(cfg, provName),
      model: flags.model || cfg.model,
      sandbox: sandboxSpec,
      thinking: thinkingBudget > 0 ? { enabled: true, budgetTokens: thinkingBudget } : undefined,
      onThinking: showThinking ? t => process.stderr.write(t) : undefined,
      onUsage: (showUsage || showCost) ? (u) => {
        if (showUsage) process.stderr.write('usage: ' + JSON.stringify(u) + '\n');
        if (showCost && cfg.rates) {
          const c = costFromUsage(
            { provider: flags.provider || cfg.provider, model: flags.model || cfg.model, usage: u },
            cfg.rates,
          );
          if (c) process.stderr.write('cost: ' + JSON.stringify(c) + '\n');
        }
      } : undefined,
    })) {
      process.stdout.write(chunk);
    }
    process.stdout.write('\n');
  } catch (err) {
    process.stderr.write(`error: ${err?.message || String(err)}\n`);
    process.exit(1);
  }
}

// Cursor-style ghost autocomplete for the chat prompt. When the
// current readline buffer starts with `/` and prefix-matches a known
// slash command, the rest of the command is rendered in dim grey
// after the cursor. Right-arrow at end-of-line accepts the suggestion
// (replaces rl.line with the full command). Tab still goes through
// readline's tab-completer for cycling.
export async function cmdTask(sub, positional, flags = {}) {
  const tasksMod = await import('../tasks.mjs');
  const teamsMod = await import('../teams.mjs');
  const agentsMod = await import('../agents.mjs');
  const cfgDir = path.dirname(configPath());
  const idOrFirst = positional[0];

  const emitJson = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

  // Open a thread root in Slack and return its ts (or '' if we deliberately
  // skipped posting). Caller decides what to do with the ts.
  const postKickoff = async ({ task, team, leadAgent }) => {
    if (!task.slackChannel) {
      process.stderr.write('[task] team has no slackChannel — skipping Slack post\n');
      return '';
    }
    try { _loadDotenvIfAny(cfgDir); } catch { /* best-effort */ }
    const { SlackChannel } = await import('../channels/slack.mjs');
    const slack = new SlackChannel({ requireInbound: false });
    try {
      await slack.start(async () => '', {});
    } catch (err) {
      if (err?.code === 'SLACK_MISSING_ENV') {
        throw new Error(`SLACK_BOT_TOKEN missing — set it in ${path.join(cfgDir, '.env')} or unset team.slackChannel`);
      }
      throw err;
    }
    try {
      const text = tasksMod.buildKickoffMessage({
        id: task.id,
        title: task.title,
        description: task.description,
        leadDisplayName: leadAgent?.displayName || task.lead,
        teamDisplayName: team.displayName || team.name,
      });
      const res = await slack.send(task.slackChannel, text);
      return res?.ts || '';
    } finally {
      await slack.stop().catch(() => {});
    }
  };

  switch (sub) {
    case undefined:
    case 'list': {
      emitJson(tasksMod.listTasks(cfgDir));
      return;
    }
    case 'start': {
      const teamName = flags.team;
      const title = flags.title;
      if (!teamName || !title) {
        console.error('Usage: lazyclaw task start --team <team> --title "..." [--description "..."] [--lead <agent>]');
        process.exit(2);
      }
      try {
        const team = teamsMod.getTeam(teamName, cfgDir);
        if (!team) { console.error(`task start: no team "${teamName}"`); process.exit(2); }
        const leadName = flags.lead || team.lead;
        const leadAgent = agentsMod.getAgent(leadName, cfgDir);
        // Create the task record first (status=pending) so we can roll its
        // id into the Slack message; then post and patch in the ts.
        const seeded = tasksMod.registerTask({
          title,
          description: flags.description || '',
          team: teamName,
          lead: leadName,
          slackChannel: team.slackChannel,
          status: 'pending',
        }, cfgDir);
        let ts = '';
        try {
          ts = await postKickoff({ task: seeded, team, leadAgent });
        } catch (err) {
          // Rollback so we don't leave orphan task records when the post fails.
          try { tasksMod.removeTask(seeded.id, cfgDir); } catch { /* best-effort */ }
          console.error(`task start: ${err?.message || err}`);
          process.exit(2);
        }
        const turns = ts ? [{ agent: 'system', text: `Task opened by user. Lead: ${leadName}.`, ts }] : [];
        const finalTask = tasksMod.patchTask(seeded.id, {
          slackThreadTs: ts,
          status: ts ? 'running' : 'pending',
          turns,
        }, cfgDir);
        emitJson(finalTask);
      } catch (err) {
        console.error(`task start: ${err?.message || err}`);
        process.exit(2);
      }
      return;
    }
    case 'show': {
      if (!idOrFirst) { console.error('Usage: lazyclaw task show <id>'); process.exit(2); }
      const t = tasksMod.getTask(idOrFirst, cfgDir);
      if (!t) { console.error(`task show: no task "${idOrFirst}"`); process.exit(2); }
      emitJson(t);
      return;
    }
    case 'tick': {
      const id = idOrFirst;
      const userMsg = positional.slice(1).join(' ').trim() || flags.message || '';
      if (!id) { console.error('Usage: lazyclaw task tick <id> [<user message>]'); process.exit(2); }
      const task = tasksMod.getTask(id, cfgDir);
      if (!task) { console.error(`task tick: no task "${id}"`); process.exit(2); }
      const team = teamsMod.getTeam(task.team, cfgDir);
      if (!team) { console.error(`task tick: team "${task.team}" disappeared`); process.exit(2); }
      // Load all team agents in one shot — the router needs to dispatch
      // tool-use turns through each speaker's record.
      const agentsById = {};
      for (const name of team.agents) {
        const rec = agentsMod.getAgent(name, cfgDir);
        if (!rec) { console.error(`task tick: agent "${name}" disappeared`); process.exit(2); }
        agentsById[name] = rec;
      }
      try { _loadDotenvIfAny(cfgDir); } catch { /* best-effort */ }
      const router = await import('../mas/mention_router.mjs');
      // The runner needs a real api key for the agent's provider. We
      // resolve the LEAD's key here on the assumption that all team
      // members share a provider (Phase 13 simplification); future
      // phases will resolve per-agent.
      const cfg = readConfig();
      const leadAgent = agentsById[team.lead];
      const apiKey = _resolveAuthKey(cfg, leadAgent.provider);
      // Per-provider base-url override (tests point this at a local mock;
      // production leaves it unset for the built-in default).
      const baseUrl = _resolveBaseUrl(leadAgent.provider);
      // --approve-url turns on remote human-in-the-loop approval for the
      // sensitive tools (bash/write): each such call long-polls a running
      // daemon's `POST /exec/request`, which broadcasts to paired devices
      // over the gateway SSE and resolves when one approves. Fail-closed —
      // any endpoint error denies the call. Omit the flag → ungated (the
      // historical behavior).
      let approve;
      if (flags['approve-url']) {
        const approveUrl = String(flags['approve-url']).replace(/\/$/, '');
        const approveToken = flags['approve-token'] ? String(flags['approve-token']) : '';
        const approveTimeoutMs = flags['approve-timeout'] ? parseInt(flags['approve-timeout'], 10) : 120000;
        approve = async ({ tool, args, agent }) => {
          const summary = `${tool}: ${typeof args === 'object' ? JSON.stringify(args) : String(args)}`.slice(0, 400);
          try {
            const r = await fetch(`${approveUrl}/exec/request`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(approveToken ? { authorization: `Bearer ${approveToken}` } : {}) },
              body: JSON.stringify({ tool, agentId: agent, summary, timeoutMs: approveTimeoutMs }),
            });
            if (!r.ok) return { approved: false, reason: `approval endpoint HTTP ${r.status}` };
            const j = await r.json();
            return { approved: !!j.approved, reason: j.reason || (j.approved ? 'approved' : 'denied') };
          } catch (err) {
            return { approved: false, reason: `approval request failed: ${err?.message || err}` };
          }
        };
      } else if (process.stdin.isTTY) {
        // No --approve-url: default to an interactive y/N approval on the
        // controlling terminal so sensitive tools are confirmed rather than
        // run ungated. Non-TTY leaves approve undefined → the tool runner
        // fails closed (deny) unless security.allowUnattendedSensitive is set.
        const { makeReadlineApprove } = await import('../tui/terminal_approve.mjs');
        approve = makeReadlineApprove();
      }
      try {
        const result = await router.runTaskTurn({
          task, team, agentsById,
          userMessage: userMsg || undefined,
          configDir: cfgDir,
          apiKey,
          baseUrl,
          logger: (line) => process.stderr.write(line),
          maxAgentTurns: flags['max-turns'] ? parseInt(flags['max-turns'], 10) : undefined,
          approve,
          security: cfg.security,
          // Default-on isolation: confine every tool the team runs (filesystem
          // to cwd, secrets unreadable, net allowed). Opt out via cfg.sandbox.
          sandbox: defaultSandboxSpec(cfg, { cwd: process.cwd(), configDir: cfgDir }),
        });
        emitJson({ id: result.task.id, status: result.task.status, iterations: result.iterations, stoppedBy: result.stoppedBy });
      } catch (err) {
        console.error(`task tick: ${err?.message || err}`);
        process.exit(2);
      }
      return;
    }
    case 'abandon':
    case 'done': {
      if (!idOrFirst) { console.error(`Usage: lazyclaw task ${sub} <id>`); process.exit(2); }
      const target = sub === 'done' ? 'done' : 'abandoned';
      try {
        const next = tasksMod.patchTask(idOrFirst, { status: target }, cfgDir);
        // Best-effort closing post in the original thread so anyone in
        // the channel sees the resolution. Errors are surfaced via stderr
        // but do NOT roll back the status change.
        if (next.slackChannel && next.slackThreadTs) {
          try {
            _loadDotenvIfAny(cfgDir);
            const { SlackChannel } = await import('../channels/slack.mjs');
            const slack = new SlackChannel({ requireInbound: false });
            await slack.start(async () => '', {});
            const threadId = `${next.slackChannel}:${next.slackThreadTs}`;
            const msg = target === 'done'
              ? `:white_check_mark: Task *${next.title}* marked done.`
              : `:no_entry: Task *${next.title}* abandoned.`;
            await slack.send(threadId, msg);
            await slack.stop().catch(() => {});
          } catch (err) {
            process.stderr.write(`[task] closing post failed: ${err?.message || err}\n`);
          }
        }
        emitJson(next);
      } catch (err) {
        console.error(`task ${sub}: ${err?.message || err}`);
        process.exit(2);
      }
      return;
    }
    case 'transcript': {
      if (!idOrFirst) { console.error('Usage: lazyclaw task transcript <id> [--format text|md|json]'); process.exit(2); }
      const t = tasksMod.getTask(idOrFirst, cfgDir);
      if (!t) { console.error(`task transcript: no task "${idOrFirst}"`); process.exit(2); }
      const fmt = String(flags.format || 'text');
      if (fmt === 'json') { emitJson(t); return; }
      process.stdout.write(tasksMod.formatTranscript(t, fmt));
      return;
    }
    case 'remove':
    case 'rm':
    case 'delete': {
      if (!idOrFirst) { console.error('Usage: lazyclaw task remove <id>'); process.exit(2); }
      try { emitJson(tasksMod.removeTask(idOrFirst, cfgDir)); }
      catch (err) { console.error(`task remove: ${err?.message || err}`); process.exit(2); }
      return;
    }
    default:
      console.error('Usage: lazyclaw task <start|tick|list|show|transcript|abandon|done|remove> ...');
      process.exit(2);
  }
}



export async function cmdTeam(sub, positional, flags = {}) {
  const teamsMod = await import('../teams.mjs');
  const cfgDir = path.dirname(configPath());
  const name = positional[0];

  const emitJson = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  const resolveChannel = async (raw) => {
    if (!raw) return '';
    // .env may have a SLACK_BOT_TOKEN we can use; otherwise pass through.
    try { _loadDotenvIfAny(cfgDir); } catch { /* best-effort */ }
    return await teamsMod.resolveSlackChannel(raw, {
      botToken: process.env.SLACK_BOT_TOKEN || null,
      apiBase: process.env.SLACK_API_BASE || 'https://slack.com/api',
      logger: (line) => process.stderr.write(line),
    });
  };

  switch (sub) {
    case undefined:
    case 'list': {
      emitJson(teamsMod.listTeams(cfgDir));
      return;
    }
    case 'add': {
      if (!name) { console.error('Usage: lazyclaw team add <name> --agents a,b,c [--lead X] [--channel #shop|Cxxx] [--display "..."]'); process.exit(2); }
      const agents = teamsMod.parseListFlag(flags.agents) || [];
      try {
        const channel = await resolveChannel(flags.channel || '');
        const t = teamsMod.registerTeam({
          name,
          displayName: flags.display || flags['display-name'],
          agents,
          lead: flags.lead || null,
          slackChannel: channel,
        }, cfgDir);
        emitJson(t);
      } catch (err) {
        console.error(`team add: ${err?.message || err}`);
        process.exit(2);
      }
      return;
    }
    case 'show': {
      if (!name) { console.error('Usage: lazyclaw team show <name>'); process.exit(2); }
      const t = teamsMod.getTeam(name, cfgDir);
      if (!t) { console.error(`team show: no team "${name}"`); process.exit(2); }
      emitJson(t);
      return;
    }
    case 'edit': {
      if (!name) { console.error('Usage: lazyclaw team edit <name> [--agents a,b,c] [--lead X] [--channel ...] [--display "..."]'); process.exit(2); }
      const patch = {};
      if (flags.display !== undefined)         patch.displayName = String(flags.display);
      if (flags['display-name'] !== undefined) patch.displayName = String(flags['display-name']);
      if (flags.agents !== undefined)          patch.agents = teamsMod.parseListFlag(flags.agents);
      if (flags.lead !== undefined)            patch.lead = String(flags.lead);
      if (flags.channel !== undefined)         patch.slackChannel = await resolveChannel(flags.channel);
      if (Object.keys(patch).length === 0) {
        console.error('team edit: no fields to update');
        process.exit(2);
      }
      try { emitJson(teamsMod.patchTeam(name, patch, cfgDir)); }
      catch (err) { console.error(`team edit: ${err?.message || err}`); process.exit(2); }
      return;
    }
    case 'remove':
    case 'rm':
    case 'delete': {
      if (!name) { console.error('Usage: lazyclaw team remove <name>'); process.exit(2); }
      try { emitJson(teamsMod.removeTeam(name, cfgDir)); }
      catch (err) { console.error(`team remove: ${err?.message || err}`); process.exit(2); }
      return;
    }
    default:
      console.error('Usage: lazyclaw team <add|list|show|edit|remove> ...');
      process.exit(2);
  }
}

// cmdAgentRegistry lives in a sibling module to keep this file under the
// file-size gate. Re-exported here so cli.mjs's named import is unchanged.
export { cmdAgentRegistry } from './agents_registry.mjs';

// Best-effort .env loader for ~/.lazyclaw/.env. Only sets keys that are
// not already present in process.env (so a shell-level export wins).
// Lines starting with '#' are comments; values are taken verbatim and
// stripped of surrounding double-quotes if present.
