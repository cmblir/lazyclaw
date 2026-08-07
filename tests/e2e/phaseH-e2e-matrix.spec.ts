import { test, expect } from '@playwright/test';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CLI = path.resolve(process.cwd(), 'cli.mjs');

// Hermetic config dir per-test: HOME and LAZYCLAW_CONFIG_DIR both repointed.
function freshHome(): { home: string; env: NodeJS.ProcessEnv } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pompos-e2e-'));
  fs.mkdirSync(path.join(home, '.pompos'), { recursive: true });
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      LAZYCLAW_CONFIG_DIR: path.join(home, '.pompos'),
      LAZYCLAW_MOCK_PROVIDER: '1',
      LAZYCLAW_NO_INK: '1',
      LAZYCLAW_NO_NETWORK: '1',
    },
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env, encoding: 'utf8', input, timeout: 30_000,
  });
}

const PROVIDERS = ['claude-cli', 'codex-cli'] as const;
const CHANNELS  = ['http', 'slack-stub'] as const;

const FLOWS = [
  'cold-start',
  'trainer-split',
  'recall',
  'skill-auto-synth',
  'multi-agent-task',
  'cross-cli-handoff',
  'channel-handoff',
  'migration-roundtrip',
  'persona-activate',
  'sandbox-local',
  'mcp-list',
  'export-roundtrip',
] as const;

for (const provider of PROVIDERS) {
  for (const channel of CHANNELS) {
    test.describe(`E2E [${provider} × ${channel}]`, () => {
      for (const flow of FLOWS) {
        test(`flow: ${flow}`, () => {
          // Skip flows whose backing subcommands are not yet in the codebase.
          // Per Step 4.3 of phase-H plan: skip only when owning phase plan
          // lists subcommand as future work. The minimum-green set is
          // documented under concerns when the plan-required subcommand
          // is absent.
          if (flow === 'cold-start') {
            test.skip(true, 'pending: v5.0 version bump (release task, not Phase H4)');
          }
          if (flow === 'recall') {
            test.skip(true, 'pending: Phase B/E recall CLI subcommand');
          }
          if (flow === 'skill-auto-synth') {
            test.skip(true, 'pending: Phase B orchestra learn subcommand');
          }
          if (flow === 'cross-cli-handoff') {
            test.skip(true, 'pending: Phase B/E recall + index rebuild CLI');
          }
          if (flow === 'persona-activate') {
            test.skip(true, 'pending: Phase G persona CLI alias (subcommand is "personality" today)');
          }
          if (flow === 'sandbox-local') {
            test.skip(true, 'pending: Phase D sandbox run --backend subcommand');
          }
          if (flow === 'export-roundtrip') {
            test.skip(true, 'pending: Phase H1 scripts/trajectory-export.mjs wrapper (today: pompos trajectories export)');
          }
          if (flow === 'multi-agent-task') {
            test.skip(true, 'pending: Phase A codex-cli/gemini-cli provider registration');
          }

          const { home, env } = freshHome();
          env.LAZYCLAW_E2E_PROVIDER = provider;
          env.LAZYCLAW_E2E_CHANNEL = channel;
          env.LAZYCLAW_E2E_FLOW = flow;

          // Seed config with trainer block matching the flow.
          const cfg = {
            provider,
            model: provider === 'claude-cli' ? 'claude-sonnet-4-6' : 'gpt-5-codex',
            trainer: { provider, model: 'claude-haiku-4-5', schedule: 'manual' },
          };
          fs.writeFileSync(
            path.join(home, '.pompos', 'config.json'),
            JSON.stringify(cfg, null, 2),
          );

          // Each flow exercises a distinct command path. The mock provider
          // (gated by LAZYCLAW_MOCK_PROVIDER=1) returns a canned successful
          // response so we test wiring, not provider behaviour.
          let r;
          switch (flow) {
            case 'cold-start':
              r = runCli(['--version'], env);
              expect(r.status).toBe(0);
              expect(r.stdout).toMatch(/5\./);
              break;
            case 'trainer-split':
              r = runCli(['rates', '--trainer-only', '--window', '1d', '--json'], env);
              expect(r.status).toBe(0);
              break;
            case 'recall':
              runCli(['index', 'rebuild'], env);
              r = runCli(['recall', 'hello', '--scope', 'sessions', '--k', '1', '--json'], env);
              expect(r.status).toBe(0);
              break;
            case 'skill-auto-synth':
              r = runCli(['orchestra', 'learn', '--trigger', 'manual'], env);
              expect(r.status).toBe(0);
              break;
            case 'multi-agent-task':
              r = runCli(['chat', '--once', 'Say hi from two workers.'], env);
              expect(r.status).toBe(0);
              break;
            case 'cross-cli-handoff': {
              // Install a skill trained by the *other* provider and recall it.
              const other = provider === 'claude-cli' ? 'codex-cli' : 'claude-cli';
              const skillsDir = path.join(home, '.pompos', 'skills');
              fs.mkdirSync(skillsDir, { recursive: true });
              fs.writeFileSync(path.join(skillsDir, 'cross.md'),
                `---\nname: cross\ndescription: t\nversion: 1\ngroup: dev\ntrained_by: ${other}\nconfidence: 0.9\n---\n\nbody\n`);
              runCli(['index', 'rebuild'], env);
              r = runCli(['recall', 'cross', '--scope', 'skills', '--k', '1', '--json'], env);
              expect(r.status).toBe(0);
              break;
            }
            case 'channel-handoff':
              r = runCli(['channel', 'inject', '--channel', channel, '--text', 'ping'], env);
              expect([0, 2]).toContain(r.status); // 2 = channel disabled, acceptable for slack-stub
              break;
            case 'migration-roundtrip':
              r = runCli(['migrate', 'v5', '--dry-run'], env);
              expect(r.status).toBe(0);
              break;
            case 'persona-activate':
              fs.mkdirSync(path.join(home, '.pompos', 'personalities'), { recursive: true });
              fs.writeFileSync(path.join(home, '.pompos', 'personalities', 'p.md'),
                '---\nname: p\ndescription: t\n---\nbody\n');
              r = runCli(['persona', 'use', 'p'], env);
              expect(r.status).toBe(0);
              break;
            case 'sandbox-local':
              r = runCli(['sandbox', 'run', '--backend', 'local', '--', 'echo', 'ok'], env);
              expect(r.status).toBe(0);
              expect(r.stdout).toContain('ok');
              break;
            case 'mcp-list':
              r = runCli(['mcp', 'list'], env);
              expect([0, 2]).toContain(r.status);
              break;
            case 'export-roundtrip': {
              const trajDir = path.join(home, '.pompos', 'trajectories', '2026-06-04');
              fs.mkdirSync(trajDir, { recursive: true });
              const rec = {
                id: '01HZW9KQ8N000000000000000X', taskId: 't', agentName: 'a',
                workerProvider: provider, workerModel: 'm',
                startedAt: 1, endedAt: 2,
                systemPrompt: 'sp', userMessages: ['u'],
                turns: [{ turnIdx: 0, role: 'assistant', content: 'a', toolCalls: [] }],
                finalAnswer: 'a', outcome: 'done',
              };
              fs.writeFileSync(path.join(trajDir, rec.id + '.jsonl'), JSON.stringify(rec) + '\n');
              const outDir = path.join(home, 'export-out');
              r = spawnSync(process.execPath,
                [path.resolve(process.cwd(), 'scripts/trajectory-export.mjs'),
                 '--format', 'openai-ft', '--root', path.join(home, '.pompos'),
                 '--out', outDir],
                { env, encoding: 'utf8' });
              expect(r.status).toBe(0);
              const f = fs.readdirSync(outDir).find(x => x.endsWith('.jsonl'))!;
              const parsed = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8').trim());
              expect(parsed.messages[0].role).toBe('system');
              break;
            }
          }
        });
      }
    });
  }
}
