// tests/f-shell-cleanup-resolve.test.mjs — shell.mjs's activate() stores a
// panel's render(host) return value as the cleanup to run on the NEXT
// navigation. Task 4 told panels render() "may be async" and must "return
// cleanup synchronously" — those cannot both hold: an async function always
// wraps its return in a Promise, so `panel.render(host) || null` (activate()
// does not await the call) stored the pending Promise itself, never the
// resolved cleanup. Every panel whose render() is `async function` and
// returns a real cleanup (rates.mjs, workflows.mjs clearing a debounce
// timer; team.mjs before this fix) leaked on navigation: the "cleanup" was a
// Promise, calling it threw, and activate()'s own try/catch swallowed that
// silently.
//
// resolveCleanup is the pure piece of that fix, extracted so this contract
// has a test that doesn't need to stub the whole DOM shell to exercise it —
// mount() alone reaches for a dozen getElementById results. shell.mjs still
// transitively imports motion.mjs, which reads matchMedia at module load
// time (not just inside a function), so that one global needs a stub before
// the first import — same no-jsdom stubbing style as f-dashboard-dom.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false }));
const { resolveCleanup } = await import('../web/ui/shell.mjs');

test('a sync render returning a function delivers that function immediately', () => {
  const cleanup = () => {};
  let delivered;
  resolveCleanup(cleanup, (fn) => { delivered = fn; });
  assert.equal(delivered, cleanup, 'must deliver synchronously, before resolveCleanup returns');
});

test('a sync render returning nothing delivers null, not undefined or a Promise', () => {
  let delivered = 'unset';
  resolveCleanup(undefined, (fn) => { delivered = fn; });
  assert.equal(delivered, null);
});

test('an async render whose Promise resolves to a function delivers it once settled — the actual bug', async () => {
  const cleanup = () => {};
  const renderResult = Promise.resolve(cleanup);
  let delivered = 'unset';
  resolveCleanup(renderResult, (fn) => { delivered = fn; });
  // Nothing yet — a real Promise cannot resolve synchronously. This is
  // exactly the shape `panel.render(host) || null` got wrong: it read the
  // still-pending Promise as truthy and stored THAT as the cleanup.
  assert.equal(delivered, 'unset', 'must not deliver before the Promise settles');
  await renderResult;
  await Promise.resolve(); // let the .then queued inside resolveCleanup run
  assert.equal(delivered, cleanup, 'the resolved cleanup function must reach onCleanup, not the Promise itself');
});

test('an async render resolving to a non-function value delivers null, not the bogus value', async () => {
  let delivered = 'unset';
  resolveCleanup(Promise.resolve({ not: 'a function' }), (fn) => { delivered = fn; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(delivered, null);
});

test('an async render whose Promise rejects delivers null and does not throw', async () => {
  let delivered = 'unset';
  assert.doesNotThrow(() => {
    resolveCleanup(Promise.reject(new Error('render blew up')), (fn) => { delivered = fn; });
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(delivered, null, 'a rejected render must not crash the shell nor deliver a broken cleanup');
});
