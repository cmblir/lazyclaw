// Ordered route table for the daemon. The dispatch loop in makeHandler
// walks this array top-to-bottom and runs the first entry whose `m`
// predicate matches the request — FIRST MATCH WINS.
//
// The order here is IDENTICAL to the original makeHandler `switch (true)`
// case order. Several predicates are exclusion-based (e.g.
// `providerMatch[1] !== 'test'`, `configKeyMatch[1] !== 'validate'`) and
// rely on that ordering to stay correct. DO NOT REORDER.
//
// `m(c)` receives the per-request dispatch context built in makeHandler
// (route/method/url + the pre-computed path-param regex matches). `h(c)`
// is the matching route handler.

import * as meta from './routes/meta.mjs';
import * as providers from './routes/providers.mjs';
import * as rates from './routes/rates.mjs';
import * as config from './routes/config.mjs';
import * as sessions from './routes/sessions.mjs';
import * as workflows from './routes/workflows.mjs';
import * as skills from './routes/skills.mjs';
import * as conversation from './routes/conversation.mjs';
import * as registry from './routes/registry.mjs';
import * as ops from './routes/ops.mjs';
import * as events from './routes/events.mjs';
import * as scheduling from './routes/scheduling.mjs';

export const ROUTES = [
  { m: (c) => c.route === 'GET /' || c.route === 'GET /dashboard' || c.route === 'GET /dashboard/', h: meta.dashboard },
  { m: (c) => c.route === 'GET /dashboard.css', h: meta.dashboardCss },
  { m: (c) => c.route === 'GET /dashboard.js', h: meta.dashboardJs },
  { m: (c) => c.req.method === 'GET' && /^\/ui\/(?:[a-z0-9_-]+\/)?[a-z0-9_-]+\.mjs$/.test(c.path || ''), h: meta.uiModule },
  { m: (c) => c.req.method === 'GET' && /^\/avatars\/\d{2}\.png$/.test(c.path || ''), h: meta.avatar },
  { m: (c) => c.req.method === 'GET' && /^\/agent-avatars\/[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp)$/i.test(c.path || ''), h: meta.agentAvatar },
  { m: (c) => c.route === 'GET /version', h: meta.version },
  { m: (c) => c.route === 'POST /exec/request', h: conversation.execRequest },
  { m: (c) => c.route === 'GET /health' || c.route === 'GET /healthz', h: meta.health },
  { m: (c) => c.route === 'GET /metrics', h: meta.metrics },
  { m: (c) => c.route === 'GET /events', h: events.events },
  { m: (c) => c.route === 'GET /providers', h: providers.providersList },
  { m: (c) => c.req.method === 'GET' && !!c.providerMatch && c.providerMatch[1] !== 'test', h: providers.providerGet },
  { m: (c) => c.route === 'GET /providers/test', h: providers.providersTest },
  { m: (c) => c.req.method === 'GET' && !!c.providerTestMatch, h: providers.providerTest },
  { m: (c) => c.route === 'POST /providers', h: providers.providersCreate },
  { m: (c) => c.req.method === 'DELETE' && !!c.providerMatch && c.providerMatch[1] !== 'test', h: providers.providerDelete },
  { m: (c) => c.route === 'GET /rates', h: rates.ratesList },
  { m: (c) => c.route === 'GET /rates/validate', h: rates.ratesValidate },
  { m: (c) => c.route === 'GET /rates/shape', h: rates.ratesShape },
  { m: (c) => c.req.method === 'PUT' && !!c.ratesKeyMatch && c.ratesKeyMatch[1] !== 'validate' && c.ratesKeyMatch[1] !== 'shape', h: rates.ratePut },
  { m: (c) => c.req.method === 'DELETE' && !!c.ratesKeyMatch && c.ratesKeyMatch[1] !== 'validate' && c.ratesKeyMatch[1] !== 'shape', h: rates.rateDelete },
  { m: (c) => c.route === 'GET /status', h: meta.status },
  { m: (c) => c.route === 'GET /config/validate', h: config.configValidate },
  { m: (c) => c.route === 'GET /config', h: config.configGet },
  { m: (c) => c.req.method === 'GET' && !!c.configKeyMatch && c.configKeyMatch[1] !== 'validate', h: config.configKeyGet },
  { m: (c) => c.req.method === 'PUT' && !!c.configKeyMatch && c.configKeyMatch[1] !== 'validate', h: config.configKeyPut },
  { m: (c) => c.req.method === 'DELETE' && !!c.configKeyMatch && c.configKeyMatch[1] !== 'validate', h: config.configKeyDelete },
  { m: (c) => c.route === 'GET /doctor', h: meta.doctor },
  { m: (c) => c.route === 'GET /sessions', h: sessions.sessionsList },
  { m: (c) => c.route === 'GET /sessions/search', h: sessions.sessionsSearch },
  { m: (c) => c.req.method === 'GET' && !!c.sessionExportMatch, h: sessions.sessionExport },
  { m: (c) => c.req.method === 'GET' && !!c.sessionMatch, h: sessions.sessionGet },
  { m: (c) => c.route === 'POST /workflows/run', h: workflows.workflowRun },
  { m: (c) => c.route === 'GET /workflows/aggregate', h: workflows.workflowsAggregate },
  { m: (c) => c.route === 'GET /workflows', h: workflows.workflowsList },
  { m: (c) => c.req.method === 'GET' && !!c.workflowMatch, h: workflows.workflowGet },
  { m: (c) => c.route === 'GET /skills', h: skills.skillsList },
  { m: (c) => c.route === 'GET /skills/suggestions', h: skills.skillsSuggestions },
  { m: (c) => c.route === 'POST /skills/synth', h: skills.skillsSynth },
  { m: (c) => c.route === 'GET /skills/search', h: skills.skillsSearch },
  { m: (c) => c.req.method === 'GET' && !!c.skillMatch, h: skills.skillGet },
  { m: (c) => c.req.method === 'PUT' && !!c.skillMatch, h: skills.skillPut },
  { m: (c) => c.req.method === 'DELETE' && !!c.skillMatch, h: skills.skillDelete },
  { m: (c) => c.req.method === 'DELETE' && !!c.sessionMatch, h: sessions.sessionDelete },
  { m: (c) => c.req.method === 'DELETE' && !!c.workflowMatch, h: workflows.workflowDelete },
  { m: (c) => c.route === 'POST /chat', h: conversation.chat },
  { m: (c) => c.route === 'POST /inbound', h: conversation.inbound },
  { m: (c) => c.route === 'POST /handoff', h: conversation.handoff },
  { m: (c) => c.route === 'POST /agent', h: conversation.agent },
  { m: (c) => c.route === 'GET /agents', h: registry.agentsList },
  { m: (c) => c.route === 'POST /agents', h: registry.agentsCreate },
  { m: (c) => c.req.method === 'GET' && /^\/agents\/([^/]+)$/.test(c.url.pathname), h: registry.agentGet },
  { m: (c) => c.req.method === 'PATCH' && /^\/agents\/([^/]+)$/.test(c.url.pathname), h: registry.agentPatch },
  { m: (c) => c.req.method === 'DELETE' && /^\/agents\/([^/]+)$/.test(c.url.pathname), h: registry.agentDelete },
  { m: (c) => c.req.method === 'GET' && /^\/agents\/([^/]+)\/memory$/.test(c.url.pathname), h: registry.agentMemoryGet },
  { m: (c) => c.req.method === 'PUT' && /^\/agents\/([^/]+)\/memory$/.test(c.url.pathname), h: registry.agentMemoryPut },
  { m: (c) => c.req.method === 'DELETE' && /^\/agents\/([^/]+)\/memory$/.test(c.url.pathname), h: registry.agentMemoryDelete },
  { m: (c) => c.route === 'GET /teams', h: registry.teamsList },
  { m: (c) => c.route === 'POST /teams', h: registry.teamsCreate },
  { m: (c) => c.req.method === 'GET' && /^\/teams\/([^/]+)$/.test(c.url.pathname), h: registry.teamGet },
  { m: (c) => c.req.method === 'PATCH' && /^\/teams\/([^/]+)$/.test(c.url.pathname), h: registry.teamPatch },
  { m: (c) => c.req.method === 'DELETE' && /^\/teams\/([^/]+)$/.test(c.url.pathname), h: registry.teamDelete },
  { m: (c) => c.route === 'GET /tasks', h: registry.tasksList },
  { m: (c) => c.req.method === 'GET' && /^\/tasks\/([^/]+)\/transcript$/.test(c.url.pathname), h: registry.taskTranscript },
  { m: (c) => c.req.method === 'GET' && /^\/tasks\/([^/]+)$/.test(c.url.pathname), h: registry.taskGet },
  { m: (c) => c.req.method === 'DELETE' && /^\/tasks\/([^/]+)$/.test(c.url.pathname), h: registry.taskDelete },
  { m: (c) => c.req.method === 'POST' && /^\/tasks\/([^/]+)\/(done|abandon)$/.test(c.url.pathname), h: registry.taskAction },
  { m: (c) => c.route === 'GET /trainer/status', h: ops.trainerStatus },
  { m: (c) => c.route === 'GET /recall', h: ops.recall },
  { m: (c) => c.route === 'GET /sandbox', h: ops.sandboxList },
  { m: (c) => c.req.method === 'POST' && /^\/sandbox\/([^/]+)\/test$/.test(c.url.pathname), h: ops.sandboxTest },
  { m: (c) => c.route === 'POST /sandbox/use', h: ops.sandboxUse },
  { m: (c) => c.route === 'GET /channels', h: ops.channels },
  { m: (c) => c.route === 'GET /scheduling', h: scheduling.schedulingList },
  { m: (c) => c.req.method === 'DELETE' && /^\/cron\/([^/]+)$/.test(c.url.pathname), h: scheduling.cronDelete },
  { m: (c) => c.route === 'POST /index/rebuild', h: ops.indexRebuild },
];
