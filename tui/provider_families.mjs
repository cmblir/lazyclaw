// tui/provider_families.mjs — pure (react-free) provider bucketing for the
// drill-in provider picker. The flat "every provider in one list" picker the
// v5.4 Ink port shipped is overwhelming and even exposed the orchestrator
// (which must never be a default). This restores the legacy family grouping
// (API key / CLI-Local / Mock) as shared, unit-testable data so both the
// readline picker (cli.mjs) and the Ink dispatcher use one bucketing rule.

// Bucket every registered provider into one of four auth families.
// orchestrator sits in its own `meta` family — visible and pickable, but
// never a wizard default (the cursor always starts on api/cli — see the
// cli.mjs v5.3.2 note). Returns { api:[], cli:[], mock:[], meta:[] } of
// provider-id strings.
export function bucketProviders(registry) {
  const info = (registry && registry.PROVIDER_INFO) || {};
  const all = Object.keys((registry && registry.PROVIDERS) || {});
  const out = { api: [], cli: [], mock: [], meta: [] };
  for (const name of all) {
    if (name === 'mock') out.mock.push(name);
    else if (name === 'orchestrator') out.meta.push(name);
    else if ((info[name] || {}).requiresApiKey) out.api.push(name);
    else out.cli.push(name);
  }
  return out;
}

// Full family descriptors (label/desc/plain-text tag/members) for the Ink
// first-step picker. Tags are plain text — Ink applies its own styling.
export function providerFamilies(registry) {
  const b = bucketProviders(registry);
  return {
    api: { id: 'api', label: 'API key', desc: 'paste an sk-... key', tag: 'needs key', members: b.api },
    cli: { id: 'cli', label: 'CLI / Local', desc: 'keyless — an existing CLI login or a local daemon', tag: 'no key', members: b.cli },
    meta: { id: 'meta', label: 'Multi-agent', desc: 'orchestrator — fan a task out to a planner + workers (advanced)', tag: 'meta', members: b.meta },
    mock: { id: 'mock', label: 'Mock', desc: 'offline echo, only useful for testing', tag: 'test', members: b.mock },
  };
}

// Plain-text per-row tag for a provider, from its PROVIDER_INFO meta.
export function providerTag(meta) {
  const m = meta || {};
  if (m.custom) return 'custom';
  return m.requiresApiKey ? 'api key' : 'no key';
}
