// tests/f-panel-write-guard.test.mjs — a composer throw must surface as a
// visible failure through the actual panel click path, not just at the
// slash_actions.mjs unit level.
//
// Fix round: a review found that every panel's write handler used to call
// its composer AS THE ARGUMENT EXPRESSION — `runWrite(agentCreate(...))` —
// so a throw (an embedded `"` has no safe encoding on this grammar, see
// arg() in web/ui/slash_actions.mjs) fired before runWrite's own try/catch
// ever ran. No DOM error boundary catches that: it becomes a silently
// swallowed rejection (agents.mjs's openAgentModal is async, so a
// synchronous throw inside it rejects the returned promise; nothing awaits
// or .catch()s a fire-and-forget onclick handler). The fix makes every
// runWrite take a thunk instead, so the throw happens INSIDE the function
// that already has the try/catch. This test exercises that through the
// real button → onclick path, with the smallest possible DOM stub (no
// jsdom in this repo — same approach as tests/f-confirm-dialog.test.mjs's
// fix-round stub).
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };

// Just enough of `document`/Element for dom.mjs's el() and the handful of
// mutator methods agents.mjs actually calls (replaceWith/replaceChildren) —
// no MutationObserver, no modal wiring; this test never reaches
// runSlashConfirmed's default asker because the composer throws first.
class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.style = { cssText: '', setProperty() {} };
    this.parent = null;
  }
  setAttribute() {}
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  append(...kids) {
    for (const k of kids) {
      if (k && typeof k === 'object') k.parent = this;
      this.children.push(k);
    }
  }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  replaceWith(node) {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) { this.parent.children[i] = node; node.parent = this.parent; }
  }
}

function setupDom() {
  globalThis.document = { createElement: (tag) => new FakeNode(tag) };
}

// GET /agents -> [] so load() takes the empty-list branch (no table()
// traversal needed); POST /slash must NEVER be reached by either test case
// below — asserted via `slashCalled`.
function stubFetch() {
  const state = { slashCalled: false };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/slash')) { state.slashCalled = true; return { ok: true, status: 200, json: async () => ({ ok: true, lines: [] }) }; }
    if (u.includes('/agents')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return state;
}

// Finds the toolbar's first button by its label, walking the shallow tree
// render() builds (host -> toolbar div -> buttons).
function findButton(host, label) {
  for (const child of host.children) {
    if (!child || !child.children) continue;
    const btn = child.children.find((c) => c && c.textContent === label);
    if (btn) return btn;
  }
  return null;
}

// Recursively collects every string leaf under a FakeNode tree — banner()'s
// message is a plain-string child of the banner <div>, not that div's own
// .textContent (only el()'s `text` prop sets that), so a shallow scan misses
// it entirely.
function collectStrings(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out; }
  if (node && Array.isArray(node.children)) {
    for (const c of node.children) collectStrings(c, out);
  }
  return out;
}

test('agents.mjs: a role containing a quote refuses at the composer, and the panel shows it — not silence', async () => {
  setupDom();
  const state = stubFetch();
  const { render } = await import('../web/ui/panels/agents.mjs');
  const host = new FakeNode('div');
  await render(host);

  const newAgentBtn = findButton(host, '+ New agent');
  assert.ok(newAgentBtn, 'the + New agent button must exist');

  let promptCalls = 0;
  globalThis.prompt = (msg) => {
    promptCalls += 1;
    if (/Agent name/.test(msg)) return 'dev';
    if (/Provider/.test(msg)) return '';
    if (/Model id/.test(msg)) return '';
    if (/Role/.test(msg)) return 'say "hi" now'; // the unrepresentable value
    return '';
  };

  // Call the onclick handler directly (not .click()) so we get the actual
  // promise openAgentModal() returns, instead of a fire-and-forget click
  // whose rejection we could never observe — exactly the shape a real
  // onclick= in the browser has.
  const onclick = newAgentBtn.listeners.get('click')[0];
  await assert.doesNotReject(async () => onclick(), 'the panel must swallow the composer throw itself, not let it escape');

  assert.equal(promptCalls, 4, 'all four prompts must have been asked before the composer ran');
  assert.equal(state.slashCalled, false, 'a line that cannot be composed must never reach the dispatcher');

  const texts = collectStrings(host);
  assert.ok(texts.some((t) => t.includes('"')),
    `a banner naming the bad value must be visible somewhere in the panel; saw: ${JSON.stringify(texts)}`);
});

test('teams.mjs: an agent name containing a quote in --agents refuses visibly, not silently', async () => {
  setupDom();
  const state = stubFetch();
  const { render } = await import('../web/ui/panels/teams.mjs');
  const host = new FakeNode('div');
  await render(host);

  const newTeamBtn = findButton(host, '+ New team');
  assert.ok(newTeamBtn);

  // `lead` is deliberately a SEPARATE, safe value ('ok1') from the bad
  // agent name: teamCreate's `lead` param was already arg()-wrapped before
  // this fix round, so if the test let lead carry the bad value too, a
  // throw there would pass even with `agents.join(',')` left completely
  // unguarded — proving nothing about the specific gap this test targets.
  globalThis.prompt = (msg, def) => {
    if (/Team name/.test(msg)) return 'crew';
    if (/Agents \(/.test(msg)) return 'ok1,bad"2'; // second agent is unrepresentable
    if (/Lead/.test(msg)) return 'ok1';
    if (/Slack channel/.test(msg)) return '';
    return def || '';
  };
  // openTeamModal's guard requires at least one registered agent — stub the
  // GET /agents call it makes for the pre-flight check.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/slash')) { state.slashCalled = true; return { ok: true, status: 200, json: async () => ({ ok: true, lines: [] }) }; }
    if (u.includes('/agents')) return { ok: true, status: 200, json: async () => [{ name: 'ok1' }, { name: 'bad"2' }] };
    if (u.includes('/teams')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const onclick = newTeamBtn.listeners.get('click')[0];
  await assert.doesNotReject(async () => onclick(), 'the panel must swallow the composer throw itself, not let it escape');
  assert.equal(state.slashCalled, false,
    'a line built from an unrepresentable --agents entry must never reach the dispatcher (pre-fix: agents.join(\',\') skipped arg() entirely and this silently sent anyway)');

  const texts = collectStrings(host);
  assert.ok(texts.some((t) => t.includes('"')),
    `a banner naming the bad value must be visible somewhere in the panel; saw: ${JSON.stringify(texts)}`);
});
