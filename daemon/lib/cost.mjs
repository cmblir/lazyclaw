// Cost-cap enforcement + per-handler metrics accumulation for the daemon.
// Pure — operates only on the passed-in metrics/costCap objects.

// Has the cumulative cost in any capped currency reached the cap?
// Returns the offending currency + amount + cap so the caller can
// surface it cleanly, or null when no cap is breached.
export function checkCostCap(metrics, costCap) {
  if (!costCap) return null;
  for (const [cur, cap] of Object.entries(costCap)) {
    if (!Number.isFinite(cap) || cap <= 0) continue;
    const spent = metrics.costsByCurrency[cur] || 0;
    if (spent >= cap) return { currency: cur, spent: Math.round(spent * 1_000_000) / 1_000_000, cap };
  }
  return null;
}

// Bump per-handler metrics from a single request's cost+usage. Keys
// cost by currency so heterogeneous fleets (USD-priced anthropic, EUR
// regional contracts) don't silently sum mismatched numbers. Tokens
// are unit-free → single counter.
export function accumulateMetricsFromCost(metrics, usage, cost) {
  if (cost && Number.isFinite(cost.cost)) {
    const cur = cost.currency || 'USD';
    metrics.costsByCurrency[cur] = (metrics.costsByCurrency[cur] || 0) + cost.cost;
  }
  if (usage) {
    if (Number.isFinite(usage.inputTokens)) metrics.tokensTotal.inputTokens += usage.inputTokens;
    if (Number.isFinite(usage.outputTokens)) metrics.tokensTotal.outputTokens += usage.outputTokens;
  }
}
