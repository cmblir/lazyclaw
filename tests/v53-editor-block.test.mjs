// tests/v53-editor-block.test.mjs — v5.5 chat-input visual block.
//
// The <Editor/> renders inside a round-bordered Box so the input area is
// visually distinct from the scrolling history above (Claude-CLI /
// Hermes-style frame). This test mounts the editor through Ink with a
// fake stdin/stdout and asserts the rendered output contains the
// box-drawing characters from `borderStyle: 'round'` around the prompt
// row.
//
// Why a real Ink render instead of element-tree introspection:
//   - the box characters only appear after Yoga lays out the bordered Box
//     and Ink's renderer paints them; the React element only carries
//     `borderStyle: 'round'`, not the glyphs themselves.
//   - we also want a non-zero usable interior width so we know the box
//     respects the terminal columns minus the 2-char border + padding.
//
// stdin.isTTY is false on the fake stream → Ink's setRawMode is skipped
// (see ink/build/components/App.js:96-99), so useInput inside <Editor/>
// is mounted but never tries to enable raw mode on a non-TTY pipe.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { Editor } from '../tui/editor.mjs';
import { theme } from '../tui/theme.mjs';

// Round border glyphs Ink uses for `borderStyle: 'round'`.
// Source: cli-boxes 'round' preset (top-left ╭, top-right ╮,
// bottom-left ╰, bottom-right ╯, horizontal ─, vertical │).
const ROUND_BORDER_GLYPHS = ['╭', '╮', '╰', '╯', '─', '│'];

function mountEditor({ columns = 80, history = [] } = {}) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = 24;
  // Ink writes ANSI; collect every chunk.
  const chunks = [];
  stdout.on('data', (b) => chunks.push(b.toString('utf8')));

  const stdin = new PassThrough();
  stdin.isTTY = false; // skip setRawMode — see header comment
  // setRawMode is read on prototype; provide a noop so any defensive
  // access path doesn't crash.
  stdin.setRawMode = () => {};

  const stderr = new PassThrough();

  const instance = render(
    React.createElement(Editor, {
      history,
      onSubmit: () => {},
    }),
    { stdout, stdin, stderr, debug: true, exitOnCtrlC: false, patchConsole: false },
  );

  return { instance, chunks, frames: () => chunks.join('') };
}

test('v5.5 — Editor renders inside a round-bordered box (box-drawing chars present)', () => {
  const { instance, frames } = mountEditor({ columns: 80 });
  try {
    // With debug:true Ink writes the full latest frame synchronously
    // on every render, so the first frame is already available.
    const out = frames();
    assert.ok(out.length > 0, 'expected ink to write at least one frame');

    // Every round-border glyph must appear at least once around the editor.
    for (const glyph of ROUND_BORDER_GLYPHS) {
      assert.ok(
        out.includes(glyph),
        `expected rendered editor to contain '${glyph}' (round border), got:\n${out}`,
      );
    }
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test('v5.5 — border surrounds the prompt accent (› appears between vertical bars)', () => {
  const { instance, frames } = mountEditor({ columns: 80 });
  try {
    const out = frames();
    // Find the row that contains the prompt character. It must be sandwiched
    // by vertical bars '│' (left + right border) somewhere on the same line.
    const promptRow = out.split('\n').find((row) => row.includes('›'));
    assert.ok(promptRow, `expected a rendered row containing '›', got:\n${out}`);
    const leftBar = promptRow.indexOf('│');
    const rightBar = promptRow.lastIndexOf('│');
    assert.ok(leftBar !== -1, `expected left vertical bar on prompt row: ${JSON.stringify(promptRow)}`);
    assert.ok(rightBar > leftBar, `expected right vertical bar after left on prompt row: ${JSON.stringify(promptRow)}`);
    // The '›' glyph must sit between them.
    const promptAt = promptRow.indexOf('›');
    assert.ok(
      promptAt > leftBar && promptAt < rightBar,
      `expected '›' between border bars, row: ${JSON.stringify(promptRow)}`,
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});

test('v5.5 — border color token is exported and is a hex string', () => {
  // Pin the token contract so future theme refactors don't silently
  // drop the input frame color.
  assert.equal(typeof theme.border, 'string');
  assert.match(theme.border, /^#[0-9A-Fa-f]{6}$/);
});

test('v5.5 — top and bottom border rows span the terminal width', () => {
  const cols = 60;
  const { instance, frames } = mountEditor({ columns: cols });
  try {
    const out = frames();
    const lines = out.split('\n');
    // Find any line that looks like a top border: starts with ╭ and ends with ╮.
    const topRow = lines.find((l) => {
      // Strip ANSI escape sequences before checking the geometry.
      const plain = l.replace(/\[[0-9;]*m/g, '');
      return plain.includes('╭') && plain.includes('╮');
    });
    const botRow = lines.find((l) => {
      const plain = l.replace(/\[[0-9;]*m/g, '');
      return plain.includes('╰') && plain.includes('╯');
    });
    assert.ok(topRow, `expected a top-border row containing ╭…╮, got:\n${out}`);
    assert.ok(botRow, `expected a bottom-border row containing ╰…╯, got:\n${out}`);

    // The top/bottom rows should have a non-trivial horizontal run of ─
    // (Ink fills the available flex width inside the column).
    const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');
    const horizCount = (s) => (stripAnsi(s).match(/─/g) || []).length;
    assert.ok(
      horizCount(topRow) >= 10,
      `expected top border to contain a wide ─ run, got ${horizCount(topRow)} on row: ${JSON.stringify(stripAnsi(topRow))}`,
    );
    assert.ok(
      horizCount(botRow) >= 10,
      `expected bottom border to contain a wide ─ run, got ${horizCount(botRow)} on row: ${JSON.stringify(stripAnsi(botRow))}`,
    );
  } finally {
    instance.unmount();
    instance.cleanup();
  }
});
