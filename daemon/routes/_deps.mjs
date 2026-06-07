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
