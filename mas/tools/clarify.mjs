// clarify — surface a question to the human user mid-turn. The actual
// prompting mechanism is host-dependent (REPL prompt, Slack DM, gateway
// SSE), so the runtime hooks an asker via __setAsker. Returns the user's
// reply as a plain string. Pattern lifted from Hermes (spec §7 sub-12).

let _asker = null;
export function __setAsker(fn) { _asker = fn; }

export const TOOL = {
  name: 'clarify',
  category: 'agents',
  sensitive: false,
  description: 'Ask the user a clarifying question and wait for the reply.',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } } },
    required: ['question'],
  },
  async exec(args, ctx) {
    if (!args?.question) return { ok: false, error: 'clarify: question required' };
    if (typeof _asker === 'function') {
      try {
        const answer = await _asker({ question: args.question, choices: args.choices });
        return { ok: true, answer };
      } catch (e) { return { ok: false, error: `clarify: ${e.message}` }; }
    }
    if (ctx?.isTTY) {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`[clarify] ${args.question} > `);
      rl.close();
      return { ok: true, answer };
    }
    return { ok: false, error: 'clarify: no asker bound and not running in a TTY' };
  },
};
