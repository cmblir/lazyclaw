import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Phase 20 — Hermes-style self-improving skills.
//
//   A. skills.mjs frontmatter parsing + compact skills index (L0 recall)
//   B. mas/skill_synth.mjs deterministic helpers (slug/parse/assemble)
//   C. skill_view tool + tool_runner configDir passthrough
//   D. skillWrite config knob on the agent record
//   E. synthesizeSkill LLM call + `agent skill-synth` CLI + auto path
//   F. recall index injection into the mention-router turn context

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, 'cli.mjs');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

function runCli(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env },
  });
}

async function loadSkills() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'skills.mjs')).href;
  return await import(url) as typeof import('../skills.mjs');
}

async function loadSynth() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'skill_synth.mjs')).href;
  return await import(url) as typeof import('../mas/skill_synth.mjs');
}

async function loadRunner() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'tool_runner.mjs')).href;
  return await import(url) as typeof import('../mas/tool_runner.mjs');
}

async function loadRedact() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'redact.mjs')).href;
  return await import(url) as typeof import('../mas/redact.mjs');
}

function runCliAsync(args: string[], cfgDir: string, env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, LAZYCLAW_CONFIG_DIR: cfgDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

interface MockResp { status?: number; json: Record<string, unknown>; }
function startMockAnthropic(): Promise<{ baseUrl: string; queue: MockResp[]; posts: Array<{ body: Record<string, unknown> }>; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const queue: MockResp[] = [];
    const posts: Array<{ body: Record<string, unknown> }> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c.toString(); });
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* leave empty */ }
        posts.push({ body: parsed });
        const next = queue.shift();
        if (!next) { res.writeHead(500); res.end('queue empty'); return; }
        res.writeHead(next.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(next.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        queue, posts,
        close: () => new Promise<void>((r) => {
          try { server.closeAllConnections(); } catch { /* node <18 */ }
          server.close(() => r());
        }),
      });
    });
  });
}

function anthropicTextReply(id: string, text: string): MockResp {
  return { json: { id, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } };
}

const SYNTH_REPLY = [
  'name: Deploy Flow',
  'description: ship the app safely with a rollback path',
  '',
  '## When to Use',
  'When deploying to prod.',
  '## Procedure',
  '1. run the test suite',
  '2. tag the release',
  '## Pitfalls',
  '- forgetting to run migrations',
  '## Verification',
  '- smoke test returns 200',
].join('\n');

function seedAgentTeamAuth(cfg: string, opts: { skillWrite?: string } = {}) {
  const addArgs = ['agent', 'add', 'planner', '--provider', 'anthropic'];
  if (opts.skillWrite) addArgs.push('--skill-write', opts.skillWrite);
  expect(runCli(addArgs, cfg).status).toBe(0);
  expect(runCli(['team', 'add', 'shop', '--agents', 'planner'], cfg).status).toBe(0);
  expect(runCli(['auth', 'add', 'anthropic', 'sk-test', '--label', 'm'], cfg).status).toBe(0);
  expect(runCli(['auth', 'use', 'anthropic', 'm'], cfg).status).toBe(0);
}

test.describe('Phase 20A — skills frontmatter + index', () => {
  test('parseFrontmatter splits YAML frontmatter from the body', async () => {
    const mod = await loadSkills();
    const content = '---\nname: deploy-flow\ndescription: ship the app safely\nversion: 1\ncreated_by: agent\n---\n\n## When to Use\nwhen shipping\n';
    const { meta, body } = mod.parseFrontmatter(content);
    expect(meta.name).toBe('deploy-flow');
    expect(meta.description).toBe('ship the app safely');
    expect(meta.created_by).toBe('agent');
    expect(body.startsWith('## When to Use')).toBe(true);
  });

  test('parseFrontmatter returns empty meta + full body when no frontmatter present', async () => {
    const mod = await loadSkills();
    const content = '# Review skill\n\nDo a careful review.\n';
    const { meta, body } = mod.parseFrontmatter(content);
    expect(meta).toEqual({});
    expect(body).toBe(content);
  });

  test('listSkills prefers frontmatter description for summary and exposes createdBy', async () => {
    const cfg = tmpDir('p20a-list');
    const mod = await loadSkills();
    mod.installSkill('deploy-flow', '---\nname: deploy-flow\ndescription: ship the app safely\ncreated_by: agent\n---\n\n## When to Use\nx\n', cfg);
    // A legacy skill with no frontmatter must still resolve a summary.
    mod.installSkill('review', '# Review skill\n\nbody\n', cfg);

    const list = mod.listSkills(cfg);
    const deploy = list.find((s) => s.name === 'deploy-flow')!;
    const review = list.find((s) => s.name === 'review')!;
    expect(deploy.summary).toBe('ship the app safely');
    expect(deploy.createdBy).toBe('agent');
    expect(review.summary).toBe('Review skill');     // first heading, '#' stripped
    expect(review.createdBy).toBe('');               // unknown for legacy skills
  });

  test('skillsIndex emits a compact one-line-per-skill block, empty when none', async () => {
    const cfg = tmpDir('p20a-index');
    const mod = await loadSkills();
    expect(mod.skillsIndex(cfg)).toBe('');

    mod.installSkill('deploy-flow', '---\nname: deploy-flow\ndescription: ship the app safely\n---\n\nbody\n', cfg);
    mod.installSkill('review', '# Careful review\n\nbody\n', cfg);

    const idx = mod.skillsIndex(cfg);
    expect(idx).toContain('deploy-flow: ship the app safely');
    expect(idx).toContain('review: Careful review');
    // Sorted by name → deploy-flow before review.
    expect(idx.indexOf('deploy-flow')).toBeLessThan(idx.indexOf('review'));
  });
});

test.describe('Phase 20B — skill_synth deterministic helpers', () => {
  test('slugifySkill lowercases, collapses non-alnum to single dashes, trims', async () => {
    const mod = await loadSynth();
    expect(mod.slugifySkill('Deploy the App!')).toBe('deploy-the-app');
    expect(mod.slugifySkill('  Fix   N+1  queries  ')).toBe('fix-n-1-queries');
    expect(mod.slugifySkill('---weird___name---')).toBe('weird-name');
    expect(mod.slugifySkill('')).toBe('skill');          // fallback for empty
  });

  test('parseSynthOutput extracts name/description and a body starting at the first section', async () => {
    const mod = await loadSynth();
    const out = [
      'name: Deploy Flow',
      'description: Ship the app safely with a rollback path',
      '',
      '## When to Use',
      'When deploying to prod.',
      '## Procedure',
      '1. run tests',
      '## Pitfalls',
      '- forgetting migrations',
      '## Verification',
      '- smoke test passes',
      '',
    ].join('\n');
    const r = mod.parseSynthOutput(out);
    expect(r.name).toBe('deploy-flow');               // slugified
    expect(r.description).toBe('Ship the app safely with a rollback path');
    expect(r.body.startsWith('## When to Use')).toBe(true);
    expect(r.body).toContain('## Verification');
    expect(r.body).not.toContain('description:');     // header stripped from body
  });

  test('parseSynthOutput falls back to the first heading when name/description lines are absent', async () => {
    const mod = await loadSynth();
    const out = '## When to Use\nwhen X\n## Procedure\ndo Y\n';
    const r = mod.parseSynthOutput(out);
    expect(r.name).toBe('when-to-use');               // derived from first heading
    expect(r.description).toBe('');
    expect(r.body.startsWith('## When to Use')).toBe(true);
  });

  test('assembleSkillDoc builds frontmatter that round-trips through parseFrontmatter', async () => {
    const synth = await loadSynth();
    const skills = await loadSkills();
    const doc = synth.assembleSkillDoc({
      name: 'deploy-flow',
      description: 'ship safely',
      createdBy: 'agent',
      sourceTask: 't_42',
      body: '## When to Use\nx\n',
      ts: new Date('2026-06-01T00:00:00Z'),
    });
    const { meta, body } = skills.parseFrontmatter(doc);
    expect(meta.name).toBe('deploy-flow');
    expect(meta.description).toBe('ship safely');
    expect(meta.created_by).toBe('agent');
    expect(meta.source_task).toBe('t_42');
    expect(meta.created_at).toBe('2026-06-01');
    expect(body.startsWith('## When to Use')).toBe(true);
  });
});

test.describe('Phase 20C — skill_view tool', () => {
  const agent = { name: 'planner', tools: ['bash', 'read', 'write', 'grep', 'skill_view'] };

  test('listToolSchemas advertises skill_view with a name param', async () => {
    const runner = await loadRunner();
    const schemas = runner.listToolSchemas(['skill_view']);
    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe('skill_view');
    expect(schemas[0].parameters.required).toContain('name');
  });

  test('runTool(skill_view) returns the full SKILL.md for an installed skill', async () => {
    const cfg = tmpDir('p20c-view');
    const skills = await loadSkills();
    const runner = await loadRunner();
    skills.installSkill('deploy-flow', '---\nname: deploy-flow\ndescription: ship\n---\n\n## When to Use\nprod deploys\n', cfg);

    const res = await runner.runTool({ agent, tool: 'skill_view', args: { name: 'deploy-flow' }, configDir: cfg });
    expect(res.ok).toBe(true);
    expect(res.content).toContain('## When to Use');
    expect(res.content).toContain('prod deploys');
  });

  test('runTool(skill_view) returns ok:false for an unknown skill', async () => {
    const cfg = tmpDir('p20c-miss');
    const runner = await loadRunner();
    const res = await runner.runTool({ agent, tool: 'skill_view', args: { name: 'nope' }, configDir: cfg });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found|skill_view/);
  });

  test('agent add gives new agents skill_view in the default tool whitelist', async () => {
    const cfg = tmpDir('p20c-default');
    const r = runCli(['agent', 'add', 'planner'], cfg);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.tools).toContain('skill_view');
  });
});

test.describe('Phase 20D — skillWrite config knob', () => {
  test('agent add defaults skillWrite to "auto"', async () => {
    // v5 Group A (M3): default flipped from 'manual' to 'auto' so the
    // learning loop closes end-to-end on a fresh install. Operators
    // who want the old manual behaviour pass --skill-write manual.
    const cfg = tmpDir('p20d-default');
    const r = runCli(['agent', 'add', 'planner'], cfg);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).skillWrite).toBe('auto');
  });

  test('agent add --skill-write auto persists the chosen mode', async () => {
    const cfg = tmpDir('p20d-auto');
    const r = runCli(['agent', 'add', 'planner', '--skill-write', 'auto'], cfg);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).skillWrite).toBe('auto');
  });

  test('agent add --skill-write rejects an invalid mode', async () => {
    const cfg = tmpDir('p20d-bad');
    const r = runCli(['agent', 'add', 'planner', '--skill-write', 'sometimes'], cfg);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/skillWrite must be one of/);
  });
});

test.describe('Phase 20E — synthesizeSkill + CLI + auto path', () => {
  test('synthesizeSkill turns a task transcript into a structured SKILL.md', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push(anthropicTextReply('s1', SYNTH_REPLY));
    const synth = await loadSynth();
    const skills = await loadSkills();

    const agent = { name: 'planner', provider: 'anthropic', model: 'claude-opus-4-7', role: 'planner' };
    const task = { id: 't_99', title: 'ship it', turns: [{ agent: 'user', text: 'deploy' }, { agent: 'planner', text: 'done' }] };
    const r = await synth.synthesizeSkill({ agent, task, apiKey: 'sk-test', baseUrl: mock.baseUrl });
    expect(r).not.toBeNull();
    expect(r!.name).toBe('deploy-flow');
    const { meta, body } = skills.parseFrontmatter(r!.doc);
    expect(meta.created_by).toBe('agent');
    expect(meta.source_task).toBe('t_99');
    expect(body).toContain('## Verification');
    await mock.close();
  });

  test('agent skill-synth writes a SKILL.md into the skills dir', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push(anthropicTextReply('s1', SYNTH_REPLY));
    const cfg = tmpDir('p20e-cli');
    seedAgentTeamAuth(cfg);
    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'ship'], cfg).stdout);

    const r = await runCliAsync(['agent', 'skill-synth', 'planner', '--task', open.id], cfg, { LAZYCLAW_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(r.status).toBe(0);

    const skills = await loadSkills();
    const list = skills.listSkills(cfg);
    const deploy = list.find((s) => s.name === 'deploy-flow');
    expect(deploy).toBeTruthy();
    expect(deploy!.createdBy).toBe('agent');
    await mock.close();
  });

  test('agent skill-synth --dry-run prints the doc but writes nothing', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push(anthropicTextReply('s1', SYNTH_REPLY));
    const cfg = tmpDir('p20e-dry');
    seedAgentTeamAuth(cfg);
    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'ship'], cfg).stdout);

    const r = await runCliAsync(['agent', 'skill-synth', 'planner', '--task', open.id, '--dry-run'], cfg, { LAZYCLAW_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('## When to Use');

    const skills = await loadSkills();
    expect(skills.listSkills(cfg)).toHaveLength(0);   // nothing written on dry-run
    await mock.close();
  });

  test('skillWrite=auto synthesises a skill on TASK_DONE', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push(anthropicTextReply('m1', 'wrapping up [[TASK_DONE]]'));   // lead turn
    mock.queue.push(anthropicTextReply('m2', SYNTH_REPLY));                   // auto synth
    const cfg = tmpDir('p20e-auto');
    seedAgentTeamAuth(cfg, { skillWrite: 'auto' });

    // Silence the memory reflection so only the skill-synth call is queued.
    const agentFile = path.join(cfg, 'agents', 'planner.json');
    const rec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    rec.memoryWrite = 'off';
    fs.writeFileSync(agentFile, JSON.stringify(rec, null, 2));

    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'wrap'], cfg).stdout);
    const tick = await runCliAsync(['task', 'tick', open.id, 'go'], cfg, { LAZYCLAW_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(tick.status).toBe(0);
    expect(JSON.parse(tick.stdout).stoppedBy).toBe('done');

    const skills = await loadSkills();
    expect(skills.listSkills(cfg).some((s) => s.name === 'deploy-flow')).toBe(true);
    await mock.close();
  });
});

test.describe('Phase 20F — recall index injected into the turn context', () => {
  test('the skills index + skill_view tool reach the model on a real turn', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push(anthropicTextReply('m1', 'on it [[TASK_DONE]]'));   // lead turn
    mock.queue.push(anthropicTextReply('m2', '- learned something'));   // auto reflection (memoryWrite default auto)
    const cfg = tmpDir('p20f');
    seedAgentTeamAuth(cfg);

    // Install a skill so the index is non-empty when the turn is built.
    const skills = await loadSkills();
    skills.installSkill('deploy-flow', '---\nname: deploy-flow\ndescription: ship the app safely\n---\n\n## When to Use\nprod\n', cfg);

    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'now'], cfg).stdout);
    const tick = await runCliAsync(['task', 'tick', open.id, 'go'], cfg, { LAZYCLAW_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(tick.status).toBe(0);

    const first = mock.posts[0].body as { system: string | Array<{ text: string }>; tools: Array<{ name: string }> };
    // Group B / C9 — mention router passes cache:true, so the tool-use
    // adapter lifts body.system into a single-block array. Normalise.
    const sysText = typeof first.system === 'string'
      ? first.system
      : (first.system || []).map((b) => b.text || '').join('\n');
    // L0 index present in the system prompt …
    expect(sysText).toContain('deploy-flow: ship the app safely');
    expect(sysText).toMatch(/skill_view/);
    // … and the skill_view tool is actually advertised so the agent can pull L1.
    expect(first.tools.map((t) => t.name)).toContain('skill_view');
    await mock.close();
  });

  test('no skills installed → no skills block in the system prompt', async () => {
    const mock = await startMockAnthropic();
    mock.queue.push(anthropicTextReply('m1', 'done here [[TASK_DONE]]'));
    mock.queue.push(anthropicTextReply('m2', '- a lesson'));
    const cfg = tmpDir('p20f-empty');
    seedAgentTeamAuth(cfg);

    const open = JSON.parse(runCli(['task', 'start', '--team', 'shop', '--title', 'now'], cfg).stdout);
    const tick = await runCliAsync(['task', 'tick', open.id, 'go'], cfg, { LAZYCLAW_ANTHROPIC_BASE_URL: mock.baseUrl });
    expect(tick.status).toBe(0);

    const first = mock.posts[0].body as { system: string | Array<{ text: string }> };
    const sysText = typeof first.system === 'string'
      ? first.system
      : (first.system || []).map((b) => b.text || '').join('\n');
    expect(sysText).not.toMatch(/Skills available/i);
    await mock.close();
  });
});

test.describe('Phase 20H — review hardening', () => {
  test('synthesizeSkill redacts secrets from both the outgoing transcript and the saved body', async () => {
    const mock = await startMockAnthropic();
    const replyWithSecret = SYNTH_REPLY.replace('1. run the test suite', '1. export OPENAI_API_KEY=sk-live1234567890abcdef');
    mock.queue.push(anthropicTextReply('s1', replyWithSecret));
    const synth = await loadSynth();

    const agent = { name: 'planner', provider: 'anthropic', model: 'm', role: 'r' };
    const task = { id: 't_sec', title: 'leaky', turns: [{ agent: 'user', text: 'my key is sk-live1234567890abcdef keep it' }] };
    const r = await synth.synthesizeSkill({ agent, task, apiKey: 'sk-test', baseUrl: mock.baseUrl });

    // Outgoing prompt to the model must not carry the transcript secret verbatim.
    const sent = JSON.stringify(mock.posts[0].body);
    expect(sent).not.toContain('sk-live1234567890abcdef');
    // And the saved skill body must not carry the model-echoed secret.
    expect(r!.doc).not.toContain('sk-live1234567890abcdef');
    expect(r!.doc).toContain('[REDACTED]');
    await mock.close();
  });

  test('synthesizeSkill neutralises a [[TASK_DONE]] marker and caps an oversized body', async () => {
    const mock = await startMockAnthropic();
    const huge = '## When to Use\n' + 'x'.repeat(40_000) + '\n## Procedure\nstep [[TASK_DONE]] now\n';
    mock.queue.push(anthropicTextReply('s1', 'name: big\ndescription: d\n\n' + huge));
    const synth = await loadSynth();
    const r = await synth.synthesizeSkill({ agent: { name: 'p', provider: 'anthropic', model: 'm', role: '' }, task: { id: 't_big', title: 't', turns: [] }, apiKey: 'k', baseUrl: mock.baseUrl });
    expect(r!.doc).not.toContain('[[TASK_DONE]]');     // marker neutralised
    expect(r!.doc.length).toBeLessThan(10_000);        // body capped (~8 KB + frontmatter)
    await mock.close();
  });

  test('installSynthesized never clobbers a human-authored skill; bumps version when improving its own', async () => {
    const cfg = tmpDir('p20h-clobber');
    const synth = await loadSynth();
    const skills = await loadSkills();
    // A human-authored skill (no created_by: agent).
    skills.installSkill('deploy-flow', '---\nname: deploy-flow\ndescription: HUMAN AUTHORED\n---\n\nhuman body\n', cfg);

    const r1 = synth.installSynthesized({ name: 'deploy-flow', description: 'agent v1', body: '## When to Use\nx\n', sourceTask: 't1' }, cfg);
    expect(r1.skill).toBe('deploy-flow-1');                          // dodged the human skill
    expect(skills.loadSkill('deploy-flow', cfg)).toContain('human body');   // human skill untouched
    expect(skills.loadSkill('deploy-flow-1', cfg)).toContain('agent v1');

    // Improving its own agent skill overwrites in place and bumps version.
    const r2 = synth.installSynthesized({ name: 'deploy-flow-1', description: 'agent v2', body: '## When to Use\ny\n', sourceTask: 't2' }, cfg);
    expect(r2.skill).toBe('deploy-flow-1');
    expect(r2.version).toBe(2);
    const { meta } = skills.parseFrontmatter(skills.loadSkill('deploy-flow-1', cfg));
    expect(meta.version).toBe('2');
  });

  test('agent edit --skill-write flips the trigger after creation', async () => {
    const cfg = tmpDir('p20h-edit');
    expect(runCli(['agent', 'add', 'planner'], cfg).status).toBe(0);
    const ed = runCli(['agent', 'edit', 'planner', '--skill-write', 'auto'], cfg);
    expect(ed.status).toBe(0);
    expect(JSON.parse(ed.stdout).skillWrite).toBe('auto');
    // Invalid value is rejected with the validation message.
    const bad = runCli(['agent', 'edit', 'planner', '--skill-write', 'nope'], cfg);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/skillWrite must be one of/);
  });

  test('a description containing a double-quote round-trips through frontmatter without backslash corruption', async () => {
    const synth = await loadSynth();
    const skills = await loadSkills();
    // Colon forces escapeYaml to quote; the embedded double-quote then
    // exercises the quote/unquote symmetry.
    const desc = 'fast path: use "this" when shipping';
    const doc = synth.assembleSkillDoc({ name: 'q', description: desc, body: '## When to Use\nx\n' });
    const { meta } = skills.parseFrontmatter(doc);
    expect(meta.description).toBe(desc);
    expect(meta.description).not.toContain('\\"');
  });
});

test.describe('Phase 20I — name + escapeYaml injection hardening', () => {
  // Finding #1 — installSynthesized must slugify the caller-supplied name so a
  // newline/colon-laden name cannot inject a frontmatter key or smuggle a
  // newline into the on-disk filename.
  test('installSynthesized slugifies a newline/colon-laden name (no injected key, safe filename)', async () => {
    const cfg = tmpDir('p20i-inject');
    const synth = await loadSynth();
    const skills = await loadSkills();

    const evil = 'ok\nmalicious_key: pwned';
    const r = synth.installSynthesized(
      { name: evil, description: 'd', body: '## When to Use\nx\n', sourceTask: 't_inj' },
      cfg,
    );

    // The reserved skill name is a clean slug — no newline, colon, or space.
    expect(r.skill).toBe('ok-malicious-key-pwned');
    expect(r.skill).not.toMatch(/[\n:\s]/);

    // The on-disk filename carries no embedded newline.
    expect(r.path).not.toContain('\n');
    expect(path.basename(r.path)).toBe('ok-malicious-key-pwned.md');

    // The frontmatter exposes exactly the expected keys — the injected
    // `malicious_key` did NOT become a parsed frontmatter key.
    const { meta } = skills.parseFrontmatter(skills.loadSkill(r.skill, cfg));
    expect(meta.malicious_key).toBeUndefined();
    expect(meta.name).toBe('ok-malicious-key-pwned');
  });

  // Finding #1 (assembleSkillDoc layer) — even called directly with a raw name,
  // assembleSkillDoc must strip control chars from the rendered name so no
  // newline survives into the frontmatter.
  test('assembleSkillDoc strips control chars from the rendered name', async () => {
    const synth = await loadSynth();
    const skills = await loadSkills();
    const doc = synth.assembleSkillDoc({ name: 'ok\nmalicious_key: pwned', body: '## When to Use\nx\n' });
    const { meta } = skills.parseFrontmatter(doc);
    expect(meta.malicious_key).toBeUndefined();
    expect(meta.name).not.toContain('\n');
  });

  // Finding #3 — escapeYaml must neutralise embedded newlines so a multi-line
  // description value cannot inject a frontmatter key via assembleSkillDoc.
  test('escapeYaml strips embedded newlines so a multi-line description cannot inject a key', async () => {
    const synth = await loadSynth();
    const skills = await loadSkills();
    const desc = 'legit summary\ninjected_key: pwned';
    const doc = synth.assembleSkillDoc({ name: 'safe', description: desc, body: '## When to Use\nx\n' });
    const { meta } = skills.parseFrontmatter(doc);
    expect(meta.injected_key).toBeUndefined();
    expect(meta.description).not.toContain('\n');
  });
});

test.describe('Phase 20J — shared redact module', () => {
  test('mas/redact.mjs exports redactSecrets and skill_synth re-exports the same implementation', async () => {
    const redact = await loadRedact();
    const synth = await loadSynth();
    expect(typeof redact.redactSecrets).toBe('function');
    const sample = 'token sk-live1234567890abcdef end';
    // Both surfaces redact identically (skill_synth must delegate to the shared module).
    expect(redact.redactSecrets(sample)).toBe(synth.redactSecrets(sample));
    expect(redact.redactSecrets(sample)).not.toContain('sk-live1234567890abcdef');
    expect(redact.redactSecrets(sample)).toContain('[REDACTED]');
  });
});
