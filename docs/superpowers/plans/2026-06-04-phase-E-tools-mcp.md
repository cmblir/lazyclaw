# lazyclaw v5.0 — Phase E: tools-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the 45+ first-party tool catalogue (grouped by category) plus a working MCP client that spawns external MCP servers, registers their tools with a prefix, and routes them through the existing sensitive-tool approve hook.

**Architecture:** Each tool category lives in `mas/tools/<group>.mjs` and exports an array of `{name, category, sensitive, description, parameters, exec}` records. A new `mas/tools/registry.mjs` aggregates groups; `mas/tool_runner.mjs` is upgraded to consult the registry instead of a hard-coded map. `mas/toolsets.mjs` resolves a named toolset (e.g. `coding-min`) into a tool allowlist used by `agent edit --toolset`. MCP client (`mcp/client.mjs`) uses `@modelcontextprotocol/sdk` stdio transport, lists each server's tools, prefixes them (`mcp:<server>:<tool>`), and inserts them as `sensitive: true` entries in the registry.

**Tech Stack:** Node.js 18+, .mjs ES modules. Libs: `@modelcontextprotocol/sdk` (MCP stdio), `undici` (web_fetch), `playwright` (browser tools — already in devDeps), `node:child_process` (sub-CLI delegation, git). All tests use Node's built-in `node --test` runner.

**Depends on phases:** A (foundations — config schema, audit, sandbox), B (FTS5 recall — for `mas/tools/recall.mjs`), C (orchestra dispatch — for delegation tools), D (skills loop + USER.md — for learning tools).

**Spec reference:** `docs/superpowers/specs/2026-06-04-lazyclaw-v5-hermes-parity-design.md` §1.5 (G10), §3.7 (orchestra tools), §4.5 (recall surface #3), §5.4 (tool category metadata), §7 (entire section), §0.2 (HA / TTS deferred to v5.1).

---

## File Structure

### New files

- `/Users/o/lazyclaw/mas/tools/edit.mjs` — `edit` tool (find/replace within file)
- `/Users/o/lazyclaw/mas/tools/patch.mjs` — `patch` tool (apply unified-diff hunks)
- `/Users/o/lazyclaw/mas/tools/recall.mjs` — `recall` tool (calls Phase B `recall()`)
- `/Users/o/lazyclaw/mas/tools/learning.mjs` — `skill_view`, `skill_create`, `skill_edit`, `memory_write`, `memory_read`, `user_view`, `user_update`
- `/Users/o/lazyclaw/mas/tools/web.mjs` — `web_fetch`, `web_search`, `url_extract`
- `/Users/o/lazyclaw/mas/tools/os.mjs` — `clipboard_read`, `clipboard_write`, `screenshot`, `notify`, `open_url`, `file_dialog`
- `/Users/o/lazyclaw/mas/tools/coding.mjs` — `python_exec`, `node_exec`, `sql_query`, `http_request`, `regex_match`
- `/Users/o/lazyclaw/mas/tools/git.mjs` — `git_status`, `git_diff`, `git_log`, `git_blame`, `git_branch`, `git_commit`, `git_push`
- `/Users/o/lazyclaw/mas/tools/scheduling.mjs` — `cron_add`, `cron_remove`, `cron_list`
- `/Users/o/lazyclaw/mas/tools/delegation.mjs` — `task_spawn`, `delegate`
- `/Users/o/lazyclaw/mas/tools/media.mjs` — `image_describe`, `image_generate`, `tts_speak` (stub), `transcribe`
- `/Users/o/lazyclaw/mas/tools/ha.mjs` — `ha_call_service`, `ha_get_state` (STUB — v5.1 per §0.2)
- `/Users/o/lazyclaw/mas/tools/clarify.mjs` — `clarify`
- `/Users/o/lazyclaw/mas/tools/browser.mjs` — `browser_navigate`, `browser_click`, `browser_back`, `browser_screenshot`
- `/Users/o/lazyclaw/mas/tools/registry.mjs` — central tool aggregator
- `/Users/o/lazyclaw/mas/toolsets.mjs` — toolset add/list/remove + resolve-allowlist
- `/Users/o/lazyclaw/mcp/client.mjs` — MCP stdio client + tool registration
- `/Users/o/lazyclaw/mcp/server_spawn.mjs` — config-driven MCP server spawner
- 15 test files under `/Users/o/lazyclaw/tests/phaseE-*.test.mjs` (see Tasks)

### Modified files

- `/Users/o/lazyclaw/mas/tool_runner.mjs` — replace hard-coded `TOOLS` map with `registry.lookup(name)`; expand `SENSITIVE_TOOLS` to read each tool's `sensitive` field.
- `/Users/o/lazyclaw/package.json` — add `@modelcontextprotocol/sdk` and `undici` runtime deps.

---

## Task 1 — Registry skeleton + tool_runner integration

Estimated: 35 min. Establishes the shape every subsequent task plugs into.

- [ ] **1.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-registry.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as registry from '../mas/tools/registry.mjs';

  test('registry exposes built-in groups', () => {
    const all = registry.listAll();
    assert.ok(Array.isArray(all));
    const names = all.map(t => t.name);
    assert.ok(names.includes('bash'));
    assert.ok(names.includes('read'));
    assert.ok(names.includes('write'));
    assert.ok(names.includes('grep'));
    assert.ok(names.includes('skill_view'));
  });

  test('registry.lookup returns shape {name,category,sensitive,description,parameters,exec}', () => {
    const t = registry.lookup('bash');
    assert.equal(t.name, 'bash');
    assert.equal(typeof t.exec, 'function');
    assert.equal(typeof t.description, 'string');
    assert.equal(typeof t.parameters, 'object');
    assert.equal(typeof t.sensitive, 'boolean');
    assert.equal(typeof t.category, 'string');
  });

  test('registry.lookup unknown -> null', () => {
    assert.equal(registry.lookup('nope_xyz'), null);
  });

  test('registry.byCategory groups tools', () => {
    const cats = registry.byCategory();
    assert.ok(cats.exec || cats.fs);
  });
  ```

- [ ] **1.2 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-registry.test.mjs`
  - Expected: `Cannot find module '../mas/tools/registry.mjs'`

- [ ] **1.3 Create registry**

  Create `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  // Tool registry — aggregates every first-party tool group plus any MCP-imported
  // tools so callers (tool_runner, splash renderer, agent toolset resolver) can
  // ask for them by name without knowing which file they live in.
  //
  // Each tool record: {name, category, sensitive, description, parameters, exec}
  //   - name: unique key (mcp tools use "mcp:<server>:<tool>")
  //   - category: 'exec' | 'fs' | 'net' | 'data' | 'agents' | 'learning' | ...
  //   - sensitive: when true, tool_runner requires `approve` hook before exec
  //   - parameters: JSON-Schema object (same shape as Phase 12a)
  //   - exec(args, ctx) -> {ok, ...}

  import * as bashTool from './bash.mjs';
  import * as readTool from './read.mjs';
  import * as writeTool from './write.mjs';
  import * as grepTool from './grep.mjs';
  import * as skillViewTool from './skill_view.mjs';

  function adaptLegacy(mod, { category, sensitive }) {
    return {
      name: mod.NAME,
      category,
      sensitive,
      description: mod.DESCRIPTION,
      parameters: mod.PARAMETERS,
      exec: mod.exec,
    };
  }

  // Built-in (Phase 12a) tools, adapted to v5 shape.
  const BUILTINS = [
    adaptLegacy(bashTool,      { category: 'exec', sensitive: true  }),
    adaptLegacy(readTool,      { category: 'fs',   sensitive: false }),
    adaptLegacy(writeTool,     { category: 'fs',   sensitive: true  }),
    adaptLegacy(grepTool,      { category: 'fs',   sensitive: false }),
    adaptLegacy(skillViewTool, { category: 'learning', sensitive: false }),
  ];

  // Mutable; new groups (Tasks 2-14) push here; MCP client (Task 15) also pushes.
  const TOOLS = new Map();
  for (const t of BUILTINS) TOOLS.set(t.name, t);

  export function register(tool) {
    if (!tool || typeof tool.name !== 'string') throw new Error('registry.register: tool.name required');
    if (typeof tool.exec !== 'function')        throw new Error(`registry.register(${tool.name}): exec required`);
    if (typeof tool.sensitive !== 'boolean')    throw new Error(`registry.register(${tool.name}): sensitive required`);
    TOOLS.set(tool.name, tool);
  }

  export function registerGroup(group) {
    if (!Array.isArray(group)) throw new Error('registry.registerGroup: array required');
    for (const t of group) register(t);
  }

  export function unregister(name) { return TOOLS.delete(name); }

  export function lookup(name) { return TOOLS.get(name) || null; }

  export function listAll() { return [...TOOLS.values()]; }

  export function listNames() { return [...TOOLS.keys()]; }

  export function byCategory() {
    const out = {};
    for (const t of TOOLS.values()) (out[t.category] ||= []).push(t);
    return out;
  }
  ```

- [ ] **1.4 Run test — verify PASS**
  - Run: `node --test tests/phaseE-registry.test.mjs`
  - Expected: `# pass 4`

- [ ] **1.5 Upgrade tool_runner**

  Edit `/Users/o/lazyclaw/mas/tool_runner.mjs`. Replace the hard-coded `TOOLS` map and `SENSITIVE_TOOLS` set with registry lookups:

  ```js
  // Tool runner — given an agent record and a tool invocation, validates
  // the agent is allowed to use the tool, runs the tool, audits the call,
  // and returns a uniform { ok, result?, error? } shape that the provider
  // adapters serialise into their respective tool-result content blocks.

  import * as registry from './tools/registry.mjs';
  import * as audit from './audit.mjs';

  export class ToolError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ToolError';
      this.code = code || 'TOOL_ERR';
    }
  }

  export function listToolSchemas(names) {
    const out = [];
    const wanted = Array.isArray(names) && names.length ? names : registry.listNames();
    for (const name of wanted) {
      const t = registry.lookup(name);
      if (!t) continue;
      out.push({ name: t.name, description: t.description, parameters: t.parameters });
    }
    return out;
  }

  export function isImplemented(name) { return registry.lookup(name) !== null; }
  export function knownTool(name)     { return registry.lookup(name) !== null; }

  export async function runTool({ agent, tool, args, taskId, configDir, cwd, approve } = {}) {
    if (!agent || !Array.isArray(agent.tools)) {
      throw new ToolError('agent record with .tools[] is required', 'TOOL_BAD_AGENT');
    }
    const impl = registry.lookup(tool);
    if (!impl) throw new ToolError(`unknown tool "${tool}"`, 'TOOL_UNKNOWN');
    if (!agent.tools.includes(tool)) {
      throw new ToolError(`agent "${agent.name}" is not allowed to call tool "${tool}" (whitelist=[${agent.tools.join(', ')}])`, 'TOOL_DENIED');
    }
    if (typeof approve === 'function' && impl.sensitive) {
      let verdict;
      try { verdict = await approve({ tool, args, agent: agent.name }); }
      catch (err) { verdict = { approved: false, reason: `approval error: ${err?.message || err}` }; }
      if (!verdict || !verdict.approved) {
        const result = { ok: false, error: `tool "${tool}" denied by operator${verdict?.reason ? `: ${verdict.reason}` : ''}`, code: 'TOOL_DENIED_APPROVAL' };
        audit.append({ taskId, agent: agent.name, tool, args, result, ok: false, configDir });
        return result;
      }
    }
    let result;
    try {
      result = await impl.exec(args || {}, { cwd: cwd || process.cwd(), configDir, taskId, agent });
    } catch (err) {
      result = { ok: false, error: `${tool} threw: ${err?.message || err}` };
    }
    audit.append({ taskId, agent: agent.name, tool, args, result, ok: !!result?.ok, configDir });
    return result;
  }
  ```

- [ ] **1.6 Re-run existing Phase 12 tool tests to confirm zero regression**
  - Run: `node --test tests/phaseE-registry.test.mjs`
  - Expected: `# pass 4`. Existing playwright tool tests will be exercised at the very end of the phase.

- [ ] **1.7 Commit**
  - Run: `git add mas/tools/registry.mjs mas/tool_runner.mjs tests/phaseE-registry.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): introduce registry + sensitive-driven tool_runner

    Replaces the hard-coded TOOLS map and SENSITIVE_TOOLS set with a single
    mas/tools/registry.mjs aggregator so subsequent v5 tool groups (web, os,
    coding, git, ...) and MCP-imported tools can plug in without touching the
    runner. tool_runner now reads `sensitive` from the tool record itself,
    matching spec §7 (Tool Ecosystem & MCP Integration).
    EOF
    )"
    ```

---

## Task 2 — edit + patch tools (bash group upgrade)

Estimated: 50 min. Spec §7 sub-bullet 1: "mas/tools/bash.mjs upgrade (existing): + edit, patch tools."

- [ ] **2.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-edit-patch.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import * as edit from '../mas/tools/edit.mjs';
  import * as patch from '../mas/tools/patch.mjs';

  function tmpDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-edit-'));
    return d;
  }

  test('edit replaces exact occurrence', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'a.txt');
    fs.writeFileSync(f, 'hello world\nfoo bar\n');
    const out = await edit.TOOL.exec({ path: 'a.txt', old: 'world', new: 'mars' }, { cwd: dir });
    assert.equal(out.ok, true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'hello mars\nfoo bar\n');
  });

  test('edit refuses when old not unique', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'b.txt');
    fs.writeFileSync(f, 'x\nx\n');
    const out = await edit.TOOL.exec({ path: 'b.txt', old: 'x', new: 'y' }, { cwd: dir });
    assert.equal(out.ok, false);
    assert.match(out.error, /not unique/);
  });

  test('edit refuses when old not found', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'c.txt'), 'abc');
    const out = await edit.TOOL.exec({ path: 'c.txt', old: 'zzz', new: 'q' }, { cwd: dir });
    assert.equal(out.ok, false);
    assert.match(out.error, /not found/);
  });

  test('patch applies a unified-diff hunk', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'd.txt');
    fs.writeFileSync(f, 'one\ntwo\nthree\n');
    const diff = [
      '--- a/d.txt',
      '+++ b/d.txt',
      '@@ -1,3 +1,3 @@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '',
    ].join('\n');
    const out = await patch.TOOL.exec({ diff }, { cwd: dir });
    assert.equal(out.ok, true, out.error);
    assert.equal(fs.readFileSync(f, 'utf8'), 'one\nTWO\nthree\n');
  });

  test('patch rejects mismatched context', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'e.txt'), 'aa\nbb\n');
    const diff = '--- a/e.txt\n+++ b/e.txt\n@@ -1,2 +1,2 @@\n-XX\n+YY\n bb\n';
    const out = await patch.TOOL.exec({ diff }, { cwd: dir });
    assert.equal(out.ok, false);
  });

  test('TOOL records expose v5 shape', () => {
    for (const T of [edit.TOOL, patch.TOOL]) {
      assert.equal(typeof T.name, 'string');
      assert.equal(typeof T.exec, 'function');
      assert.equal(T.category, 'fs');
      assert.equal(T.sensitive, true);
    }
  });
  ```

- [ ] **2.2 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-tools-edit-patch.test.mjs`
  - Expected: `Cannot find module '../mas/tools/edit.mjs'`

- [ ] **2.3 Implement edit**

  Create `/Users/o/lazyclaw/mas/tools/edit.mjs`:

  ```js
  // edit — find/replace exactly one occurrence of `old` with `new` inside a file
  // rooted at the agent cwd. Refuses when `old` is missing or not unique so the
  // LLM cannot silently overwrite the wrong span (spec §7 sub-bullet 1).

  import fs from 'node:fs';
  import path from 'node:path';

  export const TOOL = {
    name: 'edit',
    category: 'fs',
    sensitive: true,
    description: 'Replace exactly one occurrence of `old` with `new` inside a workspace file. Fails if `old` is missing or appears more than once.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to cwd.' },
        old:  { type: 'string', description: 'Exact substring to replace.' },
        new:  { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'old', 'new'],
    },
    async exec(args, { cwd = process.cwd() } = {}) {
      if (!args || typeof args.path !== 'string') return { ok: false, error: 'edit: path required' };
      if (typeof args.old !== 'string' || typeof args.new !== 'string') return { ok: false, error: 'edit: old/new strings required' };
      const abs = path.resolve(cwd, args.path);
      if (!abs.startsWith(path.resolve(cwd))) return { ok: false, error: 'edit: path escapes workspace' };
      let src;
      try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return { ok: false, error: `edit: ${e.message}` }; }
      const idx = src.indexOf(args.old);
      if (idx === -1) return { ok: false, error: `edit: \`old\` not found in ${args.path}` };
      if (src.indexOf(args.old, idx + 1) !== -1) return { ok: false, error: `edit: \`old\` not unique in ${args.path}` };
      const next = src.slice(0, idx) + args.new + src.slice(idx + args.old.length);
      fs.writeFileSync(abs, next);
      return { ok: true, path: args.path, bytesWritten: Buffer.byteLength(next) };
    },
  };
  ```

- [ ] **2.4 Implement patch**

  Create `/Users/o/lazyclaw/mas/tools/patch.mjs`:

  ```js
  // patch — apply a unified-diff to one or more files. Uses a strict parser:
  // a hunk must match context lines exactly or the entire patch is rejected
  // so partial application can't corrupt the workspace.

  import fs from 'node:fs';
  import path from 'node:path';

  export const TOOL = {
    name: 'patch',
    category: 'fs',
    sensitive: true,
    description: 'Apply a unified-diff patch (multi-file allowed). Fails atomically on any context mismatch.',
    parameters: {
      type: 'object',
      properties: { diff: { type: 'string', description: 'Unified diff body.' } },
      required: ['diff'],
    },
    async exec(args, { cwd = process.cwd() } = {}) {
      if (!args || typeof args.diff !== 'string' || !args.diff.trim()) return { ok: false, error: 'patch: diff required' };
      const files = parseUnifiedDiff(args.diff);
      if (!files.length) return { ok: false, error: 'patch: no file hunks parsed' };
      const stage = []; // {abs, content}
      for (const file of files) {
        const abs = path.resolve(cwd, file.path);
        if (!abs.startsWith(path.resolve(cwd))) return { ok: false, error: `patch: path escapes workspace: ${file.path}` };
        let src;
        try { src = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''; }
        catch (e) { return { ok: false, error: `patch: read ${file.path}: ${e.message}` }; }
        const applied = applyHunks(src, file.hunks);
        if (!applied.ok) return { ok: false, error: `patch: ${file.path}: ${applied.error}` };
        stage.push({ abs, content: applied.content });
      }
      for (const s of stage) fs.writeFileSync(s.abs, s.content);
      return { ok: true, filesWritten: stage.length };
    },
  };

  function parseUnifiedDiff(diff) {
    const lines = diff.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
        const newPath = lines[i + 1].slice(4).replace(/^b\//, '').trim();
        i += 2;
        const hunks = [];
        while (i < lines.length && lines[i].startsWith('@@')) {
          const header = lines[i++];
          const body = [];
          while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ')) {
            body.push(lines[i++]);
          }
          hunks.push({ header, body });
        }
        out.push({ path: newPath, hunks });
      } else {
        i++;
      }
    }
    return out;
  }

  function applyHunks(src, hunks) {
    let lines = src.split('\n');
    let cursor = 0;
    for (const hunk of hunks) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
      if (!m) return { ok: false, error: `bad hunk header: ${hunk.header}` };
      let lineIdx = Math.max(0, parseInt(m[1], 10) - 1);
      const out = lines.slice(0, lineIdx);
      for (const b of hunk.body) {
        if (b === '') continue;
        const op = b[0];
        const text = b.slice(1);
        if (op === ' ') {
          if ((lines[lineIdx] ?? '') !== text) return { ok: false, error: `context mismatch at line ${lineIdx + 1}` };
          out.push(text); lineIdx++;
        } else if (op === '-') {
          if ((lines[lineIdx] ?? '') !== text) return { ok: false, error: `delete mismatch at line ${lineIdx + 1}` };
          lineIdx++;
        } else if (op === '+') {
          out.push(text);
        } else if (op === '\\') {
          // \ No newline at end of file — ignore
        }
      }
      lines = out.concat(lines.slice(lineIdx));
      cursor = lineIdx;
    }
    return { ok: true, content: lines.join('\n') };
  }
  ```

- [ ] **2.5 Run test — verify PASS**
  - Run: `node --test tests/phaseE-tools-edit-patch.test.mjs`
  - Expected: `# pass 6`

- [ ] **2.6 Register edit + patch**

  Append to `/Users/o/lazyclaw/mas/tools/registry.mjs`, near the BUILTINS block:

  ```js
  import { TOOL as editTool }  from './edit.mjs';
  import { TOOL as patchTool } from './patch.mjs';

  BUILTINS.push(editTool, patchTool);
  TOOLS.set(editTool.name, editTool);
  TOOLS.set(patchTool.name, patchTool);
  ```

- [ ] **2.7 Commit**
  - Run: `git add mas/tools/edit.mjs mas/tools/patch.mjs mas/tools/registry.mjs tests/phaseE-tools-edit-patch.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): add edit + patch (sensitive, fs category)

    edit performs a uniqueness-checked find/replace; patch applies a
    strict unified-diff with atomic stage-then-commit semantics so a
    context mismatch in any hunk aborts the whole apply. Both join the
    registry as sensitive fs tools per spec §7.
    EOF
    )"
    ```

---

## Task 3 — recall tool (Phase B reuse)

Estimated: 30 min. Spec §4.5 lists `recall` as the third surface (agent-callable tool).

- [ ] **3.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-recall.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as recall from '../mas/tools/recall.mjs';

  test('recall tool exposes v5 shape', () => {
    assert.equal(recall.TOOL.name, 'recall');
    assert.equal(recall.TOOL.category, 'learning');
    assert.equal(recall.TOOL.sensitive, false);
    assert.equal(typeof recall.TOOL.exec, 'function');
  });

  test('recall rejects empty query', async () => {
    const r = await recall.TOOL.exec({ query: '' });
    assert.equal(r.ok, false);
  });

  test('recall delegates to inject recallFn', async () => {
    let captured;
    const fakeRecall = async (q, opts) => { captured = { q, opts }; return { query: q, hits: [], latencyMs: 1 }; };
    recall.__setRecall(fakeRecall);
    const r = await recall.TOOL.exec({ query: 'hello', scope: ['skills'], k: 4 });
    assert.equal(r.ok, true);
    assert.equal(captured.q, 'hello');
    assert.deepEqual(captured.opts.scope, ['skills']);
    assert.equal(captured.opts.k, 4);
    recall.__setRecall(null);
  });
  ```

- [ ] **3.2 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-tools-recall.test.mjs`
  - Expected: `Cannot find module '../mas/tools/recall.mjs'`

- [ ] **3.3 Implement recall**

  Create `/Users/o/lazyclaw/mas/tools/recall.mjs`:

  ```js
  // recall — agent-callable wrapper around the Phase B recall() function.
  // The actual FTS5 backed recall lives in mas/recall.mjs (Phase B); we
  // dynamically import to avoid forcing better-sqlite3 to load when an agent
  // never calls recall. __setRecall lets tests inject a stub.

  let _recall = null;

  export function __setRecall(fn) { _recall = fn; }

  async function getRecall() {
    if (_recall) return _recall;
    const mod = await import('../recall.mjs').catch(() => null);
    if (!mod || typeof mod.recall !== 'function') {
      throw new Error('recall: Phase B (mas/recall.mjs) not available');
    }
    _recall = mod.recall;
    return _recall;
  }

  export const TOOL = {
    name: 'recall',
    category: 'learning',
    sensitive: false,
    description: 'Search past sessions, skills, trajectories, and memories. Returns ranked snippets.',
    parameters: {
      type: 'object',
      properties: {
        query:     { type: 'string', description: 'Free-text query.' },
        scope:     { type: 'array', items: { type: 'string', enum: ['sessions', 'skills', 'trajectories', 'memories'] } },
        k:         { type: 'number', description: 'Max hits (default 10, max 50).' },
        summarize: { type: 'boolean', description: 'Ask trainer to summarise hits.' },
      },
      required: ['query'],
    },
    async exec(args) {
      if (!args || typeof args.query !== 'string' || !args.query.trim()) return { ok: false, error: 'recall: query required' };
      try {
        const fn = await getRecall();
        const out = await fn(args.query, {
          scope: args.scope,
          k: args.k,
          summarize: args.summarize,
        });
        return { ok: true, ...out };
      } catch (e) {
        return { ok: false, error: `recall: ${e.message}` };
      }
    },
  };
  ```

- [ ] **3.4 Run test — verify PASS**
  - Run: `node --test tests/phaseE-tools-recall.test.mjs`
  - Expected: `# pass 3`

- [ ] **3.5 Register**

  Add to `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  import { TOOL as recallTool } from './recall.mjs';
  BUILTINS.push(recallTool);
  TOOLS.set(recallTool.name, recallTool);
  ```

- [ ] **3.6 Commit**
  - Run: `git add mas/tools/recall.mjs mas/tools/registry.mjs tests/phaseE-tools-recall.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): recall tool over Phase B FTS5 substrate

    Adds the agent-callable recall surface listed in spec §4.5 #3.
    Lazy-imports mas/recall.mjs so better-sqlite3 is loaded only when an
    agent first calls the tool.
    EOF
    )"
    ```

---

## Task 4 — learning group (skill_*, memory_*, user_*)

Estimated: 70 min. Spec §7 sub-bullet 3.

- [ ] **4.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-learning.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import * as learning from '../mas/tools/learning.mjs';

  function tmpHome() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-learn-'));
    fs.mkdirSync(path.join(d, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
    return d;
  }

  test('exports 7 learning tools', () => {
    const names = learning.TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, ['memory_read','memory_write','skill_create','skill_edit','skill_view','user_update','user_view']);
  });

  test('skill_create writes a SKILL.md', async () => {
    const home = tmpHome();
    const sc = learning.TOOLS.find(t => t.name === 'skill_create');
    const r = await sc.exec({ name: 'demo-skill', body: 'Do the thing.' }, { configDir: home });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(path.join(home, 'skills', 'demo-skill', 'SKILL.md')));
  });

  test('memory_write appends recent.jsonl line', async () => {
    const home = tmpHome();
    const mw = learning.TOOLS.find(t => t.name === 'memory_write');
    const r = await mw.exec({ kind: 'recent', content: 'note one' }, { configDir: home });
    assert.equal(r.ok, true);
    const out = fs.readFileSync(path.join(home, 'memory', 'recent.jsonl'), 'utf8').trim();
    assert.match(out, /note one/);
  });

  test('user_view returns USER.md content (or empty)', async () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'memory', 'USER.md'), '# user notes');
    const uv = learning.TOOLS.find(t => t.name === 'user_view');
    const r = await uv.exec({}, { configDir: home });
    assert.equal(r.ok, true);
    assert.match(r.content, /user notes/);
  });

  test('user_update overwrites USER.md', async () => {
    const home = tmpHome();
    const uu = learning.TOOLS.find(t => t.name === 'user_update');
    const r = await uu.exec({ content: '# new' }, { configDir: home });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(path.join(home, 'memory', 'USER.md'), 'utf8'), '# new');
  });

  test('sensitivity matrix', () => {
    const want = {
      skill_view: false, skill_create: true, skill_edit: true,
      memory_write: true, memory_read: false,
      user_view: false, user_update: true,
    };
    for (const t of learning.TOOLS) assert.equal(t.sensitive, want[t.name], `${t.name}.sensitive`);
  });
  ```

- [ ] **4.2 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-tools-learning.test.mjs`
  - Expected: `Cannot find module '../mas/tools/learning.mjs'`

- [ ] **4.3 Implement learning tools**

  Create `/Users/o/lazyclaw/mas/tools/learning.mjs`:

  ```js
  // learning — agent tools that read/write the skill bank, layered memory,
  // and the persistent USER.md (Honcho-equivalent, spec §1.6, §4.10).
  // USER.md path canonical (C6) = <configDir>/memory/USER.md.

  import fs from 'node:fs';
  import path from 'node:path';

  function resolveConfigDir(ctx) {
    return ctx?.configDir || process.env.LAZYCLAW_CONFIG_DIR || path.join(process.env.HOME || '.', '.lazyclaw');
  }

  function skillsDir(ctx) { return path.join(resolveConfigDir(ctx), 'skills'); }
  function memoryDir(ctx) { return path.join(resolveConfigDir(ctx), 'memory'); }
  function userMdPath(ctx) { return path.join(memoryDir(ctx), 'USER.md'); }

  const skill_view = {
    name: 'skill_view', category: 'learning', sensitive: false,
    description: 'Return the body of an installed skill (by name).',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async exec(args, ctx) {
      if (!args?.name) return { ok: false, error: 'skill_view: name required' };
      const file = path.join(skillsDir(ctx), args.name, 'SKILL.md');
      if (!fs.existsSync(file)) return { ok: false, error: `skill_view: ${args.name} not installed` };
      return { ok: true, name: args.name, content: fs.readFileSync(file, 'utf8') };
    },
  };

  const skill_create = {
    name: 'skill_create', category: 'learning', sensitive: true,
    description: 'Create a new skill at <configDir>/skills/<name>/SKILL.md. Fails if already exists.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, body: { type: 'string' },
        description: { type: 'string' }, group: { type: 'string' },
      },
      required: ['name', 'body'],
    },
    async exec(args, ctx) {
      if (!args?.name || !args?.body) return { ok: false, error: 'skill_create: name + body required' };
      if (!/^[a-z0-9][a-z0-9-]*$/.test(args.name)) return { ok: false, error: 'skill_create: kebab-case name only' };
      const dir = path.join(skillsDir(ctx), args.name);
      const file = path.join(dir, 'SKILL.md');
      if (fs.existsSync(file)) return { ok: false, error: `skill_create: ${args.name} already exists; use skill_edit` };
      fs.mkdirSync(dir, { recursive: true });
      const fm = [
        '---',
        `name: ${args.name}`,
        `description: ${args.description || args.body.split('\n')[0].slice(0, 200)}`,
        `group: ${args.group || (args.name.includes('-') ? args.name.split('-')[0] : 'legacy')}`,
        'version: 1',
        'trained_by: user',
        `created_at: ${new Date().toISOString().slice(0, 10)}`,
        '---',
        '',
      ].join('\n');
      fs.writeFileSync(file, fm + args.body + (args.body.endsWith('\n') ? '' : '\n'));
      return { ok: true, name: args.name, file };
    },
  };

  const skill_edit = {
    name: 'skill_edit', category: 'learning', sensitive: true,
    description: 'Replace the body of an existing skill. Preserves frontmatter, bumps version.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, body: { type: 'string' } },
      required: ['name', 'body'],
    },
    async exec(args, ctx) {
      const file = path.join(skillsDir(ctx), args.name, 'SKILL.md');
      if (!fs.existsSync(file)) return { ok: false, error: `skill_edit: ${args.name} not installed` };
      const src = fs.readFileSync(file, 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src);
      if (!m) return { ok: false, error: 'skill_edit: missing frontmatter' };
      let fm = m[1];
      fm = fm.replace(/version:\s*(\d+)/, (_, v) => `version: ${Number(v) + 1}`);
      fs.writeFileSync(file, `---\n${fm}\n---\n${args.body}${args.body.endsWith('\n') ? '' : '\n'}`);
      return { ok: true, name: args.name };
    },
  };

  const memory_write = {
    name: 'memory_write', category: 'learning', sensitive: true,
    description: 'Append to layered memory. kind=recent appends a JSONL line; kind=core overwrites core.md; kind=episodic writes episodic/<topic>.md.',
    parameters: {
      type: 'object',
      properties: {
        kind:    { type: 'string', enum: ['recent', 'core', 'episodic'] },
        content: { type: 'string' },
        topic:   { type: 'string' },
      },
      required: ['kind', 'content'],
    },
    async exec(args, ctx) {
      const dir = memoryDir(ctx);
      fs.mkdirSync(dir, { recursive: true });
      if (args.kind === 'recent') {
        fs.appendFileSync(path.join(dir, 'recent.jsonl'), JSON.stringify({ ts: Date.now(), content: args.content }) + '\n');
      } else if (args.kind === 'core') {
        fs.writeFileSync(path.join(dir, 'core.md'), args.content);
      } else if (args.kind === 'episodic') {
        if (!args.topic) return { ok: false, error: 'memory_write: topic required for episodic' };
        fs.mkdirSync(path.join(dir, 'episodic'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'episodic', `${args.topic}.md`), args.content);
      } else {
        return { ok: false, error: `memory_write: unknown kind ${args.kind}` };
      }
      return { ok: true, kind: args.kind };
    },
  };

  const memory_read = {
    name: 'memory_read', category: 'learning', sensitive: false,
    description: 'Read layered memory. kind=recent returns last N JSONL entries; kind=core returns core.md; kind=episodic returns episodic/<topic>.md.',
    parameters: {
      type: 'object',
      properties: {
        kind:  { type: 'string', enum: ['recent', 'core', 'episodic'] },
        topic: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['kind'],
    },
    async exec(args, ctx) {
      const dir = memoryDir(ctx);
      if (args.kind === 'recent') {
        const f = path.join(dir, 'recent.jsonl');
        if (!fs.existsSync(f)) return { ok: true, entries: [] };
        const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
        const limit = Math.max(1, Math.min(200, args.limit || 20));
        return { ok: true, entries: lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return { content: l }; } }) };
      }
      if (args.kind === 'core') {
        const f = path.join(dir, 'core.md');
        return { ok: true, content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' };
      }
      if (args.kind === 'episodic') {
        if (!args.topic) return { ok: false, error: 'memory_read: topic required for episodic' };
        const f = path.join(dir, 'episodic', `${args.topic}.md`);
        return { ok: true, content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' };
      }
      return { ok: false, error: `memory_read: unknown kind ${args.kind}` };
    },
  };

  const user_view = {
    name: 'user_view', category: 'learning', sensitive: false,
    description: 'Read the persistent USER.md (Honcho-equivalent user model).',
    parameters: { type: 'object', properties: {} },
    async exec(_args, ctx) {
      const f = userMdPath(ctx);
      return { ok: true, content: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' };
    },
  };

  const user_update = {
    name: 'user_update', category: 'learning', sensitive: true,
    description: 'Overwrite USER.md (the persistent user model). Use sparingly — usually the user_modeler does this.',
    parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    async exec(args, ctx) {
      fs.mkdirSync(memoryDir(ctx), { recursive: true });
      fs.writeFileSync(userMdPath(ctx), args.content);
      return { ok: true, path: userMdPath(ctx) };
    },
  };

  export const TOOLS = [skill_view, skill_create, skill_edit, memory_write, memory_read, user_view, user_update];
  ```

- [ ] **4.4 Run test — verify PASS**
  - Run: `node --test tests/phaseE-tools-learning.test.mjs`
  - Expected: `# pass 6`

- [ ] **4.5 Register**

  Add to `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  import { TOOLS as learningTools } from './learning.mjs';
  for (const t of learningTools) { BUILTINS.push(t); TOOLS.set(t.name, t); }
  ```

  Note: `skill_view` is now also in `learning.mjs`. Remove the legacy `skillViewTool` import + push in the BUILTINS block (it is superseded by the v5 entry with `category: 'learning'`).

- [ ] **4.6 Commit**
  - Run: `git add mas/tools/learning.mjs mas/tools/registry.mjs tests/phaseE-tools-learning.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): learning group — skill_*, memory_*, user_*

    Seven tools that let an agent inspect and modify the skill bank,
    layered memory, and USER.md (canonical path memory/USER.md per C6).
    Sensitive matrix follows spec §7: writes require approval, reads
    do not.
    EOF
    )"
    ```

---

## Task 5 — web group (web_fetch, web_search, url_extract)

Estimated: 60 min. Spec §7 sub-bullet 4. SSRF block in `web_fetch`. `web_search` optional API-key-driven (Brave/Tavily/SerpAPI).

- [ ] **5.1 Add undici to runtime deps**

  Edit `/Users/o/lazyclaw/package.json`. Add `"dependencies": {...}` block (currently the file only has `devDependencies`):

  ```json
  "dependencies": {
    "undici": "^6.21.0"
  },
  ```

  Place it immediately above `"devDependencies"`.

  - Run: `npm install`
  - Expected: `added 1 package`. (If npm warns about peer deps it is OK.)

- [ ] **5.2 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-web.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as web from '../mas/tools/web.mjs';

  test('exports 3 web tools', () => {
    const names = web.TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, ['url_extract', 'web_fetch', 'web_search']);
  });

  test('web_fetch blocks loopback (SSRF)', async () => {
    const wf = web.TOOLS.find(t => t.name === 'web_fetch');
    const r = await wf.exec({ url: 'http://127.0.0.1:8080/secret' });
    assert.equal(r.ok, false);
    assert.match(r.error, /SSRF|private|loopback/i);
  });

  test('web_fetch blocks file://', async () => {
    const wf = web.TOOLS.find(t => t.name === 'web_fetch');
    const r = await wf.exec({ url: 'file:///etc/passwd' });
    assert.equal(r.ok, false);
  });

  test('web_search returns disabled-message when no provider key', async () => {
    const ws = web.TOOLS.find(t => t.name === 'web_search');
    const r = await ws.exec({ query: 'hello' }, { env: {} });
    assert.equal(r.ok, false);
    assert.match(r.error, /no provider configured/i);
  });

  test('url_extract pulls links from HTML', async () => {
    const ue = web.TOOLS.find(t => t.name === 'url_extract');
    const r = await ue.exec({ html: '<a href="https://a.com/x">a</a><a href="/rel">b</a>' });
    assert.equal(r.ok, true);
    assert.ok(r.urls.includes('https://a.com/x'));
  });

  test('sensitivity matrix', () => {
    const m = Object.fromEntries(web.TOOLS.map(t => [t.name, t.sensitive]));
    assert.equal(m.web_fetch, true);
    assert.equal(m.web_search, false);
    assert.equal(m.url_extract, false);
  });
  ```

- [ ] **5.3 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-tools-web.test.mjs`
  - Expected: `Cannot find module '../mas/tools/web.mjs'`

- [ ] **5.4 Implement web tools**

  Create `/Users/o/lazyclaw/mas/tools/web.mjs`:

  ```js
  // web — web_fetch (undici, SSRF block), web_search (Brave/Tavily/SerpAPI when
  // an API key env var is set), url_extract (extract links from HTML).
  // SSRF policy: reject loopback, RFC1918 private, link-local, file:, ftp:,
  // and any non-http(s) scheme.

  import { fetch } from 'undici';
  import dns from 'node:dns/promises';

  const PRIVATE_V4 = [
    /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[0-1])\./,
    /^127\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  ];

  async function isSafeUrl(url) {
    let u;
    try { u = new URL(url); } catch { return { ok: false, error: 'bad URL' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `scheme ${u.protocol} blocked` };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '0.0.0.0') return { ok: false, error: 'loopback blocked (SSRF)' };
    if (PRIVATE_V4.some(re => re.test(host))) return { ok: false, error: 'private address blocked (SSRF)' };
    if (host.includes(':')) return { ok: false, error: 'IPv6 disabled' };
    if (!/^[a-z0-9.-]+$/i.test(host)) return { ok: false, error: 'bad host' };
    try {
      const addrs = await dns.lookup(host, { all: true });
      for (const a of addrs) {
        if (PRIVATE_V4.some(re => re.test(a.address))) return { ok: false, error: 'resolves to private address (SSRF)' };
        if (a.address === '127.0.0.1' || a.address === '::1') return { ok: false, error: 'resolves to loopback (SSRF)' };
      }
    } catch (e) {
      return { ok: false, error: `dns: ${e.message}` };
    }
    return { ok: true };
  }

  const web_fetch = {
    name: 'web_fetch', category: 'net', sensitive: true,
    description: 'Fetch a public URL. Loopback / private / non-http(s) URLs are blocked.',
    parameters: {
      type: 'object',
      properties: {
        url:     { type: 'string' },
        method:  { type: 'string', enum: ['GET', 'POST'] },
        headers: { type: 'object' },
        body:    { type: 'string' },
        maxBytes:{ type: 'number' },
      },
      required: ['url'],
    },
    async exec(args) {
      const safe = await isSafeUrl(args.url);
      if (!safe.ok) return { ok: false, error: `web_fetch: ${safe.error}` };
      const maxBytes = Math.min(args.maxBytes || 2_000_000, 5_000_000);
      try {
        const res = await fetch(args.url, {
          method: args.method || 'GET',
          headers: args.headers || {},
          body: args.body,
          redirect: 'follow',
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const truncated = buf.length > maxBytes;
        return {
          ok: true, status: res.status,
          headers: Object.fromEntries(res.headers),
          body: buf.slice(0, maxBytes).toString('utf8'),
          truncated,
        };
      } catch (e) { return { ok: false, error: `web_fetch: ${e.message}` }; }
    },
  };

  const web_search = {
    name: 'web_search', category: 'net', sensitive: false,
    description: 'Search the public web via Brave (BRAVE_API_KEY), Tavily (TAVILY_API_KEY), or SerpAPI (SERPAPI_API_KEY).',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, k: { type: 'number' } },
      required: ['query'],
    },
    async exec(args, ctx) {
      const env = ctx?.env || process.env;
      if (env.BRAVE_API_KEY) return braveSearch(args, env.BRAVE_API_KEY);
      if (env.TAVILY_API_KEY) return tavilySearch(args, env.TAVILY_API_KEY);
      if (env.SERPAPI_API_KEY) return serpApiSearch(args, env.SERPAPI_API_KEY);
      return { ok: false, error: 'web_search: no provider configured (set BRAVE_API_KEY / TAVILY_API_KEY / SERPAPI_API_KEY)' };
    },
  };

  async function braveSearch({ query, k = 5 }, key) {
    try {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${k}`, {
        headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' },
      });
      const j = await r.json();
      return { ok: true, results: (j?.web?.results || []).slice(0, k).map(x => ({ title: x.title, url: x.url, snippet: x.description })) };
    } catch (e) { return { ok: false, error: `brave: ${e.message}` }; }
  }
  async function tavilySearch({ query, k = 5 }, key) {
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: k }),
      });
      const j = await r.json();
      return { ok: true, results: (j?.results || []).slice(0, k).map(x => ({ title: x.title, url: x.url, snippet: x.content })) };
    } catch (e) { return { ok: false, error: `tavily: ${e.message}` }; }
  }
  async function serpApiSearch({ query, k = 5 }, key) {
    try {
      const r = await fetch(`https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=${k}&api_key=${key}`);
      const j = await r.json();
      return { ok: true, results: (j?.organic_results || []).slice(0, k).map(x => ({ title: x.title, url: x.link, snippet: x.snippet })) };
    } catch (e) { return { ok: false, error: `serpapi: ${e.message}` }; }
  }

  const url_extract = {
    name: 'url_extract', category: 'net', sensitive: false,
    description: 'Extract all href URLs from an HTML string.',
    parameters: {
      type: 'object',
      properties: { html: { type: 'string' }, base: { type: 'string' } },
      required: ['html'],
    },
    async exec(args) {
      const urls = new Set();
      const re = /href\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(args.html))) {
        try {
          urls.add(args.base ? new URL(m[1], args.base).toString() : m[1]);
        } catch { urls.add(m[1]); }
      }
      return { ok: true, urls: [...urls] };
    },
  };

  export const TOOLS = [web_fetch, web_search, url_extract];
  ```

- [ ] **5.5 Run test — verify PASS**
  - Run: `node --test tests/phaseE-tools-web.test.mjs`
  - Expected: `# pass 6`

- [ ] **5.6 Register**

  Append to `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  import { TOOLS as webTools } from './web.mjs';
  for (const t of webTools) { BUILTINS.push(t); TOOLS.set(t.name, t); }
  ```

- [ ] **5.7 Commit**
  - Run: `git add mas/tools/web.mjs mas/tools/registry.mjs tests/phaseE-tools-web.test.mjs package.json package-lock.json`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): web group — fetch + search + url_extract

    web_fetch uses undici with an SSRF blocklist (loopback, RFC1918,
    link-local, non-http scheme) and a 5 MB ceiling. web_search picks
    Brave/Tavily/SerpAPI by env var. url_extract parses hrefs from HTML.
    EOF
    )"
    ```

---

## Task 6 — os group (clipboard, screenshot, notify, open_url, file_dialog)

Estimated: 55 min. Spec §7 sub-bullet 5. macOS + linux paths only — graceful "platform unsupported" on Windows/other.

- [ ] **6.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-os.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as osTools from '../mas/tools/os.mjs';

  test('exports 6 os tools', () => {
    const names = osTools.TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, ['clipboard_read','clipboard_write','file_dialog','notify','open_url','screenshot']);
  });

  test('all os tools have a description and exec', () => {
    for (const t of osTools.TOOLS) {
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.exec, 'function');
      assert.equal(t.category, 'os');
    }
  });

  test('open_url rejects non-http(s)', async () => {
    const t = osTools.TOOLS.find(t => t.name === 'open_url');
    const r = await t.exec({ url: 'file:///etc/passwd' });
    assert.equal(r.ok, false);
  });

  test('clipboard_write reports unsupported gracefully on win32 stub', async () => {
    // Force platform via injected ctx.platform.
    const t = osTools.TOOLS.find(t => t.name === 'clipboard_write');
    const r = await t.exec({ text: 'x' }, { platform: 'win32' });
    assert.equal(r.ok, false);
    assert.match(r.error, /unsupported/i);
  });

  test('sensitivity: clipboard_write/screenshot/notify/open_url/file_dialog sensitive=true; clipboard_read sensitive=true (privacy)', () => {
    const m = Object.fromEntries(osTools.TOOLS.map(t => [t.name, t.sensitive]));
    assert.equal(m.clipboard_read, true);
    assert.equal(m.clipboard_write, true);
    assert.equal(m.screenshot, true);
    assert.equal(m.notify, false);
    assert.equal(m.open_url, true);
    assert.equal(m.file_dialog, true);
  });
  ```

- [ ] **6.2 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-tools-os.test.mjs`
  - Expected: `Cannot find module '../mas/tools/os.mjs'`

- [ ] **6.3 Implement os tools**

  Create `/Users/o/lazyclaw/mas/tools/os.mjs`:

  ```js
  // os — clipboard, screenshot, notify, open_url, file_dialog. macOS and
  // linux paths implemented; everything else returns "unsupported".
  // ctx.platform overrideable for tests.

  import { spawn, spawnSync } from 'node:child_process';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';

  function platformOf(ctx) { return ctx?.platform || process.platform; }

  function runCmd(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, opts);
      let out = '', err = '';
      child.stdout?.on('data', d => out += d.toString());
      child.stderr?.on('data', d => err += d.toString());
      child.on('error', e => resolve({ ok: false, error: e.message }));
      child.on('close', code => resolve({ ok: code === 0, stdout: out, stderr: err, exitCode: code }));
      if (opts.stdin) { child.stdin.write(opts.stdin); child.stdin.end(); }
    });
  }

  const clipboard_read = {
    name: 'clipboard_read', category: 'os', sensitive: true,
    description: 'Read the OS clipboard (text).',
    parameters: { type: 'object', properties: {} },
    async exec(_args, ctx) {
      const p = platformOf(ctx);
      if (p === 'darwin') {
        const r = spawnSync('pbpaste', [], { encoding: 'utf8' });
        return r.status === 0 ? { ok: true, text: r.stdout } : { ok: false, error: r.stderr || 'pbpaste failed' };
      }
      if (p === 'linux') {
        for (const [bin, args] of [['wl-paste', []], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]]) {
          const r = spawnSync(bin, args, { encoding: 'utf8' });
          if (r.status === 0) return { ok: true, text: r.stdout };
        }
        return { ok: false, error: 'clipboard_read: no clipboard helper (install wl-clipboard or xclip)' };
      }
      return { ok: false, error: `clipboard_read: unsupported platform ${p}` };
    },
  };

  const clipboard_write = {
    name: 'clipboard_write', category: 'os', sensitive: true,
    description: 'Write text to the OS clipboard.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async exec(args, ctx) {
      const p = platformOf(ctx);
      if (p === 'darwin') return runCmd('pbcopy', [], { stdin: args.text });
      if (p === 'linux') {
        for (const [bin, ar] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]) {
          const r = await runCmd(bin, ar, { stdin: args.text });
          if (r.ok) return { ok: true };
        }
        return { ok: false, error: 'clipboard_write: no clipboard helper' };
      }
      return { ok: false, error: `clipboard_write: unsupported platform ${p}` };
    },
  };

  const screenshot = {
    name: 'screenshot', category: 'os', sensitive: true,
    description: 'Capture a screenshot and write it to a PNG path (defaults to a tmpfile). Returns {path}.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    async exec(args, ctx) {
      const p = platformOf(ctx);
      const out = args?.path || path.join(os.tmpdir(), `lzc-${Date.now()}.png`);
      if (p === 'darwin') {
        const r = spawnSync('screencapture', ['-x', out]);
        return r.status === 0 ? { ok: true, path: out } : { ok: false, error: 'screencapture failed' };
      }
      if (p === 'linux') {
        for (const [bin, ar] of [['grim', [out]], ['gnome-screenshot', ['-f', out]], ['scrot', [out]]]) {
          const r = spawnSync(bin, ar);
          if (r.status === 0) return { ok: true, path: out };
        }
        return { ok: false, error: 'screenshot: no helper found (grim/gnome-screenshot/scrot)' };
      }
      return { ok: false, error: `screenshot: unsupported platform ${p}` };
    },
  };

  const notify = {
    name: 'notify', category: 'os', sensitive: false,
    description: 'Post a desktop notification. Best-effort; failures do not surface to the user.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
    },
    async exec(args, ctx) {
      const p = platformOf(ctx);
      const title = args.title;
      const body = args.body || '';
      if (p === 'darwin') {
        spawnSync('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]);
        return { ok: true };
      }
      if (p === 'linux') {
        spawnSync('notify-send', [title, body]);
        return { ok: true };
      }
      return { ok: false, error: `notify: unsupported platform ${p}` };
    },
  };

  const open_url = {
    name: 'open_url', category: 'os', sensitive: true,
    description: 'Open a public URL in the default browser. http(s) only.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async exec(args, ctx) {
      try {
        const u = new URL(args.url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'open_url: http(s) only' };
      } catch { return { ok: false, error: 'open_url: bad URL' }; }
      const p = platformOf(ctx);
      if (p === 'darwin') return runCmd('open', [args.url]);
      if (p === 'linux') return runCmd('xdg-open', [args.url]);
      return { ok: false, error: `open_url: unsupported platform ${p}` };
    },
  };

  const file_dialog = {
    name: 'file_dialog', category: 'os', sensitive: true,
    description: 'Show an OS file picker. Returns selected path (or null on cancel).',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['open', 'save'] }, prompt: { type: 'string' } },
    },
    async exec(args, ctx) {
      const p = platformOf(ctx);
      if (p === 'darwin') {
        const script = (args.kind === 'save')
          ? 'POSIX path of (choose file name with prompt "' + (args.prompt || 'Save').replace(/"/g, '\\"') + '")'
          : 'POSIX path of (choose file with prompt "'      + (args.prompt || 'Choose').replace(/"/g, '\\"') + '")';
        const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
        if (r.status !== 0) return { ok: true, path: null };
        return { ok: true, path: r.stdout.trim() };
      }
      if (p === 'linux') {
        const ar = args.kind === 'save' ? ['--file-selection', '--save'] : ['--file-selection'];
        const r = spawnSync('zenity', ar, { encoding: 'utf8' });
        if (r.status !== 0) return { ok: true, path: null };
        return { ok: true, path: r.stdout.trim() };
      }
      return { ok: false, error: `file_dialog: unsupported platform ${p}` };
    },
  };

  export const TOOLS = [clipboard_read, clipboard_write, screenshot, notify, open_url, file_dialog];
  ```

- [ ] **6.4 Run test — verify PASS**
  - Run: `node --test tests/phaseE-tools-os.test.mjs`
  - Expected: `# pass 5`

- [ ] **6.5 Register**

  Append to `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  import { TOOLS as osTools } from './os.mjs';
  for (const t of osTools) { BUILTINS.push(t); TOOLS.set(t.name, t); }
  ```

- [ ] **6.6 Commit**
  - Run: `git add mas/tools/os.mjs mas/tools/registry.mjs tests/phaseE-tools-os.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): os group — clipboard, screenshot, notify, open_url, file_dialog

    macOS uses pbcopy/pbpaste/screencapture/osascript/open; linux falls
    back through wl-clipboard/xclip/xsel, grim/gnome-screenshot/scrot,
    notify-send, xdg-open, zenity. Other platforms return a structured
    unsupported error.
    EOF
    )"
    ```

---

## Task 7 — coding group (python_exec, node_exec, sql_query, http_request, regex_match)

Estimated: 60 min. Spec §7 sub-bullet 6. All sandboxed (run inside Phase A `sandbox/`).

- [ ] **7.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-coding.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as coding from '../mas/tools/coding.mjs';

  test('exports 5 coding tools', () => {
    const names = coding.TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, ['http_request', 'node_exec', 'python_exec', 'regex_match', 'sql_query']);
  });

  test('regex_match returns matches', async () => {
    const t = coding.TOOLS.find(t => t.name === 'regex_match');
    const r = await t.exec({ pattern: '\\d+', text: 'a1 b22 c333', flags: 'g' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.matches, ['1', '22', '333']);
  });

  test('node_exec runs a script', async () => {
    const t = coding.TOOLS.find(t => t.name === 'node_exec');
    const r = await t.exec({ code: 'console.log(1+1)' });
    assert.equal(r.ok, true);
    assert.match(r.stdout, /2/);
  });

  test('python_exec gracefully reports missing interpreter', async () => {
    const t = coding.TOOLS.find(t => t.name === 'python_exec');
    const r = await t.exec({ code: 'print(1)' }, { python: '/no/such/python' });
    assert.equal(r.ok, false);
  });

  test('sql_query rejects when no db engine bound', async () => {
    const t = coding.TOOLS.find(t => t.name === 'sql_query');
    const r = await t.exec({ sql: 'SELECT 1' });
    assert.equal(r.ok, false);
    assert.match(r.error, /no database/i);
  });

  test('http_request reuses web_fetch SSRF policy', async () => {
    const t = coding.TOOLS.find(t => t.name === 'http_request');
    const r = await t.exec({ url: 'http://127.0.0.1/x', method: 'GET' });
    assert.equal(r.ok, false);
  });
  ```

- [ ] **7.2 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-tools-coding.test.mjs`
  - Expected: `Cannot find module '../mas/tools/coding.mjs'`

- [ ] **7.3 Implement coding tools**

  Create `/Users/o/lazyclaw/mas/tools/coding.mjs`:

  ```js
  // coding — sandboxed code runners (python_exec, node_exec), data tools
  // (sql_query stub, http_request that reuses web_fetch SSRF policy),
  // and a pure helper (regex_match).

  import { spawn } from 'node:child_process';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { TOOLS as webTools } from './web.mjs';

  function runProc(cmd, args, opts = {}) {
    return new Promise(resolve => {
      let p;
      try { p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env }); }
      catch (e) { return resolve({ ok: false, error: e.message }); }
      let out = '', err = '';
      const timeout = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, opts.timeoutMs || 30_000);
      p.on('error', e => { clearTimeout(timeout); resolve({ ok: false, error: e.message }); });
      p.stdout?.on('data', d => out += d.toString());
      p.stderr?.on('data', d => err += d.toString());
      p.on('close', code => { clearTimeout(timeout); resolve({ ok: code === 0, stdout: out, stderr: err, exitCode: code }); });
      if (opts.stdin != null) { p.stdin.write(opts.stdin); p.stdin.end(); }
    });
  }

  const python_exec = {
    name: 'python_exec', category: 'coding', sensitive: true,
    description: 'Run a Python snippet in a sandboxed subprocess. 30s timeout.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' }, timeoutMs: { type: 'number' } },
      required: ['code'],
    },
    async exec(args, ctx) {
      const py = ctx?.python || process.env.LAZYCLAW_PYTHON || 'python3';
      return runProc(py, ['-c', args.code], { cwd: ctx?.cwd, timeoutMs: args.timeoutMs });
    },
  };

  const node_exec = {
    name: 'node_exec', category: 'coding', sensitive: true,
    description: 'Run a Node.js snippet in a sandboxed subprocess. 30s timeout.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string' }, timeoutMs: { type: 'number' } },
      required: ['code'],
    },
    async exec(args, ctx) {
      const node = ctx?.node || process.execPath;
      return runProc(node, ['-e', args.code], { cwd: ctx?.cwd, timeoutMs: args.timeoutMs });
    },
  };

  const sql_query = {
    name: 'sql_query', category: 'coding', sensitive: true,
    description: 'Run a read-only SQL query against the agent\'s bound database. Returns rows.',
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string' }, params: { type: 'array' } },
      required: ['sql'],
    },
    async exec(args, ctx) {
      const db = ctx?.db || null;
      if (!db) return { ok: false, error: 'sql_query: no database bound to agent context' };
      try {
        const stmt = db.prepare(args.sql);
        const rows = stmt.all(...(args.params || []));
        return { ok: true, rows };
      } catch (e) { return { ok: false, error: `sql_query: ${e.message}` }; }
    },
  };

  const http_request = {
    name: 'http_request', category: 'coding', sensitive: true,
    description: 'Generic HTTP client. Reuses web_fetch SSRF policy.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' }, method: { type: 'string' },
        headers: { type: 'object' }, body: { type: 'string' },
      },
      required: ['url'],
    },
    async exec(args, ctx) {
      const wf = webTools.find(t => t.name === 'web_fetch');
      return wf.exec(args, ctx);
    },
  };

  const regex_match = {
    name: 'regex_match', category: 'coding', sensitive: false,
    description: 'Run a regex over a string and return the matches.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, flags: { type: 'string' }, text: { type: 'string' } },
      required: ['pattern', 'text'],
    },
    async exec(args) {
      try {
        const re = new RegExp(args.pattern, args.flags || '');
        const matches = args.flags?.includes('g')
          ? [...args.text.matchAll(re)].map(m => m[0])
          : (args.text.match(re) || []);
        return { ok: true, matches };
      } catch (e) { return { ok: false, error: `regex_match: ${e.message}` }; }
    },
  };

  export const TOOLS = [python_exec, node_exec, sql_query, http_request, regex_match];
  ```

- [ ] **7.4 Run test — verify PASS**
  - Run: `node --test tests/phaseE-tools-coding.test.mjs`
  - Expected: `# pass 6`

- [ ] **7.5 Register**

  Append to `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  import { TOOLS as codingTools } from './coding.mjs';
  for (const t of codingTools) { BUILTINS.push(t); TOOLS.set(t.name, t); }
  ```

- [ ] **7.6 Commit**
  - Run: `git add mas/tools/coding.mjs mas/tools/registry.mjs tests/phaseE-tools-coding.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): coding group — python/node exec, sql, http, regex

    Sandboxed via subprocess + 30 s default timeout. sql_query is a stub
    that requires an agent-bound db handle. http_request delegates to
    web_fetch so the SSRF policy is the single source of truth.
    EOF
    )"
    ```

---

## Task 8 — git group (status, diff, log, blame, branch read; commit, push sensitive)

Estimated: 55 min. Spec §7 sub-bullet 7.

- [ ] **8.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-git.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { spawnSync } from 'node:child_process';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import * as gitTools from '../mas/tools/git.mjs';

  function tmpRepo() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-git-'));
    spawnSync('git', ['init', '-q'], { cwd: d });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: d });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: d });
    fs.writeFileSync(path.join(d, 'a.txt'), 'hi\n');
    spawnSync('git', ['add', '.'], { cwd: d });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: d });
    return d;
  }

  test('exports 7 git tools', () => {
    const names = gitTools.TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, ['git_blame','git_branch','git_commit','git_diff','git_log','git_push','git_status']);
  });

  test('git_status returns clean tree', async () => {
    const d = tmpRepo();
    const t = gitTools.TOOLS.find(t => t.name === 'git_status');
    const r = await t.exec({}, { cwd: d });
    assert.equal(r.ok, true);
    assert.match(r.stdout, /clean|nothing/);
  });

  test('git_log returns at least one commit', async () => {
    const d = tmpRepo();
    const t = gitTools.TOOLS.find(t => t.name === 'git_log');
    const r = await t.exec({ limit: 5 }, { cwd: d });
    assert.equal(r.ok, true);
    assert.ok(r.commits.length >= 1);
  });

  test('git_commit stages then commits', async () => {
    const d = tmpRepo();
    fs.writeFileSync(path.join(d, 'b.txt'), 'x');
    const t = gitTools.TOOLS.find(t => t.name === 'git_commit');
    const r = await t.exec({ message: 'add b', paths: ['b.txt'] }, { cwd: d });
    assert.equal(r.ok, true);
  });

  test('sensitivity matrix', () => {
    const m = Object.fromEntries(gitTools.TOOLS.map(t => [t.name, t.sensitive]));
    assert.equal(m.git_status, false);
    assert.equal(m.git_diff, false);
    assert.equal(m.git_log, false);
    assert.equal(m.git_blame, false);
    assert.equal(m.git_branch, false);
    assert.equal(m.git_commit, true);
    assert.equal(m.git_push, true);
  });
  ```

- [ ] **8.2 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-tools-git.test.mjs`
  - Expected: `Cannot find module '../mas/tools/git.mjs'`

- [ ] **8.3 Implement git tools**

  Create `/Users/o/lazyclaw/mas/tools/git.mjs`:

  ```js
  // git — read-only inspection (status/diff/log/blame/branch) and two
  // sensitive writes (commit/push). All shell out to git in ctx.cwd.

  import { spawnSync } from 'node:child_process';

  function git(cwd, args, opts = {}) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
  }

  const git_status = {
    name: 'git_status', category: 'git', sensitive: false,
    description: 'Run `git status` in the workspace.',
    parameters: { type: 'object', properties: {} },
    async exec(_args, ctx) { return git(ctx?.cwd, ['status']); },
  };

  const git_diff = {
    name: 'git_diff', category: 'git', sensitive: false,
    description: 'Run `git diff [path]`. Pass {staged:true} for `--staged`.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, staged: { type: 'boolean' } } },
    async exec(args, ctx) {
      const ar = ['diff'];
      if (args?.staged) ar.push('--staged');
      if (args?.path) ar.push('--', args.path);
      return git(ctx?.cwd, ar);
    },
  };

  const git_log = {
    name: 'git_log', category: 'git', sensitive: false,
    description: 'Recent commits as structured objects.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    async exec(args, ctx) {
      const n = Math.max(1, Math.min(args?.limit || 10, 100));
      const r = git(ctx?.cwd, ['log', `-n${n}`, '--pretty=format:%H%x09%an%x09%aI%x09%s']);
      if (!r.ok) return r;
      const commits = r.stdout.trim().split('\n').filter(Boolean).map(line => {
        const [hash, author, date, subject] = line.split('\t');
        return { hash, author, date, subject };
      });
      return { ok: true, commits };
    },
  };

  const git_blame = {
    name: 'git_blame', category: 'git', sensitive: false,
    description: 'Run `git blame <path>`.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async exec(args, ctx) { return git(ctx?.cwd, ['blame', '--', args.path]); },
  };

  const git_branch = {
    name: 'git_branch', category: 'git', sensitive: false,
    description: 'List branches.',
    parameters: { type: 'object', properties: {} },
    async exec(_args, ctx) {
      const r = git(ctx?.cwd, ['branch', '--all', '--format=%(refname:short)%09%(upstream:short)%09%(HEAD)']);
      if (!r.ok) return r;
      const branches = r.stdout.trim().split('\n').filter(Boolean).map(line => {
        const [name, upstream, head] = line.split('\t');
        return { name, upstream, current: head === '*' };
      });
      return { ok: true, branches };
    },
  };

  const git_commit = {
    name: 'git_commit', category: 'git', sensitive: true,
    description: 'Stage paths (or skip when omitted) and commit.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        paths:   { type: 'array', items: { type: 'string' } },
        amend:   { type: 'boolean' },
      },
      required: ['message'],
    },
    async exec(args, ctx) {
      if (Array.isArray(args.paths) && args.paths.length) {
        const a = git(ctx?.cwd, ['add', '--', ...args.paths]);
        if (!a.ok) return a;
      }
      const ar = ['commit', '-m', args.message];
      if (args.amend) ar.splice(1, 0, '--amend');
      return git(ctx?.cwd, ar);
    },
  };

  const git_push = {
    name: 'git_push', category: 'git', sensitive: true,
    description: 'Push to a remote. Refuses --force unless force=true explicitly.',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string' }, branch: { type: 'string' },
        force:  { type: 'boolean' },
      },
    },
    async exec(args, ctx) {
      const ar = ['push'];
      if (args?.force) ar.push('--force-with-lease');
      if (args?.remote) ar.push(args.remote);
      if (args?.branch) ar.push(args.branch);
      return git(ctx?.cwd, ar);
    },
  };

  export const TOOLS = [git_status, git_diff, git_log, git_blame, git_branch, git_commit, git_push];
  ```

- [ ] **8.4 Run test — verify PASS**
  - Run: `node --test tests/phaseE-tools-git.test.mjs`
  - Expected: `# pass 5`

- [ ] **8.5 Register**

  Append to `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  import { TOOLS as gitGroupTools } from './git.mjs';
  for (const t of gitGroupTools) { BUILTINS.push(t); TOOLS.set(t.name, t); }
  ```

- [ ] **8.6 Commit**
  - Run: `git add mas/tools/git.mjs mas/tools/registry.mjs tests/phaseE-tools-git.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): git group — 5 read-only + 2 sensitive writers

    git_status / git_diff / git_log / git_blame / git_branch are
    read-only. git_commit and git_push are sensitive; push defaults to
    --force-with-lease when force=true is set.
    EOF
    )"
    ```

---

## Task 9 — scheduling group (cron_add, cron_remove, cron_list)

Estimated: 35 min. Spec §7 sub-bullet 8 — wraps `cron.mjs`.

- [ ] **9.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-scheduling.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as sched from '../mas/tools/scheduling.mjs';

  test('exports 3 scheduling tools', () => {
    const names = sched.TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, ['cron_add', 'cron_list', 'cron_remove']);
  });

  test('cron_add rejects bad spec', async () => {
    const t = sched.TOOLS.find(t => t.name === 'cron_add');
    const r = await t.exec({ name: 'x', spec: 'banana', command: 'echo hi' });
    assert.equal(r.ok, false);
  });

  test('cron_add accepts valid spec, returns marker', async () => {
    sched.__setCronBackend({
      add: async (j) => ({ ok: true, id: `lz:${j.name}` }),
      list: async () => [{ name: 'x', spec: '0 9 * * *' }],
      remove: async (n) => ({ ok: true, removed: n }),
    });
    const t = sched.TOOLS.find(t => t.name === 'cron_add');
    const r = await t.exec({ name: 'morning', spec: '0 9 * * *', command: 'echo hi' });
    assert.equal(r.ok, true);
    sched.__setCronBackend(null);
  });

  test('all sensitive=true', () => {
    for (const t of sched.TOOLS) assert.equal(t.sensitive, true);
  });
  ```

- [ ] **9.2 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-tools-scheduling.test.mjs`
  - Expected: `Cannot find module '../mas/tools/scheduling.mjs'`

- [ ] **9.3 Implement scheduling tools**

  Create `/Users/o/lazyclaw/mas/tools/scheduling.mjs`:

  ```js
  // scheduling — cron_add / cron_remove / cron_list. Wraps cron.mjs but the
  // backend is overridable for tests via __setCronBackend.

  let _backend = null;
  export function __setCronBackend(b) { _backend = b; }

  async function getBackend() {
    if (_backend) return _backend;
    const cron = await import('../../cron.mjs').catch(() => null);
    if (!cron) throw new Error('scheduling: cron.mjs not available');
    return {
      add:    async (j) => cron.add ? cron.add(j) : { ok: false, error: 'cron.add missing' },
      list:   async ()  => cron.list ? cron.list() : [],
      remove: async (n) => cron.remove ? cron.remove(n) : { ok: false, error: 'cron.remove missing' },
    };
  }

  // Field-count validator independent of cron.mjs internals so we get a clean error.
  function looksLikeCronSpec(s) {
    return typeof s === 'string' && s.trim().split(/\s+/).length === 5;
  }

  const cron_add = {
    name: 'cron_add', category: 'scheduling', sensitive: true,
    description: 'Schedule a recurring agent run or shell command.',
    parameters: {
      type: 'object',
      properties: {
        name:    { type: 'string' },
        spec:    { type: 'string', description: '5-field cron spec.' },
        command: { type: 'string' },
      },
      required: ['name', 'spec', 'command'],
    },
    async exec(args) {
      if (!looksLikeCronSpec(args.spec)) return { ok: false, error: `cron_add: bad cron spec "${args.spec}"` };
      const b = await getBackend();
      return b.add({ name: args.name, spec: args.spec, command: args.command });
    },
  };

  const cron_remove = {
    name: 'cron_remove', category: 'scheduling', sensitive: true,
    description: 'Remove a scheduled job by name.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async exec(args) {
      const b = await getBackend();
      return b.remove(args.name);
    },
  };

  const cron_list = {
    name: 'cron_list', category: 'scheduling', sensitive: true,
    description: 'List scheduled jobs.',
    parameters: { type: 'object', properties: {} },
    async exec() {
      const b = await getBackend();
      return { ok: true, jobs: await b.list() };
    },
  };

  export const TOOLS = [cron_add, cron_remove, cron_list];
  ```

- [ ] **9.4 Run test — verify PASS**
  - Run: `node --test tests/phaseE-tools-scheduling.test.mjs`
  - Expected: `# pass 4`

- [ ] **9.5 Register**

  Append to `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  import { TOOLS as schedTools } from './scheduling.mjs';
  for (const t of schedTools) { BUILTINS.push(t); TOOLS.set(t.name, t); }
  ```

- [ ] **9.6 Commit**
  - Run: `git add mas/tools/scheduling.mjs mas/tools/registry.mjs tests/phaseE-tools-scheduling.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): scheduling group — cron_add/remove/list

    Thin adapter over cron.mjs with a lazy dynamic import plus a setter
    for tests. All three tools sensitive=true because cron installs OS
    state (launchd plist / crontab line).
    EOF
    )"
    ```

---

## Task 10 — delegation group (task_spawn, delegate)

Estimated: 40 min. Spec §7 sub-bullet 9 — reuses orchestrator dispatch.

- [ ] **10.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-delegation.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as del from '../mas/tools/delegation.mjs';

  test('exports 2 delegation tools', () => {
    const names = del.TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, ['delegate', 'task_spawn']);
  });

  test('task_spawn requires agent + prompt', async () => {
    const t = del.TOOLS.find(t => t.name === 'task_spawn');
    const r = await t.exec({});
    assert.equal(r.ok, false);
  });

  test('delegate routes through injected dispatcher', async () => {
    const calls = [];
    del.__setDispatcher(async (job) => { calls.push(job); return { ok: true, output: 'done' }; });
    const t = del.TOOLS.find(t => t.name === 'delegate');
    const r = await t.exec({ worker: 'codex-cli', prompt: 'do x' });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].worker, 'codex-cli');
    del.__setDispatcher(null);
  });

  test('both sensitive=true', () => {
    for (const t of del.TOOLS) assert.equal(t.sensitive, true);
  });
  ```

- [ ] **10.2 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-tools-delegation.test.mjs`
  - Expected: `Cannot find module '../mas/tools/delegation.mjs'`

- [ ] **10.3 Implement delegation tools**

  Create `/Users/o/lazyclaw/mas/tools/delegation.mjs`:

  ```js
  // delegation — task_spawn (named agent), delegate (worker provider).
  // Both lazy-import providers/orchestrator.mjs / mas/agent_turn.mjs to
  // avoid pulling those into every process that imports the registry.

  let _dispatcher = null;
  export function __setDispatcher(fn) { _dispatcher = fn; }

  async function dispatchDelegate(job) {
    if (_dispatcher) return _dispatcher(job);
    const orch = await import('../../providers/orchestrator.mjs').catch(() => null);
    if (!orch || typeof orch.dispatchWorker !== 'function') {
      return { ok: false, error: 'delegate: orchestrator.dispatchWorker unavailable' };
    }
    return orch.dispatchWorker(job);
  }

  async function dispatchSpawn(job) {
    const at = await import('../agent_turn.mjs').catch(() => null);
    if (!at || typeof at.runAgentTurn !== 'function') {
      return { ok: false, error: 'task_spawn: agent_turn.runAgentTurn unavailable' };
    }
    return at.runAgentTurn(job);
  }

  const task_spawn = {
    name: 'task_spawn', category: 'agents', sensitive: true,
    description: 'Spawn an agent by name with a prompt; returns the final answer.',
    parameters: {
      type: 'object',
      properties: { agent: { type: 'string' }, prompt: { type: 'string' } },
      required: ['agent', 'prompt'],
    },
    async exec(args) {
      if (!args?.agent || !args?.prompt) return { ok: false, error: 'task_spawn: agent + prompt required' };
      return dispatchSpawn({ agent: args.agent, prompt: args.prompt });
    },
  };

  const delegate = {
    name: 'delegate', category: 'agents', sensitive: true,
    description: 'Dispatch a subtask to a worker provider (claude-cli, codex-cli, gemini-cli, anthropic, openai, gemini, ollama).',
    parameters: {
      type: 'object',
      properties: { worker: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' } },
      required: ['worker', 'prompt'],
    },
    async exec(args) {
      if (!args?.worker || !args?.prompt) return { ok: false, error: 'delegate: worker + prompt required' };
      return dispatchDelegate({ worker: args.worker, prompt: args.prompt, model: args.model });
    },
  };

  export const TOOLS = [task_spawn, delegate];
  ```

- [ ] **10.4 Run test — verify PASS**
  - Run: `node --test tests/phaseE-tools-delegation.test.mjs`
  - Expected: `# pass 4`

- [ ] **10.5 Register**

  Append to `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  import { TOOLS as delTools } from './delegation.mjs';
  for (const t of delTools) { BUILTINS.push(t); TOOLS.set(t.name, t); }
  ```

- [ ] **10.6 Commit**
  - Run: `git add mas/tools/delegation.mjs mas/tools/registry.mjs tests/phaseE-tools-delegation.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): delegation group — task_spawn + delegate

    Both wrap existing orchestration entry points via lazy import.
    Sensitive because they fan out to subprocess CLI workers that may
    in turn run their own tool calls.
    EOF
    )"
    ```

---

## Task 11 — media + ha groups (stubs per §0.2)

Estimated: 50 min. Spec §7 sub-bullets 10 & 11. HA + TTS are deferred to v5.1 per §0.2; ship stubs that say so. `image_describe` / `image_generate` / `transcribe` can have lightweight provider hooks.

- [ ] **11.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-media.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as media from '../mas/tools/media.mjs';

  test('exports 4 media tools', () => {
    const names = media.TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, ['image_describe', 'image_generate', 'transcribe', 'tts_speak']);
  });

  test('tts_speak returns "deferred to v5.1"', async () => {
    const t = media.TOOLS.find(t => t.name === 'tts_speak');
    const r = await t.exec({ text: 'hi' });
    assert.equal(r.ok, false);
    assert.match(r.error, /v5\.1|deferred/i);
  });

  test('image_generate requires provider key', async () => {
    const t = media.TOOLS.find(t => t.name === 'image_generate');
    const r = await t.exec({ prompt: 'x' }, { env: {} });
    assert.equal(r.ok, false);
  });

  test('all sensitive=true', () => {
    for (const t of media.TOOLS) assert.equal(t.sensitive, true);
  });
  ```

  Create `/Users/o/lazyclaw/tests/phaseE-tools-ha.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as ha from '../mas/tools/ha.mjs';

  test('exports 2 ha tools', () => {
    const names = ha.TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, ['ha_call_service', 'ha_get_state']);
  });

  test('all return "v5.1" deferred error', async () => {
    for (const t of ha.TOOLS) {
      const r = await t.exec({});
      assert.equal(r.ok, false);
      assert.match(r.error, /v5\.1|deferred/i);
    }
  });
  ```

- [ ] **11.2 Run tests — verify FAIL**
  - Run: `node --test tests/phaseE-tools-media.test.mjs tests/phaseE-tools-ha.test.mjs`
  - Expected: Cannot find module errors for both.

- [ ] **11.3 Implement media tools**

  Create `/Users/o/lazyclaw/mas/tools/media.mjs`:

  ```js
  // media — image_describe (vision provider), image_generate (FAL/DALL-E
  // optional via env key), tts_speak (deferred to v5.1 per spec §0.2),
  // transcribe (whisper.cpp local OR OpenAI whisper API by env key).
  // Provider integrations are opt-in via env vars; all return a structured
  // "configure X" error otherwise.

  import fs from 'node:fs';
  import { fetch } from 'undici';

  const image_describe = {
    name: 'image_describe', category: 'media', sensitive: true,
    description: 'Describe an image. Requires OPENAI_API_KEY (gpt-4o vision) or ANTHROPIC_API_KEY (claude vision).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, prompt: { type: 'string' } },
      required: ['path'],
    },
    async exec(args, ctx) {
      const env = ctx?.env || process.env;
      if (!fs.existsSync(args.path)) return { ok: false, error: `image_describe: file not found ${args.path}` };
      const b64 = fs.readFileSync(args.path).toString('base64');
      const prompt = args.prompt || 'Describe this image briefly.';
      if (env.OPENAI_API_KEY) {
        try {
          const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST', headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            ] }] }),
          });
          const j = await r.json();
          return { ok: true, description: j?.choices?.[0]?.message?.content || '' };
        } catch (e) { return { ok: false, error: `image_describe: ${e.message}` }; }
      }
      return { ok: false, error: 'image_describe: set OPENAI_API_KEY (gpt-4o vision)' };
    },
  };

  const image_generate = {
    name: 'image_generate', category: 'media', sensitive: true,
    description: 'Generate an image. Requires OPENAI_API_KEY (DALL-E) or FAL_KEY.',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' }, outPath: { type: 'string' } },
      required: ['prompt'],
    },
    async exec(args, ctx) {
      const env = ctx?.env || process.env;
      if (!env.OPENAI_API_KEY && !env.FAL_KEY) return { ok: false, error: 'image_generate: set OPENAI_API_KEY or FAL_KEY' };
      if (env.OPENAI_API_KEY) {
        try {
          const r = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST', headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'gpt-image-1', prompt: args.prompt, size: '1024x1024' }),
          });
          const j = await r.json();
          const b64 = j?.data?.[0]?.b64_json;
          if (!b64) return { ok: false, error: `image_generate: no data (${JSON.stringify(j).slice(0, 200)})` };
          if (args.outPath) fs.writeFileSync(args.outPath, Buffer.from(b64, 'base64'));
          return { ok: true, outPath: args.outPath || null, b64: args.outPath ? null : b64 };
        } catch (e) { return { ok: false, error: `image_generate: ${e.message}` }; }
      }
      return { ok: false, error: 'image_generate: FAL_KEY path not implemented in v5.0 (configure OPENAI_API_KEY)' };
    },
  };

  const tts_speak = {
    name: 'tts_speak', category: 'media', sensitive: true,
    description: 'STUB — TTS reply deferred to v5.1 per spec §0.2.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async exec() {
      return { ok: false, error: 'tts_speak: deferred to v5.1 (spec §0.2)' };
    },
  };

  const transcribe = {
    name: 'transcribe', category: 'media', sensitive: true,
    description: 'Transcribe audio. Requires OPENAI_API_KEY (whisper) or a local whisper.cpp binary at WHISPER_CPP.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, language: { type: 'string' } },
      required: ['path'],
    },
    async exec(args, ctx) {
      const env = ctx?.env || process.env;
      if (!fs.existsSync(args.path)) return { ok: false, error: `transcribe: file not found ${args.path}` };
      if (env.OPENAI_API_KEY) {
        try {
          const fd = new FormData();
          fd.append('file', new Blob([fs.readFileSync(args.path)]), 'audio');
          fd.append('model', 'whisper-1');
          if (args.language) fd.append('language', args.language);
          const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST', headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}` }, body: fd,
          });
          const j = await r.json();
          return { ok: true, text: j?.text || '' };
        } catch (e) { return { ok: false, error: `transcribe: ${e.message}` }; }
      }
      return { ok: false, error: 'transcribe: set OPENAI_API_KEY (whisper-1)' };
    },
  };

  export const TOOLS = [image_describe, image_generate, tts_speak, transcribe];
  ```

- [ ] **11.4 Implement ha tools (stub)**

  Create `/Users/o/lazyclaw/mas/tools/ha.mjs`:

  ```js
  // Home Assistant tools — STUB only in v5.0; activated in v5.1 per spec §0.2.
  // Registered so the catalogue lists them and config / toolset definitions
  // can reference them, but exec() returns a clear deferred message.

  function deferred(name) {
    return async () => ({ ok: false, error: `${name}: Home Assistant tools deferred to v5.1 (spec §0.2)` });
  }

  const ha_call_service = {
    name: 'ha_call_service', category: 'iot', sensitive: true,
    description: 'STUB — Home Assistant service call deferred to v5.1.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string' }, service: { type: 'string' },
        data: { type: 'object' },
      },
      required: ['domain', 'service'],
    },
    exec: deferred('ha_call_service'),
  };

  const ha_get_state = {
    name: 'ha_get_state', category: 'iot', sensitive: true,
    description: 'STUB — Home Assistant state read deferred to v5.1.',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string' } },
      required: ['entity_id'],
    },
    exec: deferred('ha_get_state'),
  };

  export const TOOLS = [ha_call_service, ha_get_state];
  ```

- [ ] **11.5 Run tests — verify PASS**
  - Run: `node --test tests/phaseE-tools-media.test.mjs tests/phaseE-tools-ha.test.mjs`
  - Expected: `# pass 4` + `# pass 2`

- [ ] **11.6 Register**

  Append to `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  import { TOOLS as mediaTools } from './media.mjs';
  import { TOOLS as haTools    } from './ha.mjs';
  for (const t of mediaTools) { BUILTINS.push(t); TOOLS.set(t.name, t); }
  for (const t of haTools)    { BUILTINS.push(t); TOOLS.set(t.name, t); }
  ```

- [ ] **11.7 Commit**
  - Run: `git add mas/tools/media.mjs mas/tools/ha.mjs mas/tools/registry.mjs tests/phaseE-tools-media.test.mjs tests/phaseE-tools-ha.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): media + ha groups (HA stubs per spec §0.2)

    image_describe (gpt-4o vision), image_generate (gpt-image-1),
    transcribe (whisper-1) are live opt-in via env keys. tts_speak is a
    typed stub. Home Assistant tools register their schemas but exec
    returns a v5.1-deferred message.
    EOF
    )"
    ```

---

## Task 12 — clarify + browser groups

Estimated: 55 min. Spec §7 sub-bullets 12 & 13. Browser tools wrap playwright (already a devDep — promote to dependencies for runtime is **out of scope** in v5.0; we lazy-load and return a clear error when unavailable).

- [ ] **12.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-tools-clarify.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as clarify from '../mas/tools/clarify.mjs';

  test('clarify tool shape', () => {
    assert.equal(clarify.TOOL.name, 'clarify');
    assert.equal(clarify.TOOL.category, 'agents');
    assert.equal(clarify.TOOL.sensitive, false);
  });

  test('clarify routes via injected asker', async () => {
    let asked;
    clarify.__setAsker(async (q) => { asked = q; return 'because.'; });
    const r = await clarify.TOOL.exec({ question: 'why?' });
    assert.equal(r.ok, true);
    assert.equal(r.answer, 'because.');
    assert.equal(asked.question, 'why?');
    clarify.__setAsker(null);
  });

  test('clarify fails when no asker bound and not a TTY', async () => {
    clarify.__setAsker(null);
    const r = await clarify.TOOL.exec({ question: 'why?' }, { isTTY: false });
    assert.equal(r.ok, false);
  });
  ```

  Create `/Users/o/lazyclaw/tests/phaseE-tools-browser.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as browser from '../mas/tools/browser.mjs';

  test('exports 4 browser tools', () => {
    const names = browser.TOOLS.map(t => t.name).sort();
    assert.deepEqual(names, ['browser_back', 'browser_click', 'browser_navigate', 'browser_screenshot']);
  });

  test('all browser tools sensitive=true', () => {
    for (const t of browser.TOOLS) assert.equal(t.sensitive, true);
  });

  test('browser_navigate refuses non-http(s)', async () => {
    const t = browser.TOOLS.find(t => t.name === 'browser_navigate');
    const r = await t.exec({ url: 'file:///etc/passwd' });
    assert.equal(r.ok, false);
  });

  test('exec returns clear error when playwright not installed (stubbed)', async () => {
    browser.__setBrowserBackend({
      navigate: async () => { throw new Error('playwright not installed'); },
    });
    const t = browser.TOOLS.find(t => t.name === 'browser_navigate');
    const r = await t.exec({ url: 'https://example.com' });
    assert.equal(r.ok, false);
    browser.__setBrowserBackend(null);
  });
  ```

- [ ] **12.2 Run tests — verify FAIL**
  - Run: `node --test tests/phaseE-tools-clarify.test.mjs tests/phaseE-tools-browser.test.mjs`
  - Expected: Cannot find module errors.

- [ ] **12.3 Implement clarify**

  Create `/Users/o/lazyclaw/mas/tools/clarify.mjs`:

  ```js
  // clarify — surface a question to the human user mid-turn. The actual
  // prompting mechanism is host-dependent (REPL prompt, Slack DM, gateway
  // SSE), so the runtime hooks an asker via __setAsker. Returns the user's
  // reply as a plain string. Pattern lifted from Hermes (spec §7 sub-12).

  let _asker = null;
  export function __setAsker(fn) { _asker = fn; }

  export const TOOL = {
    name: 'clarify',
    category: 'agents',
    sensitive: false,
    description: 'Ask the user a clarifying question and wait for the reply.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } } },
      required: ['question'],
    },
    async exec(args, ctx) {
      if (!args?.question) return { ok: false, error: 'clarify: question required' };
      if (typeof _asker === 'function') {
        try {
          const answer = await _asker({ question: args.question, choices: args.choices });
          return { ok: true, answer };
        } catch (e) { return { ok: false, error: `clarify: ${e.message}` }; }
      }
      if (ctx?.isTTY) {
        const readline = await import('node:readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`[clarify] ${args.question} > `);
        rl.close();
        return { ok: true, answer };
      }
      return { ok: false, error: 'clarify: no asker bound and not running in a TTY' };
    },
  };
  ```

- [ ] **12.4 Implement browser**

  Create `/Users/o/lazyclaw/mas/tools/browser.mjs`:

  ```js
  // browser — playwright-driven browser_navigate / click / back / screenshot.
  // Playwright is already a devDep (playwright.config.ts); we lazy-import and
  // return a structured error if it is missing at runtime. A persistent
  // headless Chromium context is reused across calls in the same process.

  let _backend = null;
  export function __setBrowserBackend(b) { _backend = b; }

  let _ctx = null;
  async function ensureCtx() {
    if (_backend) return _backend;
    if (_ctx) return _ctx;
    let pw;
    try { pw = await import('playwright'); }
    catch { throw new Error('browser: playwright not installed (npm i playwright)'); }
    const browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    _ctx = {
      navigate: async (url) => { await page.goto(url, { waitUntil: 'domcontentloaded' }); return { url: page.url(), title: await page.title() }; },
      click:    async (sel) => { await page.click(sel); return { clicked: sel }; },
      back:     async () => { await page.goBack(); return { url: page.url() }; },
      screenshot: async (path) => { await page.screenshot({ path, fullPage: true }); return { path }; },
    };
    return _ctx;
  }

  function safeHttp(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return true;
    } catch { return false; }
  }

  const browser_navigate = {
    name: 'browser_navigate', category: 'browser', sensitive: true,
    description: 'Navigate to an http(s) URL in a headless Chromium session.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async exec(args) {
      if (!safeHttp(args.url)) return { ok: false, error: 'browser_navigate: http(s) only' };
      try { const ctx = await ensureCtx(); return { ok: true, ...(await ctx.navigate(args.url)) }; }
      catch (e) { return { ok: false, error: `browser_navigate: ${e.message}` }; }
    },
  };

  const browser_click = {
    name: 'browser_click', category: 'browser', sensitive: true,
    description: 'Click an element by CSS selector.',
    parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] },
    async exec(args) {
      try { const ctx = await ensureCtx(); return { ok: true, ...(await ctx.click(args.selector)) }; }
      catch (e) { return { ok: false, error: `browser_click: ${e.message}` }; }
    },
  };

  const browser_back = {
    name: 'browser_back', category: 'browser', sensitive: true,
    description: 'Navigate back in browser history.',
    parameters: { type: 'object', properties: {} },
    async exec() {
      try { const ctx = await ensureCtx(); return { ok: true, ...(await ctx.back()) }; }
      catch (e) { return { ok: false, error: `browser_back: ${e.message}` }; }
    },
  };

  const browser_screenshot = {
    name: 'browser_screenshot', category: 'browser', sensitive: true,
    description: 'Capture a full-page PNG to <path>.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async exec(args) {
      try { const ctx = await ensureCtx(); return { ok: true, ...(await ctx.screenshot(args.path)) }; }
      catch (e) { return { ok: false, error: `browser_screenshot: ${e.message}` }; }
    },
  };

  export const TOOLS = [browser_navigate, browser_click, browser_back, browser_screenshot];
  ```

- [ ] **12.5 Run tests — verify PASS**
  - Run: `node --test tests/phaseE-tools-clarify.test.mjs tests/phaseE-tools-browser.test.mjs`
  - Expected: `# pass 3` + `# pass 4`

- [ ] **12.6 Register**

  Append to `/Users/o/lazyclaw/mas/tools/registry.mjs`:

  ```js
  import { TOOL  as clarifyTool } from './clarify.mjs';
  import { TOOLS as browserTools } from './browser.mjs';
  BUILTINS.push(clarifyTool);
  TOOLS.set(clarifyTool.name, clarifyTool);
  for (const t of browserTools) { BUILTINS.push(t); TOOLS.set(t.name, t); }
  ```

- [ ] **12.7 Commit**
  - Run: `git add mas/tools/clarify.mjs mas/tools/browser.mjs mas/tools/registry.mjs tests/phaseE-tools-clarify.test.mjs tests/phaseE-tools-browser.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(tools): clarify + browser groups

    clarify pauses a turn to ask the human (REPL readline by default,
    host-injectable via __setAsker). browser_* drive a shared headless
    Chromium via lazy-loaded playwright; missing-playwright returns a
    structured install hint.
    EOF
    )"
    ```

---

## Task 13 — toolsets module (agent edit --toolset)

Estimated: 40 min. Spec §7 sub-bullet 14.

- [ ] **13.1 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-toolsets.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import * as toolsets from '../mas/toolsets.mjs';

  function tmpHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lzc-ts-'));
  }

  test('built-in toolsets exist', () => {
    const all = toolsets.listToolsets();
    assert.ok(all.find(t => t.name === 'coding-min'));
    assert.ok(all.find(t => t.name === 'web-research'));
    assert.ok(all.find(t => t.name === 'devops'));
  });

  test('resolveToolset returns flat tool names', () => {
    const tools = toolsets.resolveToolset('coding-min');
    assert.ok(Array.isArray(tools));
    assert.ok(tools.includes('bash'));
    assert.ok(tools.includes('read'));
    assert.ok(tools.includes('write'));
    assert.ok(tools.includes('edit'));
  });

  test('addToolset persists to config dir', () => {
    const home = tmpHome();
    toolsets.addToolset({ name: 'my-set', tools: ['read', 'grep'] }, { configDir: home });
    const data = JSON.parse(fs.readFileSync(path.join(home, 'toolsets.json'), 'utf8'));
    assert.equal(data['my-set'].tools.length, 2);
  });

  test('removeToolset deletes', () => {
    const home = tmpHome();
    toolsets.addToolset({ name: 'temp', tools: ['read'] }, { configDir: home });
    toolsets.removeToolset('temp', { configDir: home });
    const data = JSON.parse(fs.readFileSync(path.join(home, 'toolsets.json'), 'utf8'));
    assert.equal(data['temp'], undefined);
  });

  test('resolveToolset rejects unknown names', () => {
    assert.throws(() => toolsets.resolveToolset('nope_xyz'));
  });
  ```

- [ ] **13.2 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-toolsets.test.mjs`
  - Expected: `Cannot find module '../mas/toolsets.mjs'`

- [ ] **13.3 Implement toolsets**

  Create `/Users/o/lazyclaw/mas/toolsets.mjs`:

  ```js
  // toolsets — named bundles of tool names that an agent can be assigned via
  // `lazyclaw agent edit <name> --toolset coding-min`. Built-ins ship in
  // code; user-defined sets live in <configDir>/toolsets.json.

  import fs from 'node:fs';
  import path from 'node:path';

  const BUILTIN = {
    'coding-min':  { tools: ['bash', 'read', 'write', 'edit', 'patch', 'grep', 'git_status', 'git_diff'] },
    'web-research':{ tools: ['web_fetch', 'web_search', 'url_extract', 'read', 'write', 'recall'] },
    'devops':      { tools: ['bash', 'git_status', 'git_diff', 'git_log', 'git_commit', 'cron_add', 'cron_list', 'http_request'] },
    'learning':    { tools: ['recall', 'skill_view', 'skill_create', 'skill_edit', 'memory_read', 'memory_write', 'user_view', 'user_update'] },
    'media':       { tools: ['image_describe', 'image_generate', 'transcribe'] },
    'agentic':     { tools: ['task_spawn', 'delegate', 'clarify', 'recall', 'skill_view'] },
  };

  function configFile(opts) {
    const dir = opts?.configDir || process.env.LAZYCLAW_CONFIG_DIR || path.join(process.env.HOME || '.', '.lazyclaw');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'toolsets.json');
  }

  function readUser(opts) {
    const f = configFile(opts);
    if (!fs.existsSync(f)) return {};
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch { return {}; }
  }

  function writeUser(data, opts) {
    fs.writeFileSync(configFile(opts), JSON.stringify(data, null, 2));
  }

  export function listToolsets(opts) {
    const user = readUser(opts);
    const out = [];
    for (const [name, t] of Object.entries(BUILTIN)) out.push({ name, ...t, source: 'builtin' });
    for (const [name, t] of Object.entries(user))    out.push({ name, ...t, source: 'user' });
    return out;
  }

  export function resolveToolset(name, opts) {
    const user = readUser(opts);
    const t = user[name] || BUILTIN[name];
    if (!t || !Array.isArray(t.tools)) throw new Error(`toolset "${name}" not found`);
    return [...t.tools];
  }

  export function addToolset({ name, tools }, opts) {
    if (!name || !Array.isArray(tools)) throw new Error('addToolset: name + tools[] required');
    if (BUILTIN[name]) throw new Error(`toolset "${name}" is built-in; pick a different name`);
    const data = readUser(opts);
    data[name] = { tools };
    writeUser(data, opts);
    return data[name];
  }

  export function removeToolset(name, opts) {
    if (BUILTIN[name]) throw new Error(`cannot remove built-in toolset "${name}"`);
    const data = readUser(opts);
    delete data[name];
    writeUser(data, opts);
    return true;
  }
  ```

- [ ] **13.4 Run test — verify PASS**
  - Run: `node --test tests/phaseE-toolsets.test.mjs`
  - Expected: `# pass 5`

- [ ] **13.5 Commit**
  - Run: `git add mas/toolsets.mjs tests/phaseE-toolsets.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(toolsets): named tool bundles with add/list/remove

    Six built-in toolsets (coding-min, web-research, devops, learning,
    media, agentic) plus user-defined sets persisted to
    <configDir>/toolsets.json. resolveToolset returns a flat allowlist
    for `agent edit --toolset`.
    EOF
    )"
    ```

---

## Task 14 — MCP client (spawn + register external tools)

Estimated: 90 min. Spec §7 sub-bullet 15. The largest single task in the phase.

- [ ] **14.1 Add MCP SDK dep**

  Edit `/Users/o/lazyclaw/package.json` `dependencies` block (added in Task 5):

  ```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.18.0",
    "undici": "^6.21.0"
  },
  ```

  - Run: `npm install`
  - Expected: `added 1 package`. (If install fails because the SDK version is wrong, drop the caret and retry with `npm view @modelcontextprotocol/sdk version` to pick the latest.)

- [ ] **14.2 Write failing test** — Create `/Users/o/lazyclaw/tests/phaseE-mcp-client.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as mcp from '../mcp/client.mjs';
  import * as registry from '../mas/tools/registry.mjs';

  test('exports startServer / stopServer / listServers', () => {
    assert.equal(typeof mcp.startServer, 'function');
    assert.equal(typeof mcp.stopServer, 'function');
    assert.equal(typeof mcp.listServers, 'function');
  });

  test('startServer registers a prefixed tool via injected transport', async () => {
    const fakeTools = [
      { name: 'read_file',  description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'write_file', description: 'Write', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    ];
    mcp.__setTransport({
      connect: async () => ({
        listTools: async () => ({ tools: fakeTools }),
        callTool: async ({ name, arguments: args }) => ({ content: [{ type: 'text', text: `${name}(${JSON.stringify(args)})` }] }),
        close: async () => {},
      }),
    });

    await mcp.startServer({ name: 'fs', command: 'fake', args: [], allowGlob: '*' });

    const all = registry.listNames();
    assert.ok(all.includes('mcp:fs:read_file'));
    assert.ok(all.includes('mcp:fs:write_file'));

    const t = registry.lookup('mcp:fs:read_file');
    assert.equal(t.sensitive, true);                  // MCP tools default sensitive
    assert.equal(t.category, 'mcp:fs');

    const r = await t.exec({ path: 'x' });
    assert.equal(r.ok, true);
    assert.match(r.text, /read_file/);

    await mcp.stopServer('fs');
    assert.ok(!registry.listNames().includes('mcp:fs:read_file'));
    mcp.__setTransport(null);
  });

  test('allowGlob filters which tools register', async () => {
    mcp.__setTransport({
      connect: async () => ({
        listTools: async () => ({ tools: [{ name: 'read_file' }, { name: 'shell_exec' }] }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      }),
    });
    await mcp.startServer({ name: 'safe', command: 'x', allowGlob: 'read_*' });
    const names = registry.listNames();
    assert.ok(names.includes('mcp:safe:read_file'));
    assert.ok(!names.includes('mcp:safe:shell_exec'));
    await mcp.stopServer('safe');
    mcp.__setTransport(null);
  });
  ```

- [ ] **14.3 Run test — verify FAIL**
  - Run: `node --test tests/phaseE-mcp-client.test.mjs`
  - Expected: `Cannot find module '../mcp/client.mjs'`

- [ ] **14.4 Implement MCP client**

  Create `/Users/o/lazyclaw/mcp/` directory and `/Users/o/lazyclaw/mcp/client.mjs`:

  ```js
  // MCP client — spawn external MCP servers over stdio, list their tools,
  // and register each one in mas/tools/registry.mjs with a stable prefix
  // ("mcp:<server>:<tool>"). Defaults: sensitive=true (so the approve hook
  // gates every external call), category="mcp:<server>". Per-server
  // allowGlob narrows which tools are exposed.
  //
  // The real transport uses @modelcontextprotocol/sdk's StdioClientTransport;
  // tests inject a fake transport via __setTransport so the spec can run
  // without the binary.

  import * as registry from '../mas/tools/registry.mjs';

  let _transport = null;
  export function __setTransport(t) { _transport = t; }

  const SERVERS = new Map();  // name -> { client, tools }

  function matchGlob(name, glob) {
    if (!glob || glob === '*') return true;
    const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(name);
  }

  async function realTransport({ command, args, env }) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command, args: args || [], env });
    const client = new Client({ name: 'lazyclaw', version: '5.0.0' }, { capabilities: {} });
    await client.connect(transport);
    return {
      listTools: () => client.listTools(),
      callTool: (req) => client.callTool(req),
      close:    () => client.close(),
    };
  }

  export async function startServer({ name, command, args = [], env = {}, allowGlob = '*', sensitive = true } = {}) {
    if (!name || !command) throw new Error('startServer: name + command required');
    if (SERVERS.has(name)) throw new Error(`startServer: server "${name}" already running`);

    const transport = _transport || { connect: realTransport };
    const client = await transport.connect({ command, args, env });
    const { tools = [] } = await client.listTools();

    const registered = [];
    for (const t of tools) {
      if (!matchGlob(t.name, allowGlob)) continue;
      const toolName = `mcp:${name}:${t.name}`;
      const rec = {
        name: toolName,
        category: `mcp:${name}`,
        sensitive,
        description: t.description || `MCP tool ${t.name} on server ${name}`,
        parameters: t.inputSchema || { type: 'object', properties: {} },
        async exec(callArgs) {
          try {
            const res = await client.callTool({ name: t.name, arguments: callArgs || {} });
            const text = (res?.content || [])
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
            return { ok: true, text, raw: res };
          } catch (e) {
            return { ok: false, error: `${toolName}: ${e.message}` };
          }
        },
      };
      registry.register(rec);
      registered.push(toolName);
    }

    SERVERS.set(name, { client, tools: registered });
    return { ok: true, name, tools: registered };
  }

  export async function stopServer(name) {
    const entry = SERVERS.get(name);
    if (!entry) return { ok: false, error: `stopServer: ${name} not running` };
    for (const toolName of entry.tools) registry.unregister(toolName);
    try { await entry.client.close(); } catch { /* best-effort */ }
    SERVERS.delete(name);
    return { ok: true, name };
  }

  export function listServers() {
    return [...SERVERS.entries()].map(([name, e]) => ({ name, toolCount: e.tools.length }));
  }
  ```

  Create `/Users/o/lazyclaw/mcp/server_spawn.mjs`:

  ```js
  // server_spawn — drive startServer from cfg.mcp.servers[] at daemon boot.
  //
  // cfg.mcp.servers = [
  //   { name: 'fs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  //     allowGlob: 'read_*' },
  //   { name: 'git', command: 'mcp-git', args: [] },
  // ]

  import { startServer, stopServer, listServers } from './client.mjs';

  export async function startConfigured(cfg) {
    const servers = cfg?.mcp?.servers || [];
    const results = [];
    for (const s of servers) {
      try { results.push(await startServer(s)); }
      catch (e) { results.push({ ok: false, name: s.name, error: e.message }); }
    }
    return results;
  }

  export async function stopAll() {
    for (const { name } of listServers()) {
      try { await stopServer(name); } catch { /* best-effort */ }
    }
  }
  ```

- [ ] **14.5 Run test — verify PASS**
  - Run: `node --test tests/phaseE-mcp-client.test.mjs`
  - Expected: `# pass 3`

- [ ] **14.6 Commit**
  - Run: `git add mcp/client.mjs mcp/server_spawn.mjs tests/phaseE-mcp-client.test.mjs package.json package-lock.json`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    feat(mcp): stdio client + server_spawn driver

    mcp/client.mjs spawns @modelcontextprotocol/sdk stdio servers,
    lists their tools, and registers each as mcp:<server>:<tool> with
    sensitive=true by default and a per-server allowGlob filter.
    mcp/server_spawn.mjs starts every cfg.mcp.servers[] entry at boot.
    Acceptance criterion "MCP filesystem server spawn + register" met.
    EOF
    )"
    ```

---

## Task 15 — Acceptance sweep + count verification

Estimated: 35 min. Phase acceptance: "45+ tools in registry; MCP filesystem server spawn + register; toolset assign; sensitive tools approve-gated."

- [ ] **15.1 Write the acceptance test** — Create `/Users/o/lazyclaw/tests/phaseE-acceptance.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import * as registry from '../mas/tools/registry.mjs';
  import { runTool } from '../mas/tool_runner.mjs';
  import * as toolsets from '../mas/toolsets.mjs';
  import * as mcp from '../mcp/client.mjs';

  test('45+ tools registered (built-in)', () => {
    const builtin = registry.listAll().filter(t => !t.name.startsWith('mcp:'));
    assert.ok(builtin.length >= 45, `expected >= 45 built-in tools, got ${builtin.length}: ${builtin.map(t=>t.name).join(', ')}`);
  });

  test('all required v5 names present', () => {
    const names = new Set(registry.listNames());
    const required = [
      // bash group
      'bash','read','write','edit','patch','grep',
      // recall + learning
      'recall','skill_view','skill_create','skill_edit','memory_write','memory_read','user_view','user_update',
      // web
      'web_fetch','web_search','url_extract',
      // os
      'clipboard_read','clipboard_write','screenshot','notify','open_url','file_dialog',
      // coding
      'python_exec','node_exec','sql_query','http_request','regex_match',
      // git
      'git_status','git_diff','git_log','git_blame','git_branch','git_commit','git_push',
      // scheduling
      'cron_add','cron_remove','cron_list',
      // delegation + clarify
      'task_spawn','delegate','clarify',
      // media + ha
      'image_describe','image_generate','tts_speak','transcribe','ha_call_service','ha_get_state',
      // browser
      'browser_navigate','browser_click','browser_back','browser_screenshot',
    ];
    for (const n of required) assert.ok(names.has(n), `missing tool: ${n}`);
  });

  test('every sensitive tool is approve-gated by tool_runner', async () => {
    const agent = { name: 'tester', tools: ['bash', 'edit', 'web_fetch', 'git_commit'] };
    const calls = [];
    const approve = async (info) => { calls.push(info); return { approved: false, reason: 'test denial' }; };
    for (const tool of agent.tools) {
      const r = await runTool({ agent, tool, args: { command: 'echo', path: 'x', url: 'https://example.com', message: 'm' }, approve });
      assert.equal(r.ok, false, `${tool} should be denied`);
      assert.match(r.error, /denied/i);
    }
    assert.equal(calls.length, 4);
  });

  test('toolset assignment yields valid agent.tools', () => {
    const tools = toolsets.resolveToolset('coding-min');
    for (const t of tools) assert.ok(registry.lookup(t), `coding-min toolset names unknown tool: ${t}`);
  });

  test('MCP server spawn + register round-trip', async () => {
    mcp.__setTransport({
      connect: async () => ({
        listTools: async () => ({ tools: [{ name: 'fs_read', inputSchema: { type: 'object' } }] }),
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        close: async () => {},
      }),
    });
    await mcp.startServer({ name: 'acceptance-fs', command: 'fake' });
    assert.ok(registry.lookup('mcp:acceptance-fs:fs_read'));
    await mcp.stopServer('acceptance-fs');
    mcp.__setTransport(null);
  });
  ```

- [ ] **15.2 Run acceptance test**
  - Run: `node --test tests/phaseE-acceptance.test.mjs`
  - Expected: `# pass 5`. If the 45-tool count fails, the failure message lists every registered tool; re-check Task 1-12 registration imports in `mas/tools/registry.mjs`.

- [ ] **15.3 Re-run the entire Phase E test suite**

  Run all phase E tests in one command:

  ```bash
  node --test \
    tests/phaseE-registry.test.mjs \
    tests/phaseE-tools-edit-patch.test.mjs \
    tests/phaseE-tools-recall.test.mjs \
    tests/phaseE-tools-learning.test.mjs \
    tests/phaseE-tools-web.test.mjs \
    tests/phaseE-tools-os.test.mjs \
    tests/phaseE-tools-coding.test.mjs \
    tests/phaseE-tools-git.test.mjs \
    tests/phaseE-tools-scheduling.test.mjs \
    tests/phaseE-tools-delegation.test.mjs \
    tests/phaseE-tools-media.test.mjs \
    tests/phaseE-tools-ha.test.mjs \
    tests/phaseE-tools-clarify.test.mjs \
    tests/phaseE-tools-browser.test.mjs \
    tests/phaseE-toolsets.test.mjs \
    tests/phaseE-mcp-client.test.mjs \
    tests/phaseE-acceptance.test.mjs
  ```
  - Expected: `# pass 65` (sum of all task pass counts) and `# fail 0`.

- [ ] **15.4 Smoke-check no Phase 12 regression**

  The legacy playwright suite (`tests/phase12a-tools.spec.ts` and friends) imports `mas/tool_runner.mjs`. Confirm the rewrite did not break the surface:

  - Run: `grep -n 'listToolSchemas\|runTool\|isImplemented\|knownTool' tests/phase12a-tools.spec.ts | head -20`
  - Expected: lines mentioning the same exports we kept in Task 1.5. (Full playwright run is out of scope here — it is a Phase F integration step.)

- [ ] **15.5 Commit**
  - Run: `git add tests/phaseE-acceptance.test.mjs`
  - Run:
    ```bash
    git commit -m "$(cat <<'EOF'
    test(phase-e): acceptance sweep — 45+ tools, MCP spawn, approve gate

    Asserts every name listed in spec §7 sub-bullets 1-13 is registered,
    the tool_runner approve hook denies any sensitive tool when the
    operator says no, all built-in toolsets resolve to known tools, and
    the MCP client round-trips a spawn + register + stop cycle through
    the injected transport.
    EOF
    )"
    ```

---

## Phase E completion checklist

- [ ] `mas/tools/registry.mjs` exports register / lookup / listAll / listNames / byCategory.
- [ ] 14 tool group files under `mas/tools/` deliver every spec §7 sub-bullet (1-13) name.
- [ ] `mas/tool_runner.mjs` reads `sensitive` from the tool record, not a hard-coded set.
- [ ] `mas/toolsets.mjs` exposes addToolset / removeToolset / listToolsets / resolveToolset; 6 built-ins ship.
- [ ] `mcp/client.mjs` + `mcp/server_spawn.mjs` start/stop MCP stdio servers and register prefixed tools (`mcp:<server>:<tool>`, `sensitive=true` default, `allowGlob` filter).
- [ ] Acceptance test confirms registry size >= 45, every required tool name present, every sensitive tool approve-gated, MCP spawn round-trip works.
- [ ] No regression in `mas/tool_runner.mjs` public surface (`listToolSchemas`, `runTool`, `isImplemented`, `knownTool`) — Phase 12 tests still compile.
- [ ] All Phase E commits are atomic and follow Conventional Commits.