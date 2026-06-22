// Pure descriptive statistics for the benchmark harness.
//
// Shared by tests/bench_claude_cli.test.mjs (gate-enforced, no real calls) and
// scripts/bench-claude-cli.mjs (the live multi-sample runner). Kept dependency-
// and side-effect-free so it imports cheaply from either.
//
// Percentiles use the type-7 linear-interpolation definition (the NumPy/R
// default): for p in [0,1], rank = p*(n-1) and we interpolate between the two
// neighbouring order statistics. median is exactly percentile(xs, 0.5), so the
// 50th percentile of an even-length set is the mean of the two middle values
// rather than an arbitrary side. stdev is the SAMPLE deviation (n-1 / Bessel),
// the right choice when N latency samples are a sample of possible runs.

export function mean(xs) {
  if (!xs || xs.length === 0) return NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

export function percentile(xs, p) {
  if (!xs || xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const rank = p * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return s[lo];
  return s[lo] + (rank - lo) * (s[hi] - s[lo]);
}

export function median(xs) {
  return percentile(xs, 0.5);
}

export function stdev(xs) {
  // n<2 has no spread to estimate; return 0 rather than NaN so tables render.
  if (!xs || xs.length < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return Math.sqrt(ss / (xs.length - 1));
}

export function summarize(xs) {
  const arr = xs || [];
  if (arr.length === 0) {
    return { n: 0, min: null, max: null, mean: null, median: null, p95: null, stdev: null };
  }
  return {
    n: arr.length,
    min: arr.reduce((a, b) => (b < a ? b : a), arr[0]),
    max: arr.reduce((a, b) => (b > a ? b : a), arr[0]),
    mean: mean(arr),
    median: median(arr),
    p95: percentile(arr, 0.95),
    stdev: stdev(arr),
  };
}
