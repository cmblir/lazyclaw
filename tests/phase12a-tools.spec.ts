import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${prefix}-`));
}

async function load() {
  const runnerUrl = pathToFileURL(path.join(REPO_ROOT, 'mas', 'tool_runner.mjs')).href;
  const auditUrl = pathToFileURL(path.join(REPO_ROOT, 'mas', 'audit.mjs')).href;
  return {
    runner: await import(runnerUrl) as typeof import('../mas/tool_runner.mjs'),
    audit: await import(auditUrl) as typeof import('../mas/audit.mjs'),
  };
}

const fullAgent = { name: 'planner', tools: ['bash', 'read', 'write', 'grep'] };
const readOnlyAgent = { name: 'auditor', tools: ['read', 'grep'] };
// Sensitive tools (bash/write) are fail-closed in the runner: they need an
// approval hook. These tests exercise tool *behavior*, not the gate, so they
// approve unconditionally; the gate itself is covered by phase29 + p0-approval.
const approve = async () => ({ approved: true });

test.describe('Phase 12a — tool runner', () => {
  test('listToolSchemas returns one entry per implemented tool with JSON Schema parameters', async () => {
    const { runner } = await load();
    const schemas = runner.listToolSchemas() as Array<{ name: string; parameters: { type: string } }>;
    const names = schemas.map((s) => s.name).sort();
    expect(names).toEqual(['bash', 'grep', 'read', 'skill_view', 'write']);
    for (const s of schemas) {
      expect(s.parameters.type).toBe('object');
    }
  });

  test('bash tool runs a command and captures stdout/stderr/exit', async () => {
    const { runner } = await load();
    const r = await runner.runTool({
      agent: fullAgent,
      tool: 'bash',
      args: { command: 'echo hi && echo "error message" 1>&2 && exit 0' },
      approve,
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('hi');
    expect(r.stderr).toContain('error message');
    expect(r.exitCode).toBe(0);
  });

  test('bash tool surfaces a non-zero exit and timeout flag', async () => {
    const { runner } = await load();
    const r1 = await runner.runTool({
      agent: fullAgent,
      tool: 'bash',
      args: { command: 'exit 3' },
      approve,
    });
    expect(r1.exitCode).toBe(3);

    const r2 = await runner.runTool({
      agent: fullAgent,
      tool: 'bash',
      args: { command: 'sleep 10', timeoutMs: 250 },
      approve,
    });
    expect(r2.timedOut).toBe(true);
  });

  test('write then read round-trips through the workspace', async () => {
    const ws = tmpDir('p12a-rw');
    const { runner } = await load();

    const wr = await runner.runTool({
      agent: fullAgent,
      tool: 'write',
      args: { path: 'note.txt', content: 'hello world' },
      cwd: ws,
      approve,
    });
    expect(wr.ok).toBe(true);
    expect(wr.bytesWritten).toBe(11);

    const rd = await runner.runTool({
      agent: fullAgent,
      tool: 'read',
      args: { path: 'note.txt' },
      cwd: ws,
    });
    expect(rd.ok).toBe(true);
    expect(rd.content).toBe('hello world');
  });

  test('read of a missing file returns ok:false with a clear error', async () => {
    const ws = tmpDir('p12a-missing');
    const { runner } = await load();
    const r = await runner.runTool({
      agent: fullAgent,
      tool: 'read',
      args: { path: 'nope.txt' },
      cwd: ws,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ENOENT|read:/);
  });

  test('grep finds a substring across files in the workspace', async () => {
    const ws = tmpDir('p12a-grep');
    fs.writeFileSync(path.join(ws, 'a.js'), 'const greeting = "hello"');
    fs.writeFileSync(path.join(ws, 'b.md'), '# heading\nhello again\n');
    fs.writeFileSync(path.join(ws, 'noise.bin'), Buffer.from([0x00, 0x01]));

    const { runner } = await load();
    const r = await runner.runTool({
      agent: fullAgent,
      tool: 'grep',
      args: { pattern: 'hello' },
      cwd: ws,
    });
    expect(r.ok).toBe(true);
    const files = (r.matches as Array<{ path: string }>).map((m) => path.basename(m.path)).sort();
    expect(files).toContain('a.js');
    expect(files).toContain('b.md');
    expect(files).not.toContain('noise.bin');
  });

  test('runTool denies a tool that is not on the agent whitelist', async () => {
    const { runner } = await load();
    let err: Error & { code?: string } | null = null;
    try {
      await runner.runTool({
        agent: readOnlyAgent,
        tool: 'bash',
        args: { command: 'echo no' },
      });
    } catch (e) { err = e as Error & { code?: string }; }
    expect(err).toBeTruthy();
    expect(err!.code).toBe('TOOL_DENIED');
  });

  test('runTool throws TOOL_UNKNOWN for a non-registered tool name', async () => {
    const { runner } = await load();
    let err: Error & { code?: string } | null = null;
    try {
      await runner.runTool({
        agent: fullAgent,
        tool: 'fly',
        args: {},
      });
    } catch (e) { err = e as Error & { code?: string }; }
    expect(err!.code).toBe('TOOL_UNKNOWN');
  });

  test('runTool with a taskId writes an audit entry per call', async () => {
    const cfgDir = tmpDir('p12a-audit');
    const ws = tmpDir('p12a-audit-ws');
    const { runner, audit } = await load();
    const taskId = 't_20260518_audit1';

    await runner.runTool({ agent: fullAgent, tool: 'write', args: { path: 'x.txt', content: 'A' }, taskId, configDir: cfgDir, cwd: ws, approve });
    await runner.runTool({ agent: fullAgent, tool: 'read',  args: { path: 'x.txt' },                  taskId, configDir: cfgDir, cwd: ws });

    const entries = audit.read(taskId, cfgDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ tool: 'write', agent: 'planner', ok: true });
    expect(entries[1]).toMatchObject({ tool: 'read',  agent: 'planner', ok: true });
    // By default we only store hashes, not raw arg/result bodies.
    expect((entries[0] as { args?: unknown }).args).toBeUndefined();
    expect(entries[0].args_hash).toMatch(/^sha256:/);
  });

  test('POMPOS_AUDIT_RAW=1 inlines args + result in the audit entry', async () => {
    const cfgDir = tmpDir('p12a-audit-raw');
    const ws = tmpDir('p12a-audit-raw-ws');
    const prev = process.env.POMPOS_AUDIT_RAW;
    process.env.POMPOS_AUDIT_RAW = '1';
    try {
      const { runner, audit } = await load();
      const taskId = 't_20260518_audit2';
      await runner.runTool({ agent: fullAgent, tool: 'read', args: { path: 'nope' }, taskId, configDir: cfgDir, cwd: ws });
      const [entry] = audit.read(taskId, cfgDir);
      expect(entry.args).toEqual({ path: 'nope' });
      expect(entry.result).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.POMPOS_AUDIT_RAW;
      else process.env.POMPOS_AUDIT_RAW = prev;
    }
  });
});
