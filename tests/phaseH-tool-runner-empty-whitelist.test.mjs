// Group B / M7 — tool_runner.listToolSchemas semantics.
//
// Before: `Array.isArray(names) && names.length ? names : registry.listNames()`
// meant an explicit empty whitelist `[]` got every tool — exactly the
// opposite of what an agent with `tools: []` (deny-all) expects.
//
// After:
//   - undefined   → DEFAULT_TOOLS (the 5 safe defaults a fresh agent gets)
//   - []          → advertise zero tools (matches the deny-check
//                   semantics in runTool)
//   - ['bash',…]  → the explicit list, intersected with the registry

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listToolSchemas } from '../mas/tool_runner.mjs';
import { DEFAULT_TOOLS } from '../agents.mjs';

test('M7 — listToolSchemas(undefined) returns DEFAULT_TOOLS (the safe-default set)', () => {
  const out = listToolSchemas(undefined);
  assert.equal(out.length, DEFAULT_TOOLS.length,
    `expected ${DEFAULT_TOOLS.length} default tools, got ${out.length}`);
  const names = out.map(t => t.name).sort();
  assert.deepEqual(names, [...DEFAULT_TOOLS].sort(),
    `expected ${JSON.stringify(DEFAULT_TOOLS)}, got ${JSON.stringify(names)}`);
});

test('M7 — listToolSchemas([]) returns zero tools (deny-all semantics)', () => {
  const out = listToolSchemas([]);
  assert.deepEqual(out, [],
    `explicit empty whitelist must advertise zero tools, got ${JSON.stringify(out)}`);
});

test('M7 — listToolSchemas(["bash","read"]) returns just those two', () => {
  const out = listToolSchemas(['bash', 'read']);
  assert.equal(out.length, 2, `expected 2 tools, got ${out.length}`);
  const names = out.map(t => t.name).sort();
  assert.deepEqual(names, ['bash', 'read']);
});

test('M7 — unknown tool names in the whitelist are silently dropped (intersect with registry)', () => {
  const out = listToolSchemas(['bash', 'no-such-tool', 'read']);
  const names = out.map(t => t.name).sort();
  assert.deepEqual(names, ['bash', 'read'],
    'unknown tool names should be filtered out, not throw');
});
