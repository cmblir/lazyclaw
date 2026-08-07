// terminal_approve.mjs — default human-in-the-loop approval hook for the
// bare (non-Ink) CLI path, e.g. `pompos task tick` on a TTY.
//
// The tool runner is fail-closed: a sensitive tool (bash / write / web /
// browser / delegate) runs only behind an approve({tool,args,agent}) →
// {approved,reason} hook, or an explicit security.allowUnattendedSensitive
// opt-in. This module supplies the default hook: a y/N prompt on the
// controlling terminal. Default (bare Enter), timeout, EOF, and a
// non-TTY stdin ALL deny — approval is never granted by omission.

import readline from 'node:readline';
import { redactSecrets } from '../mas/redact.mjs';

export function makeReadlineApprove({ input = process.stdin, output = process.stderr, timeoutMs = 120_000 } = {}) {
  return async function approve({ tool, args, agent }) {
    if (!input.isTTY) return { approved: false, reason: 'no TTY for approval (fail-closed)' };
    const raw = typeof args === 'object' ? JSON.stringify(args) : String(args ?? '');
    const summary = redactSecrets(raw).slice(0, 400);
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        const timer = setTimeout(() => finish(''), timeoutMs);
        rl.on('close', () => { clearTimeout(timer); finish(''); });
        rl.question(`\n⚠ agent "${agent}" wants to run sensitive tool "${tool}": ${summary}\n  approve? [y/N] `, (a) => {
          clearTimeout(timer);
          finish(a);
        });
      });
      const approved = /^\s*y(es)?\s*$/i.test(answer);
      return { approved, reason: approved ? 'approved at terminal' : 'denied at terminal (default)' };
    } finally {
      rl.close();
    }
  };
}
