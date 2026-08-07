import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

// Drop a deterministic shim script we point LAZYCLAW_CLAUDE_BIN at.
// The shim:
//   - records the argv it was invoked with to <captureDir>/argv.json
//   - prints `replyText` as a stream-json sequence the adapter will
//     accumulate ('stream_event' → 'content_block_delta' → 'text_delta'),
//     followed by a final 'result' record.
function writeShim(replyText: string): { binPath: string, captureDir: string } {
  const dir = tmpDir('p19-shim');
  const captureDir = path.join(dir, 'capture');
  fs.mkdirSync(captureDir, { recursive: true });
  const bin = path.join(dir, 'claude-mock');
  // We embed the reply via a sentinel so the shim doesn't have to do
  // any escaping more elaborate than basic shell quoting.
  const body = [
    '#!/bin/sh',
    `printf "%s" "$*" > "${captureDir}/argv.txt"`,
    // Stream a single text_delta then a result envelope.
    `cat <<'JSON_DOC'`,
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: replyText },
      },
    }),
    JSON.stringify({
      type: 'result',
      result: replyText,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    }),
    'JSON_DOC',
  ].join('\n');
  fs.writeFileSync(bin, body);
  fs.chmodSync(bin, 0o755);
  return { binPath: bin, captureDir };
}

async function loadAdapter() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'providers', 'tool_use', 'claude_cli.mjs')).href;
  return await import(url) as typeof import('../providers/tool_use/claude_cli.mjs');
}

async function loadRunner() {
  const url = pathToFileURL(path.join(REPO_ROOT, 'mas', 'agent_turn.mjs')).href;
  return await import(url) as typeof import('../mas/agent_turn.mjs');
}

const claudeCliAgent = {
  name: 'planner',
  displayName: 'Planner',
  role: 'You are a careful planner.',
  provider: 'claude-cli',
  model: 'claude-opus-4-7',
  tools: ['bash', 'read', 'write', 'grep'],
};

test.describe('Phase 19 — claude-cli tool-use adapter', () => {
  test('toClaudeTools maps pompos names to claude built-in names and dedupes', async () => {
    const a = await loadAdapter();
    expect(a.toClaudeTools([{ name: 'bash' }, { name: 'read' }, { name: 'write' }, { name: 'grep' }]))
      .toBe('Bash,Read,Write,Grep');
    expect(a.toClaudeTools([{ name: 'bash' }, { name: 'bash' }])).toBe('Bash');
    expect(a.toClaudeTools([])).toBe('');
    // Unknown tool names are dropped silently — the CLI's `--tools`
    // arg won't accept them anyway and we don't want the adapter to
    // refuse the call just because we added a pompos-only tool.
    expect(a.toClaudeTools([{ name: 'bash' }, { name: 'frobnicate' }])).toBe('Bash');
  });

  test('callOnce accumulates stream_event text_delta records into the final reply', async () => {
    const shim = writeShim('claude says hi');
    const a = await loadAdapter();
    const r = await a.callOnce({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      system: 'be helpful',
      model: 'opus',
      bin: shim.binPath,
    });
    expect(r.kind).toBe('final');
    expect(r.text).toBe('claude says hi');

    // Argv inspection — confirms we passed system prompt, model, the
    // empty tool whitelist, and permission mode.
    const argv = fs.readFileSync(path.join(shim.captureDir, 'argv.txt'), 'utf8');
    expect(argv).toContain('-p');
    expect(argv).toContain('--output-format stream-json');
    expect(argv).toContain('--permission-mode bypassPermissions');
    expect(argv).toContain('--system-prompt be helpful');
    expect(argv).toContain('--model opus');
    // Empty tool list is passed as `--tools ` (an empty string arg)
    // which our `argv` capture renders with a trailing space.
    expect(argv).toMatch(/--tools(\s|$)/);
  });

  test('runAgentTurn with a claude-cli agent resolves in one iteration with stoppedBy=final', async () => {
    const shim = writeShim('I am done [[TASK_DONE]]');
    const { runAgentTurn } = await loadRunner();
    const r = await runAgentTurn({
      agent: claudeCliAgent,
      userMessage: 'ship it',
      // No apiKey — claude-cli authenticates itself
    }, /* signal */);
    // Phase 12 default budget is 10, but a final reply terminates after
    // a single iteration.
    // We override the binary via LAZYCLAW_CLAUDE_BIN at the process
    // level so the runner-internal adapter picks the shim up.
    expect(r.iterations).toBe(1);
    expect(r.stoppedBy).toBe('final');
    expect(r.text).toContain('[[TASK_DONE]]');
    // Cleanup: the shim_path is in tmp, not removed here — Playwright
    // doesn't share state with the suite.
    void shim;
  });

  test('claude-cli adapter advertises the agent tool whitelist as Claude built-in names', async () => {
    const shim = writeShim('ok');
    process.env.LAZYCLAW_CLAUDE_BIN = shim.binPath;
    try {
      const { runAgentTurn } = await loadRunner();
      const r = await runAgentTurn({
        agent: { ...claudeCliAgent, tools: ['bash', 'grep'] },
        userMessage: 'noop',
      });
      expect(r.stoppedBy).toBe('final');
      const argv = fs.readFileSync(path.join(shim.captureDir, 'argv.txt'), 'utf8');
      expect(argv).toMatch(/--tools(\s+|=)Bash,Grep/);
    } finally {
      delete process.env.LAZYCLAW_CLAUDE_BIN;
    }
  });
});

// The two runAgentTurn tests above share process.env state — Playwright
// runs spec files in their own workers, so cross-test bleed is bounded
// to this file. We set LAZYCLAW_CLAUDE_BIN inside each test before
// invoking the runner so the shim path is unambiguous.
test.beforeEach(async ({}, testInfo) => {
  if (testInfo.title.includes('runAgentTurn with a claude-cli agent')) {
    const shim = writeShim('I am done [[TASK_DONE]]');
    process.env.LAZYCLAW_CLAUDE_BIN = shim.binPath;
  }
});
test.afterEach(() => { delete process.env.LAZYCLAW_CLAUDE_BIN; });
