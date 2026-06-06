// tests/p3-first-run.test.mjs — first-run onboarding routing. A genuine fresh
// install (no provider, interactive) should get the full guided setup, not
// just the provider picker; an explicit --pick stays lightweight; automation
// (non-TTY) is never prompted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { firstRunMode } from '../first_run.mjs';

test('fresh install on a TTY runs the full setup funnel', () => {
  assert.equal(firstRunMode({ hasProvider: false, flagPick: false, isTTY: true }), 'setup');
});

test('explicit --pick stays a lightweight provider/model pick', () => {
  assert.equal(firstRunMode({ hasProvider: true, flagPick: true, isTTY: true }), 'pick');
  assert.equal(firstRunMode({ hasProvider: false, flagPick: true, isTTY: true }), 'pick');
});

test('already-configured provider is not prompted', () => {
  assert.equal(firstRunMode({ hasProvider: true, flagPick: false, isTTY: true }), 'none');
});

test('non-interactive (automation) is never prompted', () => {
  assert.equal(firstRunMode({ hasProvider: false, flagPick: false, isTTY: false }), 'none');
  assert.equal(firstRunMode({ hasProvider: false, flagPick: true, isTTY: false }), 'none');
});
