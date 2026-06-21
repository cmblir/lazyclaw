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

// Account one turn's cost against the running metrics so the cost cap tracks
// real spend, and return the cost block ONLY when the caller asked for it.
//
// The previous /chat + /agent code only accumulated when the CALLER set
// body.cost — but no bundled client does, so the cap never tripped. Here
// accumulation is unconditional whenever a rate card resolves a cost;
// `wantCost` (body.cost) just controls whether the cost block is returned to
// the client. `costFromUsage` is injected to keep this module pure/testable.
export function accountTurnCost({ metrics, usage, provider, model, rates, wantCost, costFromUsage }) {
  if (!usage || !rates || typeof costFromUsage !== 'function') return null;
  let cost = null;
  try {
    cost = costFromUsage({ provider, model, usage }, rates);
    if (cost) accumulateMetricsFromCost(metrics, usage, cost);
  } catch { return null; }
  return wantCost ? cost : null;
}

// Build the onUsage handler the team multi-agent loop fires per agent turn.
// Each turn carries its own { provider, model, usage } so a mixed-provider team
// is priced against the right rate card; the spend lands in metrics so the cost
// cap covers team traffic (which used to bypass it entirely), and onBreach() is
// called once accumulated spend trips the cap so the caller can abort the loop
// mid-run. Best-effort: a cost-accounting hiccup never breaks a turn.
export function makeTeamUsageAccountant({ metrics, costCap, rates, costFromUsage, onBreach }) {
  return ({ provider, model, usage }) => {
    try {
      if (usage && rates && typeof costFromUsage === 'function') {
        const cost = costFromUsage({ provider, model, usage }, rates);
        if (cost) accumulateMetricsFromCost(metrics, usage, cost);
      }
      if (typeof onBreach === 'function' && checkCostCap(metrics, costCap)) onBreach();
    } catch { /* best-effort — never break a turn on accounting */ }
  };
}
