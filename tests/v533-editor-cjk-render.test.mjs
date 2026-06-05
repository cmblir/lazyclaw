// v5.3.3 — full ink-render visual test of editor CJK wrapping.
// Earlier v5.3.2 tests only exercised displayWidth/applyKey helpers;
// they passed while real Ink output overflowed the box right edge.
// This test mounts <Editor/> via ink-testing-library, pastes a long
// Hangul buffer, and asserts every rendered line fits the terminal.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import stringWidth from 'string-width';

// ink-testing-library is a dev dep; skip the suite gracefully if absent.
let render;
try {
  ({ render } = await import('ink-testing-library'));
} catch {
  test.skip('v5.3.3 CJK render — ink-testing-library not installed', () => {});
}

if (render) {
  const { Editor } = await import('../tui/editor.mjs');
  const LONG_KO = '한국어로 매우 긴 문장을 입력하면 박스 칸을 벗어나는지 확인합니다 그리고 더 길게 만들어야지 안그러면 안 보일거야';

  for (const TERM of [60, 80, 100, 120, 140]) {
    test(`v5.3.3 — long Hangul wraps inside box at TERM=${TERM}`, async () => {
      process.stdout.columns = TERM;
      const { lastFrame, stdin } = render(
        React.createElement(Editor, { onSubmit: () => {}, onEscape: () => {} })
      );
      await new Promise(r => setTimeout(r, 30));
      stdin.write(LONG_KO);
      await new Promise(r => setTimeout(r, 120));
      const frame = lastFrame();
      for (const [i, line] of frame.split('\n').entries()) {
        const w = stringWidth(line);
        assert.ok(w <= TERM,
          `TERM=${TERM} line ${i} width=${w} overflows: ${JSON.stringify(line)}`);
      }
      // The box top and bottom borders must be present (the whole
      // editor must not have collapsed or torn open).
      assert.ok(frame.includes('╭'), `TERM=${TERM} missing top border`);
      assert.ok(frame.includes('╰'), `TERM=${TERM} missing bottom border`);
    });
  }
}
