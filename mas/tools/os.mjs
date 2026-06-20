// os — clipboard, screenshot, notify, open_url, file_dialog. macOS and
// linux paths implemented; everything else returns "unsupported".
// ctx.platform overrideable for tests.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSandboxed, spawnSyncSandboxed } from '../../sandbox.mjs';

function platformOf(ctx) { return ctx?.platform || process.platform; }

// Strip the sandbox-control keys (and our async-only `stdin` helper) from the
// options bag before forwarding to the (sandboxed) spawner, so only real
// child_process options reach it. The bare path keeps the historical `opts`
// object verbatim for byte-stability.
function spawnOptsOf(opts) {
  const { sandbox, _spawnSandboxed, _spawnSyncSandboxed, stdin, ...rest } = opts;
  return rest;
}

// CAPABILITY-ONLY sandbox seam (default-on isolation, step iv-b). When
// opts.sandbox is truthy the child is created through the sandbox dispatcher
// (containment ADDED); a null/absent spec keeps the byte-identical bare spawn
// path. _spawnSandboxed is a test injection seam — defaults to the real impl.
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = opts.sandbox
      ? (opts._spawnSandboxed || spawnSandboxed)(opts.sandbox, cmd, args, spawnOptsOf(opts))
      : spawn(cmd, args, opts);
    let out = '', err = '';
    child.stdout?.on('data', d => out += d.toString());
    child.stderr?.on('data', d => err += d.toString());
    child.on('error', e => resolve({ ok: false, error: e.message }));
    child.on('close', code => resolve({ ok: code === 0, stdout: out, stderr: err, exitCode: code }));
    if (opts.stdin) { child.stdin.write(opts.stdin); child.stdin.end(); }
  });
}

// Synchronous mirror of runCmd. When opts.sandbox is truthy the invocation is
// routed through spawnSyncSandboxed (injectable via opts._spawnSyncSandboxed);
// otherwise the bare spawnSync path is byte-identical to the historical call.
function runCmdSync(cmd, args, opts = {}) {
  return opts.sandbox
    ? (opts._spawnSyncSandboxed || spawnSyncSandboxed)(opts.sandbox, cmd, args, spawnOptsOf(opts))
    : spawnSync(cmd, args, spawnOptsOf(opts));
}

// Pull the sandbox seam out of ctx so each tool can thread it uniformly.
function sandboxSeam(ctx) {
  return {
    sandbox: ctx?.sandbox,
    _spawnSandboxed: ctx?._spawnSandboxed,
    _spawnSyncSandboxed: ctx?._spawnSyncSandboxed,
  };
}

const clipboard_read = {
  name: 'clipboard_read', category: 'os', sensitive: true,
  description: 'Read the OS clipboard (text).',
  parameters: { type: 'object', properties: {} },
  async exec(_args, ctx) {
    const p = platformOf(ctx);
    const seam = sandboxSeam(ctx);
    if (p === 'darwin') {
      const r = runCmdSync('pbpaste', [], { encoding: 'utf8', ...seam });
      return r.status === 0 ? { ok: true, text: r.stdout } : { ok: false, error: r.stderr || 'pbpaste failed' };
    }
    if (p === 'linux') {
      for (const [bin, args] of [['wl-paste', []], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]]) {
        const r = runCmdSync(bin, args, { encoding: 'utf8', ...seam });
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
    const seam = sandboxSeam(ctx);
    if (p === 'darwin') return runCmd('pbcopy', [], { stdin: args.text, ...seam });
    if (p === 'linux') {
      for (const [bin, ar] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]) {
        const r = await runCmd(bin, ar, { stdin: args.text, ...seam });
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
    const seam = sandboxSeam(ctx);
    if (p === 'darwin') {
      const r = runCmdSync('screencapture', ['-x', out], { ...seam });
      return r.status === 0 ? { ok: true, path: out } : { ok: false, error: 'screencapture failed' };
    }
    if (p === 'linux') {
      for (const [bin, ar] of [['grim', [out]], ['gnome-screenshot', ['-f', out]], ['scrot', [out]]]) {
        const r = runCmdSync(bin, ar, { ...seam });
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
    const seam = sandboxSeam(ctx);
    const title = args.title;
    const body = args.body || '';
    if (p === 'darwin') {
      runCmdSync('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], { ...seam });
      return { ok: true };
    }
    if (p === 'linux') {
      runCmdSync('notify-send', [title, body], { ...seam });
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
    const seam = sandboxSeam(ctx);
    if (p === 'darwin') return runCmd('open', [args.url], { ...seam });
    if (p === 'linux') return runCmd('xdg-open', [args.url], { ...seam });
    return { ok: false, error: `open_url: unsupported platform ${p}` };
  },
};

// Build the osascript `choose file` expression. The prompt is model-supplied
// and gets interpolated into an AppleScript STRING literal, so it must escape
// backslashes (first) and double-quotes, and strip newlines/control chars — a
// raw `"`/`\`/newline would otherwise break out of the literal and run an
// injected AppleScript expression (e.g. `do shell script`). Exported for tests.
export function _buildChooseScript(kind, prompt) {
  const fallback = kind === 'save' ? 'Save' : 'Choose';
  const safe = String(prompt || fallback)
    .replace(/[\r\n\t\v\f\0]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return kind === 'save'
    ? `POSIX path of (choose file name with prompt "${safe}")`
    : `POSIX path of (choose file with prompt "${safe}")`;
}

const file_dialog = {
  name: 'file_dialog', category: 'os', sensitive: true,
  description: 'Show an OS file picker. Returns selected path (or null on cancel).',
  parameters: {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['open', 'save'] }, prompt: { type: 'string' } },
  },
  async exec(args, ctx) {
    const p = platformOf(ctx);
    const seam = sandboxSeam(ctx);
    if (p === 'darwin') {
      const script = _buildChooseScript(args.kind, args.prompt);
      const r = runCmdSync('osascript', ['-e', script], { encoding: 'utf8', ...seam });
      if (r.status !== 0) return { ok: true, path: null };
      return { ok: true, path: r.stdout.trim() };
    }
    if (p === 'linux') {
      const ar = args.kind === 'save' ? ['--file-selection', '--save'] : ['--file-selection'];
      const r = runCmdSync('zenity', ar, { encoding: 'utf8', ...seam });
      if (r.status !== 0) return { ok: true, path: null };
      return { ok: true, path: r.stdout.trim() };
    }
    return { ok: false, error: `file_dialog: unsupported platform ${p}` };
  },
};

export const TOOLS = [clipboard_read, clipboard_write, screenshot, notify, open_url, file_dialog];
