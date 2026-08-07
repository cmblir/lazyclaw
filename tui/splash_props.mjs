// tui/splash_props.mjs — gather the dynamic props the splash panel needs
// (tool groups + skill groups), shared by the chat REPL and the setup wizard
// so both surfaces render the same pompos splash instead of drifting apart
// (the setup wizard used to show a small figlet banner instead).
import path from 'node:path';
import { configPath } from '../lib/config.mjs';

// Re-export the renderer so setup/onboarding callers need one import.
export { renderSplashToString } from './splash.mjs';

// Verbatim from the chat REPL's former inline block: collapse the v5 tool
// registry to one row per category, and group installed skills by their
// filename hyphen-prefix. Failures degrade to empty lists, never throw.
export async function gatherToolAndSkillGroups(cfgDir) {
  let tools = [];
  try {
    const registry = await import('../mas/tools/registry.mjs');
    const byCat = registry.byCategory();
    tools = Object.entries(byCat).map(([category, items]) => ({
      category,
      sensitive: items.some((t) => t.sensitive),
      verbs: items.map((t) => t.name.replace(/^[a-z]+_/, '')).slice(0, 6),
    })).sort((a, b) => a.category.localeCompare(b.category));
  } catch { /* registry unavailable → empty list */ }

  let skills = [];
  try {
    const { listSkills } = await import('../skills.mjs');
    const flat = listSkills(cfgDir);
    const byGroup = new Map();
    for (const s of flat) {
      const i = s.name.indexOf('-');
      const group = i > 0 ? s.name.slice(0, i) : 'general';
      const sub = i > 0 ? s.name.slice(i + 1) : s.name;
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(sub);
    }
    skills = [...byGroup.entries()]
      .map(([group, names]) => ({ group, names: names.slice(0, 6) }))
      .sort((a, b) => a.group.localeCompare(b.group));
  } catch { /* skills dir unavailable → empty list */ }

  return { tools, skills };
}

// Build the full splash props for the setup wizard. Self-contained (resolves
// the config dir itself) so call sites stay one line.
export async function splashPropsForSetup({ version = '', provider = '', model = '' } = {}) {
  const cfgDir = path.dirname(configPath());
  const { tools, skills } = await gatherToolAndSkillGroups(cfgDir);
  return { provider, model, trainer: {}, sessionId: '', cwd: process.cwd(), version, tools, skills };
}
