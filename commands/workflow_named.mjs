// commands/workflow_named.mjs — `lazyclaw workflow <add|list|show|remove|run>`.
//
// Stored, named declarative workflows (cfg.workflows[<name>]) — the Hermes-style
// automation surface. `add` persists a def from a JSON file (+ optional Slack
// channel / cron schedule); `run` executes it by name and posts the reply to
// the bound channel. Distinct from the top-level `run <session-id> <file.mjs>`
// (the hand-written .mjs engine) — these are DATA workflows.

import fs from 'node:fs';
import { readConfig, writeConfig, configPath } from '../lib/config.mjs';
import { PROVIDERS } from '../providers/registry.mjs';
import { parseWorkflow } from '../workflow/declarative.mjs';
import { runNamedWorkflow, getNamedWorkflow, listNamedWorkflows, namedReplyText, validWorkflowName } from '../workflow/named.mjs';

const emitJson = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
const providerLookup = (name) => PROVIDERS[name] || null;

// Post a workflow's reply text to a channel target ("slack:#chan" or a bare
// channel id). makeSender is injected in tests; in production it builds a
// short-lived SlackChannel (requireInbound:false → only SLACK_BOT_TOKEN needed),
// mirroring the goal-tick fan-out. Best-effort: a Slack failure is reported, not
// fatal to the run.
async function postReply(channelTarget, text, { makeSender } = {}) {
  if (!channelTarget || !text) return { posted: false };
  const channel = String(channelTarget).startsWith('slack:') ? String(channelTarget).slice('slack:'.length) : String(channelTarget);
  let sender;
  try {
    if (makeSender) {
      sender = await makeSender();
    } else {
      const slackMod = await import('../channels/slack.mjs');
      sender = new slackMod.SlackChannel({ requireInbound: false });
      await sender.start(async () => '', { gate: null });
    }
    const res = await sender.send(channel, text);
    return { posted: true, ts: res?.ts || null, channel };
  } catch (e) {
    return { posted: false, error: e?.message || String(e), channel };
  } finally {
    try { if (sender && typeof sender.stop === 'function') await sender.stop(); } catch { /* best-effort */ }
  }
}

// Run a named workflow and (when it has a bound channel) post its reply. Pure
// enough to test in-process: pass makeSender + fetchImpl. Returns
// { result, reply, post }.
export async function runNamedAndReport(name, cfg, opts = {}) {
  const entry = getNamedWorkflow(cfg, name);
  if (!entry) throw new Error(`no workflow named "${name}"`);
  const result = await runNamedWorkflow(name, cfg, { providerLookup, fetchImpl: opts.fetchImpl, input: opts.input });
  const reply = namedReplyText(result, entry);
  let post = { posted: false };
  if (entry.channel && reply) post = await postReply(entry.channel, reply, { makeSender: opts.makeSender });
  return { result, reply, post };
}

export async function cmdWorkflow(sub, positional = [], flags = {}) {
  switch (sub) {
    case undefined:
    case 'list':
      emitJson({ ok: true, workflows: listNamedWorkflows(readConfig()) });
      return;

    case 'show': {
      const name = positional[0];
      const entry = name && getNamedWorkflow(readConfig(), name);
      if (!entry) { console.error(`workflow show: no workflow "${name}"`); process.exit(2); }
      emitJson({ ok: true, name, ...entry });
      return;
    }

    case 'add': {
      const name = positional[0];
      const file = positional[1];
      if (!name || !file) {
        console.error('Usage: lazyclaw workflow add <name> <def.json> [--channel slack:#x] [--cron "<spec>"] [--reply-node <id>]');
        process.exit(2);
      }
      if (!validWorkflowName(name)) { console.error(`workflow add: invalid name "${name}" (letters/digits/.-_ only)`); process.exit(2); }
      let def;
      try {
        const text = fs.readFileSync(file, 'utf8');
        def = /\.ya?ml$/i.test(file)
          ? await (await import('../workflow/declarative.mjs')).parseWorkflowYaml(text)
          : parseWorkflow(text);
      } catch (e) { console.error(`workflow add: ${e.message}`); process.exit(2); }
      const entry = { def };
      if (flags.channel && flags.channel !== true) entry.channel = String(flags.channel);
      if (flags.cron && flags.cron !== true) entry.schedule = String(flags.cron);
      if (flags['reply-node'] && flags['reply-node'] !== true) entry.replyNode = String(flags['reply-node']);
      // Validate the cron spec BEFORE persisting. Otherwise a bad --cron is
      // stored and reported as `ok:true` while no job is ever installed — a
      // schedule that silently never fires. Fail loudly instead.
      if (entry.schedule) {
        try {
          const cronMod = await import('../cron.mjs');
          cronMod.parseCronSpec(entry.schedule);
        } catch (e) {
          console.error(`workflow add: invalid --cron spec "${entry.schedule}": ${e.message}`);
          process.exit(2);
        }
      }
      const cfg = readConfig();
      cfg.workflows = cfg.workflows || {};
      const priorSchedule = cfg.workflows[name] && cfg.workflows[name].schedule;
      cfg.workflows[name] = entry;
      writeConfig(cfg);
      // Reconcile the installed cron job with the stored schedule so the OS
      // scheduler always matches what `workflow show` reports:
      //   - schedule present → (re)install
      //   - schedule absent but one was installed before → remove the stale job
      //     (re-adding without --cron must stop the old cadence, not leave it
      //     firing).
      const { attachWorkflowCron, detachWorkflowCron } = await import('../workflow/named_cron.mjs');
      if (entry.schedule) {
        try { attachWorkflowCron(name, entry.schedule); }
        catch (e) { console.error(`workflow add: stored, but cron install failed: ${e.message}`); }
      } else if (priorSchedule) {
        try { detachWorkflowCron(name); }
        catch (e) { console.error(`workflow add: stored, but stale cron removal failed: ${e.message}`); }
      }
      emitJson({ ok: true, added: name, channel: entry.channel || null, schedule: entry.schedule || null });
      return;
    }

    case 'remove':
    case 'rm':
    case 'delete': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw workflow remove <name>'); process.exit(2); }
      const cfg = readConfig();
      if (!getNamedWorkflow(cfg, name)) { console.error(`workflow remove: no workflow "${name}"`); process.exit(2); }
      delete cfg.workflows[name];
      writeConfig(cfg);
      // Tear down any cron job installed for this workflow so the OS scheduler
      // stops firing `workflow run <name>` for a workflow that no longer exists
      // (which would fail forever). detachWorkflowCron is a no-op when nothing
      // was installed, so this is safe whether or not it had a schedule.
      try {
        const { detachWorkflowCron } = await import('../workflow/named_cron.mjs');
        detachWorkflowCron(name);
      } catch (e) { console.error(`workflow remove: removed, but cron cleanup failed: ${e.message}`); }
      emitJson({ ok: true, removed: name });
      return;
    }

    case 'run': {
      const name = positional[0];
      if (!name) { console.error('Usage: lazyclaw workflow run <name>'); process.exit(2); }
      const cfg = readConfig();
      try {
        const { result, reply, post } = await runNamedAndReport(name, cfg, {});
        emitJson({ ok: result.success, success: result.success, reply, post, ...(result.error ? { error: result.error, failedAt: result.failedAt } : {}) });
        if (!result.success) process.exit(1);
      } catch (e) { console.error(`workflow run: ${e.message}`); process.exit(1); }
      return;
    }

    default:
      console.error('Usage: lazyclaw workflow <list|show|add|remove|run> ...');
      process.exit(2);
  }
}

void configPath; // configPath kept available for callers that derive the dir.
