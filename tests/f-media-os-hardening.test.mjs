// tests/f-media-os-hardening.test.mjs
//   image_describe base64-read ANY model-supplied host path (no traversal
//   guard) and uploaded it to OpenAI, and its description claimed a
//   non-existent ANTHROPIC vision path. file_dialog interpolated args.prompt
//   into an AppleScript string escaping only double-quotes, so a backslash or
//   newline could break out of the literal (AppleScript injection).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS as mediaTools } from '../mas/tools/media.mjs';
import { _buildChooseScript } from '../mas/tools/os.mjs';

const image_describe = mediaTools.find((t) => t.name === 'image_describe');

test('image_describe rejects a path that escapes the working directory', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-media-'));
  const r = await image_describe.exec({ path: '/etc/passwd' }, { cwd, env: { OPENAI_API_KEY: 'sk-x' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /escape|outside|working director/i, 'must refuse to exfiltrate a file outside cwd');
});

test('image_describe description does not claim a non-existent ANTHROPIC vision path', () => {
  assert.doesNotMatch(image_describe.description, /ANTHROPIC/i, 'only the OpenAI vision path exists in code');
});

test('_buildChooseScript escapes backslashes, quotes, and strips newlines (no AppleScript injection)', () => {
  const evil = 'x" & (do shell script "id") & "\n\\rm -rf';
  const script = _buildChooseScript('open', evil);
  // The raw injection payload must not appear unescaped.
  assert.ok(!script.includes('do shell script "id"'), 'must not pass an unescaped quote that opens a new AppleScript expression');
  assert.ok(!/[\r\n]/.test(script), 'no raw newlines may reach the AppleScript');
  // A literal backslash in the prompt is escaped (doubled) inside the string.
  assert.ok(script.includes('\\\\'), 'backslash must be escaped');
});
