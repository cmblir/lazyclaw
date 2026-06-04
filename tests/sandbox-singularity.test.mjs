import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SingularitySandbox, buildSingularityArgv } from '../sandbox/singularity.mjs';

test('buildSingularityArgv prefers apptainer when available flag set', () => {
  const argv = buildSingularityArgv({
    image: '/scratch/agent.sif', bind: ['/work'], net: false, useApptainer: true,
  }, ['claude']);
  assert.equal(argv[0], 'apptainer');
  assert.equal(argv[1], 'exec');
  assert.ok(argv.includes('--bind'));
  assert.ok(argv.includes('/work'));
  assert.ok(argv.includes('--net'));   // singularity uses --net (no value) for network namespace
  assert.ok(argv.includes('--network=none'));
  assert.equal(argv.at(-2), '/scratch/agent.sif');
  assert.equal(argv.at(-1), 'claude');
});

test('buildSingularityArgv falls back to singularity binary', () => {
  const argv = buildSingularityArgv({
    image: 'docker://alpine:3.20', useApptainer: false,
  }, ['true']);
  assert.equal(argv[0], 'singularity');
});

test('SingularitySandbox describe()', () => {
  const sb = new SingularitySandbox({ kind: 'singularity', image: 'x.sif' });
  assert.match(sb.describe(), /singularity.*x\.sif/);
});
