import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Phase 26 — integration of the P1/P3 modules into the CLI:
//   - `telegram listen` is registered (usage on bad subcommand)
//   - `skills curate` / `skills classify` drive the curator
//   - `workspace init` scaffolds HEARTBEAT.md
//   - skill_view records usage for the curator

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpDir(p: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${p}-`)); }
function runCli(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env } });
}
async function loadSkills() {
  return await import(pathToFileURL(path.join(REPO_ROOT, 'skills.mjs')).href) as typeof import('../skills.mjs');
}

const DAY = 24 * 60 * 60 * 1000;

test.describe('Phase 26 — roadmap integration', () => {
  test('telegram is a registered subcommand; bad subcommand prints usage', () => {
    const cfg = tmpDir('p26-tg');
    const r = runCli(['telegram', 'bogus'], cfg);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/telegram listen/);
    expect(r.stderr).toMatch(/TELEGRAM_BOT_TOKEN/);
  });

  test('workspace init scaffolds HEARTBEAT.md alongside the other three files', () => {
    const cfg = tmpDir('p26-ws');
    const r = runCli(['workspace', 'init', 'home'], cfg);
    expect(r.status).toBe(0);
    const dir = path.join(cfg, 'workspaces', 'home');
    for (const f of ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md']) {
      expect(fs.existsSync(path.join(dir, f))).toBe(true);
    }
    expect(fs.readFileSync(path.join(dir, 'HEARTBEAT.md'), 'utf8')).toMatch(/proactive|Heartbeat/i);
  });

  test('skills curate archives an idle agent skill and leaves a human one', async () => {
    const cfg = tmpDir('p26-curate');
    const skills = await loadSkills();
    // An agent-authored skill, recorded as used ~91 days ago.
    skills.installSkill('old-agent', '---\nname: old-agent\ndescription: d\ncreated_by: agent\n---\n\n## When to Use\nx\n', cfg);
    skills.installSkill('human-skill', '---\nname: human-skill\ndescription: d\n---\n\nhuman\n', cfg);
    const curator = await import(pathToFileURL(path.join(REPO_ROOT, 'skills_curator.mjs')).href) as typeof import('../skills_curator.mjs');
    const now = 1_000 * DAY;
    curator.recordUsage('old-agent', cfg, now - 91 * DAY);
    curator.recordUsage('human-skill', cfg, now - 91 * DAY);

    const r = runCli(['skills', 'curate'], cfg);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.archived).toContain('old-agent');
    // Human skill is never physically archived.
    expect(fs.existsSync(path.join(cfg, 'skills', 'human-skill.md'))).toBe(true);
    expect(fs.existsSync(path.join(cfg, 'skills', '.archive', 'old-agent.md'))).toBe(true);
  });

  test('skill_view records a usage hit the curator can read', async () => {
    const cfg = tmpDir('p26-usage');
    const skills = await loadSkills();
    skills.installSkill('viewed', '---\nname: viewed\ndescription: d\ncreated_by: agent\n---\n\n## When to Use\nx\n', cfg);
    const runner = await import(pathToFileURL(path.join(REPO_ROOT, 'mas', 'tool_runner.mjs')).href) as typeof import('../mas/tool_runner.mjs');
    const agent = { name: 'a', tools: ['skill_view'] };
    const res = await runner.runTool({ agent, tool: 'skill_view', args: { name: 'viewed' }, configDir: cfg });
    expect(res.ok).toBe(true);

    const curator = await import(pathToFileURL(path.join(REPO_ROOT, 'skills_curator.mjs')).href) as typeof import('../skills_curator.mjs');
    const usage = curator.usageOf('viewed', cfg);
    expect(usage.views + usage.uses).toBeGreaterThan(0);
  });
});
