// tests/f-prompt-stack-recall.test.mjs — the durable FTS recall index only
// fired if the model chose the recall TOOL; composePromptStack (built every
// chat/agent turn) never called index_db.recall, so the confidence/freshness
// machinery was decorative. Auto-inject the top-k relevant prior
// sessions/trajectories/memories for the CURRENT user message — opt-in via a
// `query`, so existing (query-less) callers stay byte-stable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composePromptStack } from '../mas/prompt_stack.mjs';
import * as idx from '../mas/index_db.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lc-pstack-'));

test('composePromptStack injects a recalled-context layer for a matching query', () => {
  const dir = tmp();
  idx.indexMemory({ topic: 'deploy-notes', kind: 'episodic', content: 'the zephyrgate service uses a blue-green deploy' }, dir);
  const out = composePromptStack({ cfgDir: dir, query: 'zephyrgate' });
  assert.match(out, /recalled context/i, 'a recall layer must appear');
  assert.match(out, /zephyrgate/, 'the matching prior content is surfaced');
});

test('composePromptStack with NO query is byte-stable (no recall layer, no index hit surfaced)', () => {
  const dir = tmp();
  idx.indexMemory({ topic: 'x', kind: 'episodic', content: 'zephyrgate notes' }, dir);
  const out = composePromptStack({ cfgDir: dir });
  assert.doesNotMatch(out, /recalled context/i, 'no recall layer without a query');
  assert.doesNotMatch(out, /zephyrgate/, 'no recalled content leaks in');
});

test('composePromptStack with a query but no matches adds no recall layer', () => {
  const dir = tmp();
  idx.indexMemory({ topic: 'y', kind: 'episodic', content: 'unrelated content' }, dir);
  const out = composePromptStack({ cfgDir: dir, query: 'nonexistentterm12345' });
  assert.doesNotMatch(out, /recalled context/i);
});

test('composePromptStack recall is best-effort — a fresh dir with no index never throws', () => {
  const dir = tmp();
  assert.doesNotThrow(() => composePromptStack({ cfgDir: dir, query: 'anything' }));
});
