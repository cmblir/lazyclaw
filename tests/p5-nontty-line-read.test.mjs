// tests/p5-nontty-line-read.test.mjs — the non-TTY picker fallbacks must read
// exactly ONE line from a piped stream and hand the remainder back, so a
// scripted/piped `pompos setup` can drive several prompts in sequence. The
// old code resolved the whole multiline buffer (matched no id → skipped the
// channel) and dropped the rest (the next prompt then hung).

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { _readOneLine } from '../tui/pickers.mjs';

test('_readOneLine reads one line and leaves the remainder for the next read', async () => {
  const s = new PassThrough();
  s.write('telegram\n111:aaa\n__done__\n');
  assert.equal(await _readOneLine(s), 'telegram');
  assert.equal(await _readOneLine(s), '111:aaa');
  assert.equal(await _readOneLine(s), '__done__');
});

test('_readOneLine trims surrounding whitespace and a trailing CR', async () => {
  const s = new PassThrough();
  s.write('  slack  \r\nnext\n');
  assert.equal(await _readOneLine(s), 'slack');
  assert.equal(await _readOneLine(s), 'next');
});

test('_readOneLine resolves the final buffered token when the stream ends without a newline', async () => {
  const s = new PassThrough();
  s.end('matrix');
  assert.equal(await _readOneLine(s), 'matrix');
});
