// tests/v542-editor-stale-closure.test.mjs — v5.4.2 CJK char-drop regression.
//
// Background. macOS IME (Korean / Japanese / Chinese) commits each
// completed syllable as a separate stdin event. Pre-v5.4.2, <Editor/>'s
// useInput callback read state via the React closure captured at render
// time. Two events arriving in the same React frame caused the second
// applyKey call to start from the pre-first-event state and overwrite
// the first event's setState payload — so the first character vanished
// from `buffer`. The fix is a synchronous stateRef + commit() wrapper
// so back-to-back keystrokes always see the most recent buffer.
//
// We can't mount Ink here (no TTY in node:test), so we pin the contract
// via two complementary checks:
//   1. Source-level: <Editor/> must define a stateRef synced to state
//      AND read from stateRef.current inside the useInput callback.
//      Without this, the stale-closure bug returns silently.
//   2. Reducer-level: applyKey itself is pure and chains correctly
//      across rapid Hangul inserts — verifies that, given the right
//      "current" state, the resulting buffer contains every char.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { makeEditorState, applyKey } from '../tui/editor.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));

test('Editor uses a synchronous stateRef + commit() to avoid stale-closure char drops', () => {
  const src = fs.readFileSync(path.join(here, '..', 'tui', 'editor.mjs'), 'utf8');
  // Must import useRef from React.
  assert.ok(/import\s+React\s*,\s*\{[^}]*useRef[^}]*\}\s+from\s+'react'/.test(src),
    'Editor must import useRef from react');
  // Must declare a stateRef whose current is kept in sync with state.
  assert.ok(/const\s+stateRef\s*=\s*useRef\(\s*state\s*\)/.test(src),
    'Editor must declare stateRef = useRef(state)');
  assert.ok(/stateRef\.current\s*=\s*state/.test(src),
    'Editor must keep stateRef.current in sync with state (inside useEffect)');
  // useInput callback must read from stateRef.current, NOT directly from `state`.
  // We approximate by checking that the callback body references stateRef.current.
  const useInputBody = src.match(/useInput\(\(input,\s*key\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert.ok(useInputBody, 'Editor must contain a useInput((input, key) => { ... }) call');
  assert.ok(useInputBody[1].includes('stateRef.current'),
    'useInput callback must read state via stateRef.current');
});

test('applyKey chains correctly across rapid Hangul commits (no chars lost)', () => {
  // Each item is one IME commit. After all commits, buffer must equal the
  // concatenation. This is the contract the stateRef wrapper preserves
  // when events fire faster than React can re-render.
  const commits = ['한', '국', '어', ' ', '입', '력', '테', '스', '트'];
  let s = makeEditorState();
  for (const input of commits) {
    s = applyKey(s, { input, key: {} });
  }
  assert.equal(s.buffer, commits.join(''),
    `expected '${commits.join('')}', got '${s.buffer}'`);
  assert.equal(s.cursor, s.buffer.length,
    'cursor must rest at end of buffer after sequential inserts');
});

test('applyKey chains correctly across rapid mixed ASCII + CJK + emoji', () => {
  // Mixed-script worst case: BMP Hangul + BMP Han + supplementary emoji.
  // Reducer must remain pure across the chain.
  const commits = ['h', 'i', ' ', '안', '녕', ' ', '世', '界', ' ', '🐢'];
  let s = makeEditorState();
  for (const input of commits) {
    s = applyKey(s, { input, key: {} });
  }
  assert.equal(s.buffer, 'hi 안녕 世界 🐢');
});
