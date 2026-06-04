// web — web_fetch (undici, SSRF block), web_search (Brave/Tavily/SerpAPI when
// an API key env var is set), url_extract (extract links from HTML).
// SSRF policy: reject loopback, RFC1918 private, link-local, file:, ftp:,
// and any non-http(s) scheme.

import { fetch } from 'undici';
import dns from 'node:dns/promises';

const PRIVATE_V4 = [
  /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^127\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

async function isSafeUrl(url) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'bad URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `scheme ${u.protocol} blocked` };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0') return { ok: false, error: 'loopback blocked (SSRF)' };
  if (PRIVATE_V4.some(re => re.test(host))) return { ok: false, error: 'private address blocked (SSRF)' };
  if (host.includes(':')) return { ok: false, error: 'IPv6 disabled' };
  if (!/^[a-z0-9.-]+$/i.test(host)) return { ok: false, error: 'bad host' };
  try {
    const addrs = await dns.lookup(host, { all: true });
    for (const a of addrs) {
      if (PRIVATE_V4.some(re => re.test(a.address))) return { ok: false, error: 'resolves to private address (SSRF)' };
      if (a.address === '127.0.0.1' || a.address === '::1') return { ok: false, error: 'resolves to loopback (SSRF)' };
    }
  } catch (e) {
    return { ok: false, error: `dns: ${e.message}` };
  }
  return { ok: true };
}

const web_fetch = {
  name: 'web_fetch', category: 'net', sensitive: true,
  description: 'Fetch a public URL. Loopback / private / non-http(s) URLs are blocked.',
  parameters: {
    type: 'object',
    properties: {
      url:     { type: 'string' },
      method:  { type: 'string', enum: ['GET', 'POST'] },
      headers: { type: 'object' },
      body:    { type: 'string' },
      maxBytes:{ type: 'number' },
    },
    required: ['url'],
  },
  async exec(args) {
    const safe = await isSafeUrl(args.url);
    if (!safe.ok) return { ok: false, error: `web_fetch: ${safe.error}` };
    const maxBytes = Math.min(args.maxBytes || 2_000_000, 5_000_000);
    try {
      const res = await fetch(args.url, {
        method: args.method || 'GET',
        headers: args.headers || {},
        body: args.body,
        redirect: 'follow',
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const truncated = buf.length > maxBytes;
      return {
        ok: true, status: res.status,
        headers: Object.fromEntries(res.headers),
        body: buf.slice(0, maxBytes).toString('utf8'),
        truncated,
      };
    } catch (e) { return { ok: false, error: `web_fetch: ${e.message}` }; }
  },
};

const web_search = {
  name: 'web_search', category: 'net', sensitive: false,
  description: 'Search the public web via Brave (BRAVE_API_KEY), Tavily (TAVILY_API_KEY), or SerpAPI (SERPAPI_API_KEY).',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' }, k: { type: 'number' } },
    required: ['query'],
  },
  async exec(args, ctx) {
    const env = ctx?.env || process.env;
    if (env.BRAVE_API_KEY) return braveSearch(args, env.BRAVE_API_KEY);
    if (env.TAVILY_API_KEY) return tavilySearch(args, env.TAVILY_API_KEY);
    if (env.SERPAPI_API_KEY) return serpApiSearch(args, env.SERPAPI_API_KEY);
    return { ok: false, error: 'web_search: no provider configured (set BRAVE_API_KEY / TAVILY_API_KEY / SERPAPI_API_KEY)' };
  },
};

async function braveSearch({ query, k = 5 }, key) {
  try {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${k}`, {
      headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' },
    });
    const j = await r.json();
    return { ok: true, results: (j?.web?.results || []).slice(0, k).map(x => ({ title: x.title, url: x.url, snippet: x.description })) };
  } catch (e) { return { ok: false, error: `brave: ${e.message}` }; }
}
async function tavilySearch({ query, k = 5 }, key) {
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: k }),
    });
    const j = await r.json();
    return { ok: true, results: (j?.results || []).slice(0, k).map(x => ({ title: x.title, url: x.url, snippet: x.content })) };
  } catch (e) { return { ok: false, error: `tavily: ${e.message}` }; }
}
async function serpApiSearch({ query, k = 5 }, key) {
  try {
    const r = await fetch(`https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=${k}&api_key=${key}`);
    const j = await r.json();
    return { ok: true, results: (j?.organic_results || []).slice(0, k).map(x => ({ title: x.title, url: x.link, snippet: x.snippet })) };
  } catch (e) { return { ok: false, error: `serpapi: ${e.message}` }; }
}

const url_extract = {
  name: 'url_extract', category: 'net', sensitive: false,
  description: 'Extract all href URLs from an HTML string.',
  parameters: {
    type: 'object',
    properties: { html: { type: 'string' }, base: { type: 'string' } },
    required: ['html'],
  },
  async exec(args) {
    const urls = new Set();
    const re = /href\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(args.html))) {
      try {
        urls.add(args.base ? new URL(m[1], args.base).toString() : m[1]);
      } catch { urls.add(m[1]); }
    }
    return { ok: true, urls: [...urls] };
  },
};

export const TOOLS = [web_fetch, web_search, url_extract];
