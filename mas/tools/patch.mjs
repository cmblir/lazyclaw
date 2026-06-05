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
