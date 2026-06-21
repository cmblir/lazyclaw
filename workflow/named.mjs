// workflow/named.mjs — stored, named declarative workflows + run-by-name.
//
// A named workflow lives in cfg.workflows[<name>] (alongside cfg.cron /
// cfg.channels), so it can be triggered by name from the CLI, a cron job, or an
// inbound Slack message — the Hermes-style automation spine. Entry shape:
//   cfg.workflows[name] = { def: { nodes:[...] }, channel?: 'slack:#x',
//                           schedule?: '0 9 * * *', replyNode?: 'reply' }
// The def is the same declarative format runDeclarativeRequest already runs;
// this module only adds storage + a name guard + reply-text selection.

import { runDeclarativeRequest } from './run_request.mjs';

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
export function validWorkflowName(name) {
  return typeof name === 'string' && name.length > 0 && NAME_RE.test(name);
}

export function getNamedWorkflow(cfg, name) {
  const entry = cfg && cfg.workflows && typeof cfg.workflows === 'object' ? cfg.workflows[name] : undefined;
  return entry && typeof entry === 'object' && entry.def ? entry : null;
}

export function listNamedWorkflows(cfg) {
  const ws = (cfg && cfg.workflows && typeof cfg.workflows === 'object') ? cfg.workflows : {};
  return Object.keys(ws).sort().map((name) => ({
    name,
    channel: ws[name]?.channel || null,
    schedule: ws[name]?.schedule || null,
    nodes: Array.isArray(ws[name]?.def?.nodes) ? ws[name].def.nodes.length : 0,
  }));
}

// Find the named workflow bound to an inbound channel (entry.channel, e.g.
// "slack:#ops" or "slack:C123"), or null. Used by POST /inbound to trigger a
// workflow on a Slack message. Matches the channel id/name after stripping the
// "slack:"/"#" prefixes so a binding written either way still resolves.
export function workflowForChannel(cfg, channel) {
  if (!channel) return null;
  const ws = (cfg && cfg.workflows && typeof cfg.workflows === 'object') ? cfg.workflows : {};
  const c = String(channel).replace(/^#/, '');
  for (const name of Object.keys(ws)) {
    const bound = ws[name] && ws[name].channel;
    if (!bound || !ws[name].def) continue;
    const target = String(bound).replace(/^slack:/, '').replace(/^#/, '');
    if (target === c) return { name, ...ws[name] };
  }
  return null;
}

// Run a stored workflow by name. opts is forwarded to runDeclarativeRequest
// (providerLookup for the llm node, fetchImpl, input, sessionId, signal).
export async function runNamedWorkflow(name, cfg, opts = {}) {
  const entry = getNamedWorkflow(cfg, name);
  if (!entry) throw new Error(`no workflow named "${name}"`);
  return runDeclarativeRequest(entry.def, cfg, opts);
}

// The text to surface back (Slack reply / CLI output): the explicitly-named
// replyNode if set, else the LAST node's output. A workflow ending in an
// http/json node returns an object, so authors should name a reply node.
export function namedReplyText(result, entry = {}) {
  const session = (result && result.session) || {};
  if (entry.replyNode && entry.replyNode in session) {
    const v = session[entry.replyNode];
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  const keys = Object.keys(session);
  if (!keys.length) return '';
  const v = session[keys[keys.length - 1]];
  return typeof v === 'string' ? v : JSON.stringify(v);
}
