// Unit tests for scripts/bench-stats.mjs — the pure descriptive statistics
// shared by the claude-cli benchmark harness. Gate-enforced (no I/O, no real
// calls). Percentiles are type-7 linear interpolation; median == percentile(0.5);
// stdev is the sample (n-1) deviation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, median, percentile, stdev, summarize,
} from '../scripts/bench-stats.mjs';

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

// ── mean ──────────────────────────────────────────────────────────────────
test('mean: arithmetic average', () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(mean([5]), 5);
});

// ── percentile (type-7 linear interpolation) + median ───────────────────────
test('percentile: type-7 linear interpolation', () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  approx(percentile(xs, 0.5), 55);    // rank 4.5 -> 50 + .5*(60-50)
  approx(percentile(xs, 0.95), 95.5); // rank 8.55 -> 90 + .55*(100-90)
  approx(percentile(xs, 0), 10);
  approx(percentile(xs, 1), 100);
});

test('percentile: single sample returns that sample for any p', () => {
  assert.equal(percentile([42], 0.5), 42);
  assert.equal(percentile([42], 0.95), 42);
});

test('percentile: is order-independent (sorts internally)', () => {
  approx(percentile([100, 10, 50, 30], 0.5), 40); // sorted 10,30,50,100 rank1.5 -> 30+.5*(50-30)
});

test('median: equals percentile(0.5), handles odd/even', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5]), 5);
});

// ── stdev (sample, n-1) ──────────────────────────────────────────────────
test('stdev: sample standard deviation (n-1 denominator)', () => {
  assert.equal(stdev([2, 4, 6]), 2); // var = (4+0+4)/2 = 4 -> 2
});

test('stdev: fewer than two samples is 0 (no division by zero)', () => {
  assert.equal(stdev([5]), 0);
  assert.equal(stdev([]), 0);
});

// ── summarize ──────────────────────────────────────────────────────────────
test('summarize: bundles n/min/max/mean/median/p95/stdev', () => {
  const s = summarize([2, 4, 6]);
  assert.equal(s.n, 3);
  assert.equal(s.min, 2);
  assert.equal(s.max, 6);
  assert.equal(s.mean, 4);
  assert.equal(s.median, 4);
  assert.equal(s.stdev, 2);
  approx(s.p95, 5.8); // rank 1.9 -> 4 + .9*(6-4)
});

test('summarize: empty sample set yields n:0 and null stats', () => {
  const s = summarize([]);
  assert.equal(s.n, 0);
  assert.equal(s.median, null);
  assert.equal(s.p95, null);
  assert.equal(s.mean, null);
  assert.equal(s.stdev, null);
  assert.equal(s.min, null);
  assert.equal(s.max, null);
});

test('percentile: clamps p outside [0,1] instead of returning NaN', () => {
  const xs = [10, 20, 30, 40];
  assert.equal(percentile(xs, 1.5), 40);   // p>=1 -> max
  assert.equal(percentile(xs, -0.5), 10);  // p<=0 -> min
});

test('summarize: filters non-finite input so n matches the values actually summarized', () => {
  const s = summarize([1, NaN, 3, Infinity]);
  assert.equal(s.n, 2);   // NaN + Infinity dropped
  assert.equal(s.min, 1);
  assert.equal(s.max, 3);
  assert.equal(s.mean, 2);
  assert.equal(s.median, 2);
});
