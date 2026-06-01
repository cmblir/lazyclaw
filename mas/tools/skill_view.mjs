// skill_view tool — Phase 20.
//
// Read-only progressive-disclosure loader: the mention-router injects a
// compact skills *index* (name + one-line summary) into the system
// prompt, and the agent calls skill_view to pull the FULL text of a
// skill only when it decides one is relevant. This keeps skill bodies
// out of the prompt until they're actually needed.
//
// Unlike bash/read/write/grep this tool is rooted at the lazyclaw
// config dir (where skills live), not the task cwd, so it takes
// configDir from the tool-runner opts rather than cwd.

import * as skills from '../../skills.mjs';

export const NAME = 'skill_view';
export const DESCRIPTION =
  'Load the full text of a named skill from the skills index (its When-to-Use, Procedure, Pitfalls and Verification sections). Call this when a skill listed in the index looks relevant to the current task.';
export const PARAMETERS = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'The skill name exactly as shown in the skills index.' },
  },
  required: ['name'],
};

export async function exec(args, { configDir } = {}) {
  if (!args || typeof args.name !== 'string' || !args.name.trim()) {
    return { ok: false, error: 'skill_view: name is required' };
  }
  const name = args.name.trim();
  try {
    const content = skills.loadSkill(name, configDir);
    return { ok: true, name, content };
  } catch (err) {
    return { ok: false, error: `skill_view: ${err?.message || err}` };
  }
}
