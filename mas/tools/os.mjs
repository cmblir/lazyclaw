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
