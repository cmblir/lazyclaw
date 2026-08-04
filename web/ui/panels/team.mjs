// web/ui/panels/team.mjs — real-time view of an agent team: avatar tiles with
// status rings + harness badges, click-to-drill-down, and live A→B
// delegation pulses, driven by the app-level SSE subscription in stream.mjs
// (Task 6) rather than owning its own reader. Pure avatar/tree helpers live
// in ../team_tree.mjs (kept out of this file for the 500-line size gate;
// Task 8's command palette needs that module too).
import { el, phead, clear } from '../dom.mjs';
import { api } from '../api.mjs';
import { harnessLabel, avatarGlyph, avatarSrc, buildTeamTree, managerIn, chainOf } from '../team_tree.mjs';
import { subscribe } from '../stream.mjs';
import { captureRects, playFlip } from '../motion.mjs';

// One curve per manager link, measured from the rendered tiles. The same path
// is reused for the delegation flow, so a hand-off visibly travels the
// reporting line rather than cutting across the canvas.
//
// Returns whether it actually measured and drew (false only when `topoEl`
// has no layout yet — a panel rendering into a still-hidden host). The
// caller retries on false; it must NOT be called from inside
// `requestAnimationFrame` after `playFlip` starts an animation, because
// `getBoundingClientRect()` reports the currently-applied CSS transform, not
// the resting position — a tile mid-FLIP would be measured at its
// transitional spot and the edge would never be redrawn once the animation
// settles. Call this before `playFlip`, against the plain (untransformed)
// post-layout DOM.
function drawEdges(team, agentsByName, tiles, topoEl, edgesEl) {
  clear(edgesEl);
  if (!team) return true; // nothing to draw; not a "not yet measured" failure
  const base = topoEl.getBoundingClientRect();
  if (!base.width) return false;                // panel not visible yet — caller retries
  for (const name of team.agents) {
    const agent = agentsByName[name];
    const mgr = managerIn(team, agent);
    if (!mgr) continue;
    const from = tiles.get(mgr); const to = tiles.get(name);
    if (!from || !to) continue;
    const a = from.getBoundingClientRect(); const b = to.getBoundingClientRect();
    const x1 = a.left - base.left + a.width / 2; const y1 = a.bottom - base.top - 6;
    const x2 = b.left - base.left + b.width / 2; const y2 = b.top - base.top + 4;
    const mid = (y1 + y2) / 2;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('class', 'edge');
    p.setAttribute('d', `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`);
    p.dataset.from = mgr;
    p.dataset.to = name;
    edgesEl.append(p);
  }
  return true;
}

export function render(host) {
  host.append(phead('Team Live', null));

  const sel = el('select', { 'aria-label': 'Select a team to watch' });
  // Connection status used to be tracked per-panel (this was the only panel
  // with a live reader); now stream.mjs owns one shared connection and shows
  // its state in the topbar (#daemon-state), so there is no local status to
  // render here.
  host.append(el('div', { class: 'toolbar' },
    el('label', { class: 'dim', text: 'Team' }), sel,
    el('button', { class: 'btn btn-secondary', type: 'button', text: 'Refresh', onclick: () => load() })));

  const canvas = el('div', { class: 'team-canvas', role: 'tree', 'aria-label': 'Agent team' },
    el('div', { class: 'empty', text: 'Loading…' }));
  const detail = el('aside', { class: 'team-detail', 'aria-live': 'polite' },
    el('div', { class: 'empty', text: "Click an agent to see its harness and what it's working on." }));
  host.append(el('div', { class: 'team-live' }, canvas, detail));

  const feed = el('ul', { class: 'team-feed', 'aria-live': 'polite' });
  host.append(el('div', { class: 'team-feed-wrap' }, el('div', { class: 'label', text: 'Live activity' }), feed));

  const TEAM = { team: null, agentsById: {}, status: {}, activity: {}, task: null, selected: null };

  // The tile Map is kept for the panel's lifetime and never recreated, so a
  // tile's Element identity survives a topology re-render — a reassignment
  // needs each tile's old/new bounding box to FLIP-animate between them,
  // which only works if the tile itself was not thrown away and rebuilt.
  // The tree scaffolding around the tiles (the .subtree/.subtree-kids
  // wrapper divs below) is NOT persisted — it is a handful of nodes and is
  // cheap to rebuild every render; only the tiles themselves must persist,
  // so they live in one Map keyed by agent name rather than one per subtree
  // container (a subtree container is not stable across renders — an
  // agent's position in the tree can change depth, which would move it to
  // a different container and destroy it if the container were the thing
  // holding identity instead of this Map).
  const tileByName = new Map();
  const edgesSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  edgesSvg.setAttribute('id', 'edges');
  const topologyEl = el('div', { class: 'topology' }, edgesSvg);

  // drawEdges must run against the settled (untransformed) layout, so it is
  // called synchronously right after the DOM is rebuilt, before playFlip
  // starts any animation. The only reason it can still fail is the panel
  // rendering into a host with no layout yet (zero width) — retry on a
  // rAF gated on "did not measure successfully yet", not on "we just
  // rendered", so a resize or a render that DID measure successfully never
  // schedules a redundant extra frame.
  //
  // The retry is a self-rescheduling rAF loop, which outlives a plain
  // `addEventListener` unless something explicitly stops it: navigating
  // away while the topology still has zero width (a fast panel switch
  // right after activation, before layout) leaves the loop measuring a
  // now-detached node forever, and every later visit to this panel starts
  // a fresh one stacked on top. `disposed` is checked on every tick so a
  // frame already in flight when cleanup runs is a no-op; `pendingFrame`
  // is the handle so cleanup can also cancel the pending frame outright,
  // rather than merely flagging it as not-to-be-acted-on.
  let disposed = false;
  let pendingFrame = 0;
  // Cancel rather than merely forget the pending handle: `onResize` and
  // `renderTeamCanvas` call this directly, so simply zeroing `pendingFrame`
  // on entry would orphan a retry that is still queued — out of cleanup's
  // reach, and forking a second rAF chain that each further direct call
  // multiplies again. Cancelling collapses it back to one chain always.
  function drawEdgesUntilMeasured() {
    if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
    if (disposed) return;
    if (!drawEdges(TEAM.team, TEAM.agentsById, tileByName, topologyEl, edgesSvg)) {
      pendingFrame = requestAnimationFrame(drawEdgesUntilMeasured);
    }
  }
  function onResize() { drawEdgesUntilMeasured(); }
  window.addEventListener('resize', onResize);

  function tileStatus(name) { return TEAM.status[name] || 'idle'; }

  // An agent whose `manager` is set but off this team's roster hangs off the
  // lead (managerIn's fallback) — this badge is the only thing that explains
  // why, since the tile otherwise looks like any other direct report.
  function reassignedBadge(rec) {
    if (!rec.manager || !TEAM.team || TEAM.team.agents.includes(rec.manager)) return null;
    return el('span', { class: 'reassigned', text: 'mgr outside team',
      title: `Manager "${rec.manager}" is not on this team, so the tree hangs this agent off the lead.` });
  }

  // Hover/focus dimming: data-focus on the topology plus data-inchain on
  // every tile in the hovered agent's chain (managers above, reports below),
  // read by `.topology[data-focus] .agent:not([data-inchain])` in the CSS.
  function focusChain(name) {
    if (!TEAM.team) return;
    const chain = chainOf(TEAM.team, TEAM.agentsById, name);
    topologyEl.setAttribute('data-focus', '');
    for (const [key, node] of tileByName) node.toggleAttribute('data-inchain', chain.has(key));
  }

  function clearFocus() {
    topologyEl.removeAttribute('data-focus');
    for (const node of tileByName.values()) node.removeAttribute('data-inchain');
  }

  function createTile(name) {
    const rec = TEAM.agentsById[name] || { name };
    const st = tileStatus(name);
    const img = el('img', { src: avatarSrc(rec), alt: '', onerror: (e) => e.target.remove() });
    return el('button', {
      class: `tagent agent ${st}`, 'data-agent': name, role: 'treeitem',
      'aria-selected': String(TEAM.selected === name), onclick: () => selectTeamAgent(name),
      onmouseenter: () => focusChain(name), onmouseleave: clearFocus,
      onfocus: () => focusChain(name), onblur: clearFocus,
    },
      el('div', { class: 'tagent-avatar', 'aria-hidden': 'true' },
        el('span', { class: 'tagent-glyph', text: avatarGlyph(rec) }), img),
      el('div', { class: 'tagent-name', text: rec.displayName || name }),
      el('div', { class: 'tagent-status', text: st === 'working' ? '● working' : '○ idle' }),
      el('div', { class: 'harness-badge', text: harnessLabel(rec) }),
      reassignedBadge(rec));
  }

  // Refreshes exactly what createTile computed from live state, so a
  // reused tile ends up identical to a freshly-created one — status,
  // selection, name/harness/avatar can all change out from under a
  // survivor between renders (setAgentStatus/selectTeamAgent already patch
  // these in place for the SSE-driven case; this covers the same fields
  // for a full topology re-render).
  function updateTile(btn, name) {
    const rec = TEAM.agentsById[name] || { name };
    const st = tileStatus(name);
    btn.className = `tagent agent ${st}`;
    btn.setAttribute('aria-selected', String(TEAM.selected === name));
    btn.querySelector('.tagent-name').textContent = rec.displayName || name;
    btn.querySelector('.tagent-status').textContent = st === 'working' ? '● working' : '○ idle';
    btn.querySelector('.harness-badge').textContent = harnessLabel(rec);
    btn.querySelector('.tagent-glyph').textContent = avatarGlyph(rec);
    const img = btn.querySelector('.tagent-avatar img');
    if (img) img.src = avatarSrc(rec);
    const oldBadge = btn.querySelector('.reassigned');
    if (oldBadge) oldBadge.remove();
    const newBadge = reassignedBadge(rec);
    if (newBadge) btn.append(newBadge);
  }

  // Get-or-create from the panel-lifetime tile Map, tracking `name` in
  // `seen` so the caller can drop whatever wasn't touched this render (an
  // agent that left the roster, or one unreachable from the lead because
  // its manager chain sits inside a cycle — buildTeamTree's own `seen`
  // guard already excludes those from the tree, so they must not linger
  // here either).
  function getOrCreateTile(name, seen) {
    seen.add(name);
    let node = tileByName.get(name);
    if (node) updateTile(node, name);
    else { node = createTile(name); tileByName.set(name, node); }
    return node;
  }

  // A node renders as a column: its own tile, then (if it has reports) a
  // row of its children's subtrees. Flex centres a column's children over
  // each other by default, so a manager ends up centred over its own
  // reports by construction — unlike a flat `.tier` row, which centres on
  // the whole canvas regardless of whose reports it holds and so cannot
  // keep a report under the right manager once two managers are on the
  // same row (see the bug report this replaced: `qa`/`reviewer` both
  // report to `backend`, but a shared `.tier` row put one of them under
  // `frontend` instead, and its edge crossed the canvas to reach it).
  function buildSubtree(node, seen) {
    const tile = getOrCreateTile(node.name, seen);
    if (!node.children.length) return el('div', { class: 'subtree' }, tile);
    return el('div', { class: 'subtree' }, tile,
      el('div', { class: 'subtree-kids' }, node.children.map((c) => buildSubtree(c, seen))));
  }

  function renderTeamCanvas() {
    if (!TEAM.team) { canvas.replaceChildren(el('div', { class: 'empty', text: 'No team selected.' })); return; }
    const tree = buildTeamTree(TEAM.team, TEAM.agentsById);
    if (!tree) { canvas.replaceChildren(el('div', { class: 'empty', text: 'This team has no lead.' })); return; }

    const before = captureRects(tileByName);

    const seen = new Set();
    const root = buildSubtree(tree, seen);
    for (const name of [...tileByName.keys()]) {
      if (!seen.has(name)) tileByName.delete(name);
    }

    topologyEl.replaceChildren(edgesSvg, root);
    canvas.replaceChildren(topologyEl);

    // Measure the settled (untransformed) layout BEFORE playFlip starts its
    // CSS transform — see drawEdges's own comment for why the reverse order
    // (a rAF scheduled after playFlip, which this replaces) silently froze
    // every moved tile's edge at its pre-FLIP position.
    drawEdgesUntilMeasured();
    playFlip(before, tileByName);
  }

  function selectTeamAgent(name) {
    TEAM.selected = name;
    canvas.querySelectorAll('.tagent').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.agent === name)));
    renderTeamDetail();
  }

  function renderTeamDetail() {
    const name = TEAM.selected;
    if (!name) {
      detail.replaceChildren(el('div', { class: 'empty', text: "Click an agent to see its harness and what it's working on." }));
      return;
    }
    const rec = TEAM.agentsById[name] || { name };
    const st = TEAM.status[name] || 'idle';
    const acts = (TEAM.activity[name] || []).slice(-8).reverse();
    detail.replaceChildren(
      el('h3', {},
        el('img', { class: 'detail-avatar', src: avatarSrc(rec), alt: '', onerror: (e) => e.target.remove() }),
        rec.displayName || name, ' ',
        el('span', { class: `tagent-status ${st}`, text: st === 'working' ? '● working' : '○ idle' })),
      el('div', { class: 'kv' }, el('span', { class: 'label', text: 'harness' }),
        el('div', {}, el('span', { class: 'harness-badge', text: harnessLabel(rec) }))),
      el('div', { class: 'kv' }, el('span', { class: 'label', text: 'role' }),
        el('div', { class: 'dim', text: (rec.role || '').slice(0, 120) || '(none)' })),
      el('div', { class: 'kv' }, el('span', { class: 'label', text: 'current task' }),
        el('div', { text: TEAM.task || '(idle)' })),
      el('div', { class: 'kv' }, el('span', { class: 'label', text: 'recent activity' }),
        acts.length ? acts.map((a) => el('div', { class: 'activity', text: '▸ ' + a }))
          : el('div', { class: 'dim', text: 'no activity yet' })));
  }

  function teamFeedAdd(...kids) {
    feed.prepend(el('li', {}, ...kids));
    while (feed.children.length > 40) feed.removeChild(feed.lastChild);
  }

  function pulseAgent(name) {
    const b = canvas.querySelector(`.tagent[data-agent="${CSS.escape(name)}"]`);
    if (!b) return;
    b.classList.add('delegating');
    setTimeout(() => b.classList.remove('delegating'), 950);
  }

  function inThisTeam(name) { return !!(TEAM.team && (TEAM.team.agents || []).includes(name)); }

  function setAgentStatus(name, status) {
    TEAM.status[name] = status === 'working' ? 'working' : 'idle';
    const b = canvas.querySelector(`.tagent[data-agent="${CSS.escape(name)}"]`);
    if (b) {
      b.classList.toggle('working', status === 'working');
      b.classList.toggle('idle', status !== 'working');
      const s = b.querySelector('.tagent-status');
      if (s) s.textContent = status === 'working' ? '● working' : '○ idle';
    }
    if (TEAM.selected === name) renderTeamDetail();
  }

  function onTeamEvent(type, d) {
    if (type === 'task.start') {
      TEAM.task = d.title || '(task)';
      teamFeedAdd(el('span', { class: 'who', text: 'task' }), ' started: ' + (d.title || ''));
      renderTeamDetail();
      return;
    }
    if (type === 'task.done') {
      TEAM.task = null;
      teamFeedAdd(el('span', { class: 'who', text: 'task' }), ' ' + (d.status || 'done'));
      renderTeamDetail();
      return;
    }
    if (type === 'agent.status' && inThisTeam(d.agent)) { setAgentStatus(d.agent, d.status); return; }
    if (type === 'turn.start' && inThisTeam(d.agent)) {
      (TEAM.activity[d.agent] = TEAM.activity[d.agent] || []).push('turn started');
      if (TEAM.selected === d.agent) renderTeamDetail();
      return;
    }
    if (type === 'tool.call' && inThisTeam(d.agent)) {
      (TEAM.activity[d.agent] = TEAM.activity[d.agent] || []).push(`tool: ${d.tool}${d.ok === false ? ' ✗' : ''}`);
      teamFeedAdd(el('span', { class: 'who', text: d.agent }), ' ' + d.tool + (d.ok === false ? ' ✗' : ''));
      if (TEAM.selected === d.agent) renderTeamDetail();
      return;
    }
    if (type === 'delegate' && (inThisTeam(d.from) || inThisTeam(d.to))) {
      teamFeedAdd(el('span', { class: 'who', text: d.from || '?' }), ' ',
        el('span', { class: 'arrow', text: '→' }), ' ', el('span', { class: 'who', text: d.to || '?' }));
      if (inThisTeam(d.to)) pulseAgent(d.to);
    }
  }

  async function load() {
    try {
      const [teams, agents] = await Promise.all([api('/teams'), api('/agents')]);
      const byId = {}; for (const a of agents) byId[a.name] = a;
      if (!teams.length) {
        canvas.replaceChildren(el('div', { class: 'empty', text: 'No teams yet — create one in the Teams tab.' }));
        return;
      }
      const cur = sel.value || teams[0].name;
      sel.replaceChildren(...teams.map((t) => el('option', { value: t.name, text: t.displayName || t.name })));
      sel.value = teams.some((t) => t.name === cur) ? cur : teams[0].name;
      TEAM.team = teams.find((t) => t.name === sel.value) || teams[0];
      TEAM.agentsById = byId;
      renderTeamCanvas();
      renderTeamDetail();
    } catch (e) {
      canvas.replaceChildren(el('div', { class: 'empty', text: 'Error: ' + e.message }));
    }
  }
  sel.addEventListener('change', () => load());

  // Join the shared app-level SSE subscription (stream.mjs, Task 6) instead
  // of owning a reader. `render` must stay synchronous so this unsubscribe
  // is the value the shell captures as its cleanup — an await here would
  // hand the shell a pending Promise instead (see shell.mjs's `activate`,
  // which calls `panel.render(host)` without awaiting it).
  const off = subscribe((type, d) => onTeamEvent(type, d));
  load(); // fire-and-forget; failures render inline via the catch above
  return () => {
    disposed = true;
    if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
    off();
    window.removeEventListener('resize', onResize);
  };
}
