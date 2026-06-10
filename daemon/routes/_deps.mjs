// Dependency barrel for daemon route modules. Re-exports every
// module-level helper/import that route handler bodies reference, so each
// route module can pull them with a single import and the handler bodies
// stay byte-identical to their original form in makeHandler.

import fs from 'node:fs';
import nodePath from 'node:path';
export { fs, nodePath };

export { PROVIDERS, PROVIDER_INFO, maskApiKey } from '../../providers/registry.mjs';
export { costFromUsage, RATE_CARD_SHAPE } from '../../providers/rates.mjs';
export {
  composeSystemPrompt, listSkills, loadSkill, skillPath, installSkill,
  removeSkill, parseFrontmatter, defaultConfigDir as skillsDefaultConfigDir,
} from '../../skills.mjs';
export * as indexDb from '../../mas/index_db.mjs';
export * as skillSynth from '../../mas/skill_synth.mjs';
export { listBackends as sandboxListBackends } from '../../sandbox/index.mjs';
export {
  summarizeState, listSessions as listWorkflowSessions,
  loadStateFile as loadWorkflowState, aggregateNodeStats,
} from '../../workflow/summary.mjs';
export { validateConfig } from '../../config-validate.mjs';
export { validateRates } from '../../rates-validate.mjs';

export {
  fileExists, readJson, readTextBody, writeJson, writeSseHead, writeSse,
  statusForProviderError,
} from '../lib/respond.mjs';
export { checkCostCap, accumulateMetricsFromCost } from '../lib/cost.mjs';
export { resolveProvider } from '../lib/provider.mjs';
// F5/F6 — cross-channel handoff: the threads store + the rollback-aware
// migration helper, so the conversation routes can bind inbound messages to a
// persistent thread/session and re-point them across channels.
export { openThreads } from '../../channels/threads.mjs';
export { handoffWithRollback } from '../../channels/handoff.mjs';
// Phase 4 — /inbound idempotency: dedup retried/redelivered channel messages
// by their native message id so the provider runs once per message.
export { openDedup } from '../lib/inbound_dedup.mjs';
