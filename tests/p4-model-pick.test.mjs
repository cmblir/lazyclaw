// tests/p4-model-pick.test.mjs — the canonical provider→model picker hoisted
// into tui/model_pick.mjs. Drives pickProviderModel + buildModelItems with a
// scripted ctx.openPicker (queue of answers; each is an id, a {id,query}
// freeText row, or null for cancel).

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickProviderModel, buildModelItems } from '../tui/model_pick.mjs';
import * as registry from '../providers/registry.mjs';

function mkCtx(answers, { prov = 'anthropic', model = '' } = {}) {
  const q = [...answers];
  let activeProv = prov, activeModel = model;
  return {
    getActiveProvName: () => activeProv,
    getActiveModel: () => activeModel,
    setActiveProvName: (p) => { activeProv = p; },
    setActiveModel: (m) => { activeModel = m; },
    resolveAuthKey: () => '',
    cfg: {},
    openPicker: async () => (q.length ? q.shift() : null),
  };
}

test('buildModelItems carries a custom-id freeText row + switch-provider row', () => {
  const items = buildModelItems(registry.PROVIDER_INFO['anthropic'], 'anthropic', []);
  assert.ok(items.some((i) => i.id === '__custom_model__' && i.freeText));
  assert.ok(items.some((i) => i.id === '__switch_provider__'));
});

test('buildModelItems omits switch-provider when includeSwitch:false, adds default when asked', () => {
  const items = buildModelItems(registry.PROVIDER_INFO['anthropic'], 'anthropic', [], { includeSwitch: false, includeDefault: true });
  assert.ok(!items.some((i) => i.id === '__switch_provider__'));
  assert.ok(items.some((i) => i.id === '__default__'));
});

test('pickProviderModel returns the picked model for the active provider', async () => {
  const ctx = mkCtx(['claude-opus-4-8']);
  const r = await pickProviderModel(ctx, registry, {});
  assert.deepEqual(r, { provider: 'anthropic', model: 'claude-opus-4-8' });
});

test('pickProviderModel resolves a custom id from the freeText row', async () => {
  const ctx = mkCtx([{ id: '__custom_model__', query: 'my-tuned-model' }]);
  const r = await pickProviderModel(ctx, registry, {});
  assert.equal(r.model, 'my-tuned-model');
});

test('pickProviderModel reports the provider with a null model when the model pick is cancelled', async () => {
  const ctx = mkCtx([null]);
  assert.deepEqual(await pickProviderModel(ctx, registry, {}), { provider: 'anthropic', model: null });
});

test('pickProviderModel returns null when cancelled at the provider step', async () => {
  const ctx = mkCtx([null], { prov: 'orchestrator' }); // composite → provider step first
  assert.equal(await pickProviderModel(ctx, registry, {}), null);
});

test('includeAuto opens the provider step and resolves the auto sentinel', async () => {
  const ctx = mkCtx(['__auto__']);
  const r = await pickProviderModel(ctx, registry, { includeAuto: true });
  assert.deepEqual(r, { provider: 'auto', model: '' });
});
