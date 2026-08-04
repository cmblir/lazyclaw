// web/ui/team_tree.mjs — pure (no-DOM) helpers for the Team Live view: avatar
// selection and the lead/children tree shape. Split out of panels/team.mjs
// (dashboard-shell-motion Task 4) to keep that file under the 500-line size
// gate; Task 8's command palette also needs this tree shape, hence the
// standalone module rather than a panel-local helper.

export function harnessLabel(rec) {
  const p = (rec && rec.provider) || '?';
  const m = (rec && rec.model) || '';
  return m ? `${p} · ${m}` : p;
}

export function avatarGlyph(rec) {
  if (rec && rec.iconEmoji) return rec.iconEmoji;
  return (((rec && rec.name) || '?').slice(0, 1)).toUpperCase();
}

// Map an agent to one of the 20 pixel-art role avatars (web/avatars/NN.png).
// Explicit agent.avatar (1..20) wins; otherwise infer from name/role/tags by
// keyword (specific roles first so "data engineer" beats "data"); else PM.
const AVATAR_ROLES = [
  [2, ['backend', 'back-end', 'back end', '백엔드', 'server', 'api']],
  [3, ['frontend', 'front-end', 'front end', '프론트', 'react', 'vue', 'css']],
  [7, ['data engineer', 'data-engineer', 'dataeng', '데이터 엔지니어', '데이터엔지니어', 'etl', 'pipeline']],
  [4, ['devops', 'infra', '인프라', '데브옵스', 'sre', 'kubernetes', 'k8s', 'ops']],
  [5, ['qa', 'tester', 'test engineer', '테스트', '품질', 'quality']],
  [6, ['analyst', 'analytics', '분석', 'bi']],
  [8, ['research', '리서치', '조사', 'scholar']],
  [9, ['ux', 'ui design', 'designer', '디자이너', '디자인', 'design']],
  [10, ['copywriter', 'copy', 'content writer', '카피', '콘텐츠', 'writer']],
  [11, ['marketer', 'marketing', 'growth', '마케터', '마케팅', '그로스']],
  [12, ['seo']],
  [13, ['sales', '영업', '세일즈']],
  [14, ['support', 'customer', '고객', 'cs ', 'helpdesk']],
  [15, ['legal', 'compliance', '법무', '컴플라이언스']],
  [16, ['finance', 'account', '재무', '회계']],
  [17, ['security', '보안', 'sec ', 'infosec', 'appsec']],
  [18, ['tech writer', 'documentation', 'docs', '테크니컬', '문서']],
  [19, ['code review', 'reviewer', '리뷰', '코드 리뷰']],
  [20, ['orchestrat', '오케스트레이터', '코디네이터', '총괄', 'conductor']],
  [1, ['pm', 'product', 'planner', '기획', 'manager', 'coordinator', 'lead']],
];

export function avatarIndexFor(rec) {
  const explicit = rec && Number(rec.avatar);
  if (explicit >= 1 && explicit <= 20) return explicit;
  const hay = [rec && rec.name, rec && rec.displayName, rec && rec.role, ...(rec && rec.tags || [])]
    .filter(Boolean).join(' ').toLowerCase();
  for (const [idx, keys] of AVATAR_ROLES) {
    if (keys.some((k) => hay.includes(k))) return idx;
  }
  return 1; // generic PM look
}

// A user-supplied custom image (set via `lazyclaw agent set-avatar`) wins
// over the picked/inferred built-in sprite. rec.avatarImage is already a
// ready-to-use src (a remote URL or a daemon-served /agent-avatars/ path).
export function avatarSrc(rec) {
  if (rec && rec.avatarImage) return rec.avatarImage;
  return `/avatars/${String(avatarIndexFor(rec)).padStart(2, '0')}.png`;
}

// The reporting line, as a pure function: `manager` is a property of the
// AGENT, the lead is the only root, and any other member whose manager is
// missing or not on this team's roster hangs off the lead. buildTeamTree
// used to inline this rule; it is the single definition now so a topology
// render and this legacy tree shape can't quietly disagree.
/** The in-team manager, or null when this agent IS the root (the lead). */
export function managerIn(team, agent) {
  if (!agent || agent.name === team.lead) return null;
  if (agent.manager && team.agents.includes(agent.manager) && agent.manager !== agent.name) {
    return agent.manager;
  }
  return team.lead;
}

// Build the { name, children[] } tree rooted at the lead.
export function buildTeamTree(team, byId) {
  const lead = team.lead;
  const members = team.agents || [];
  const kids = {};
  for (const n of members) {
    if (n === lead) continue;
    const mgr = managerIn({ lead, agents: members }, byId[n]) || lead;
    (kids[mgr] = kids[mgr] || []).push(n);
  }
  const build = (name, seen) => {
    if (seen.has(name)) return null;
    const next = new Set(seen); next.add(name);
    return { name, children: (kids[name] || []).sort().map((c) => build(c, next)).filter(Boolean) };
  };
  return build(lead, new Set());
}

/**
 * Rows by depth. Each row is ordered by walking the previous row, so siblings
 * sit under their own manager and the drawn edges stop crossing. A `manager`
 * cycle cannot hang this: anyone unreached lands in a final row.
 */
export function tierRows(team, agentsByName) {
  const members = team.agents.map((n) => agentsByName[n]).filter(Boolean);
  const childrenOf = new Map();
  const roots = [];
  for (const m of members) {
    const mgr = managerIn(team, m);
    if (!mgr) { roots.push(m.name); continue; }
    if (!childrenOf.has(mgr)) childrenOf.set(mgr, []);
    childrenOf.get(mgr).push(m.name);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.localeCompare(b));
  roots.sort((a, b) => (a === team.lead ? -1 : b === team.lead ? 1 : a.localeCompare(b)));

  const rows = [];
  const seen = new Set();
  let level = roots;
  while (level.length) {
    const row = level.filter((n) => !seen.has(n));
    if (!row.length) break;
    for (const n of row) seen.add(n);
    rows.push(row);
    level = row.flatMap((n) => childrenOf.get(n) || []);
  }
  const orphans = members.filter((m) => !seen.has(m.name)).map((m) => m.name);
  if (orphans.length) rows.push(orphans);
  return rows;
}

export function reportsOf(team, agentsByName, name) {
  return team.agents
    .map((n) => agentsByName[n])
    .filter((m) => m && managerIn(team, m) === name)
    .map((m) => m.name);
}

/** The agent, its manager chain upward, and every report downward. */
export function chainOf(team, agentsByName, name) {
  const chain = new Set([name]);
  let cur = agentsByName[name];
  while (cur) {
    const mgr = managerIn(team, cur);
    if (!mgr || chain.has(mgr)) break;
    chain.add(mgr);
    cur = agentsByName[mgr];
  }
  const down = reportsOf(team, agentsByName, name);
  while (down.length) {
    const n = down.pop();
    if (chain.has(n)) continue;
    chain.add(n);
    down.push(...reportsOf(team, agentsByName, n));
  }
  return chain;
}

export function isDescendant(team, agentsByName, candidate, ancestor) {
  let cur = agentsByName[candidate];
  const seen = new Set();
  while (cur) {
    const mgr = managerIn(team, cur);
    if (!mgr || seen.has(mgr)) return false;
    if (mgr === ancestor) return true;
    seen.add(mgr);
    cur = agentsByName[mgr];
  }
  return false;
}

/** null newManager means "hang off the lead" (the buildTeamTree default). */
export function canReassign(team, agentsByName, name, newManager) {
  if (!newManager) return name !== team.lead;
  if (newManager === name) return false;
  if (!team.agents.includes(newManager)) return false;
  if (name === team.lead) return false;
  return !isDescendant(team, agentsByName, newManager, name);
}
