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

// Build the { name, children[] } tree rooted at the lead.
export function buildTeamTree(team, byId) {
  const lead = team.lead;
  const members = team.agents || [];
  const kids = {};
  for (const n of members) {
    if (n === lead) continue;
    const rec = byId[n];
    const mgr = rec && rec.manager && members.includes(rec.manager) && rec.manager !== n ? rec.manager : lead;
    (kids[mgr] = kids[mgr] || []).push(n);
  }
  const build = (name, seen) => {
    if (seen.has(name)) return null;
    const next = new Set(seen); next.add(name);
    return { name, children: (kids[name] || []).sort().map((c) => build(c, next)).filter(Boolean) };
  };
  return build(lead, new Set());
}
