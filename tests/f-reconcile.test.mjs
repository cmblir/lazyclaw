// tests/f-reconcile.test.mjs — the reason there is no framework here. Live
// lists must keep their DOM nodes across an update or in-flight animations,
// focus, and measured geometry are lost.
import test from 'node:test';
import assert from 'node:assert/strict';

// A hand-rolled DOM stand-in. The part that matters is insertBefore: real
// insertBefore MOVES a node already in the parent (removing it from its
// current position first) rather than inserting a second copy — without
// that, the reordering test below could pass against a reconcile() that
// silently duplicated nodes instead of moving them.
function stubHost() {
  const host = {
    kids: [],
    append(...xs) { this.kids.push(...xs); },
    removeChild(x) { this.kids.splice(this.kids.indexOf(x), 1); },
    insertBefore(x, ref) {
      const from = this.kids.indexOf(x);
      if (from >= 0) this.kids.splice(from, 1);
      const at = ref ? this.kids.indexOf(ref) : this.kids.length;
      this.kids.splice(at < 0 ? this.kids.length : at, 0, x);
    },
    get children() { return this.kids; },
  };
  return host;
}

test('an unchanged list reuses every node', async () => {
  const { reconcile } = await import('../web/ui/reconcile.mjs');
  const host = stubHost();
  const items = [{ id: 'a' }, { id: 'b' }];
  const create = (it) => ({ tag: 'row', key: it.id });
  const first = reconcile(host, items, (it) => it.id, create, () => {});
  const second = reconcile(host, items, (it) => it.id, create, () => {});
  assert.equal(first.get('a'), second.get('a'), 'node identity must survive an update');
  assert.equal(host.children.length, 2);
});

test('a removed item drops only its own node', async () => {
  const { reconcile } = await import('../web/ui/reconcile.mjs');
  const host = stubHost();
  const create = (it) => ({ tag: 'row', key: it.id });
  const before = reconcile(host, [{ id: 'a' }, { id: 'b' }], (it) => it.id, create, () => {});
  const keptA = before.get('a');
  const after = reconcile(host, [{ id: 'a' }], (it) => it.id, create, () => {});
  assert.equal(after.get('a'), keptA);
  assert.equal(after.has('b'), false);
  assert.equal(host.children.length, 1);
});

test('reordering moves nodes instead of recreating them', async () => {
  const { reconcile } = await import('../web/ui/reconcile.mjs');
  const host = stubHost();
  const create = (it) => ({ tag: 'row', key: it.id });
  const before = reconcile(host, [{ id: 'a' }, { id: 'b' }], (it) => it.id, create, () => {});
  const a = before.get('a'); const b = before.get('b');
  reconcile(host, [{ id: 'b' }, { id: 'a' }], (it) => it.id, create, () => {});
  assert.deepEqual(host.children, [b, a], 'order follows the new list');
  assert.equal(host.children[1], a, 'and the node is the same object');
});

test('update() is called for survivors and create() only for new keys', async () => {
  const { reconcile } = await import('../web/ui/reconcile.mjs');
  const host = stubHost();
  const created = []; const updated = [];
  const create = (it) => { created.push(it.id); return { tag: 'row', key: it.id }; };
  const update = (node, it) => updated.push(it.id);
  reconcile(host, [{ id: 'a' }], (it) => it.id, create, update);
  reconcile(host, [{ id: 'a' }, { id: 'c' }], (it) => it.id, create, update);
  assert.deepEqual(created, ['a', 'c']);
  // 'a' is new on its first appearance (create() only, no update()) and a
  // survivor on its second (update() only) — one update() call. 'c' is only
  // ever new within this test, so it never reaches update() at all. The
  // task-7 brief's draft of this assertion read ['a', 'a']; that value is
  // only reachable by calling update() on every newly-created node too,
  // which contradicts this test's own title ("create() only for new keys")
  // and was never satisfied by the brief's own reference implementation —
  // confirmed by running it. Fixed here to match the stated contract.
  assert.deepEqual(updated, ['a']);
});
