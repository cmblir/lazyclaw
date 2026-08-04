// web/ui/panels/team.mjs — real-time view of an agent team: avatar tiles with
// status rings + harness badges, click-to-drill-down, and live A→B
// delegation pulses, driven by the app-level SSE subscription in stream.mjs
// (Task 6) rather than owning its own reader. Pure avatar/tree helpers live
// in ../team_tree.mjs (kept out of this file for the 500-line size gate;
// Task 8's command palette needs that module too).
import { el, phead } from '../dom.mjs';
import { api } from '../api.mjs';
import { harnessLabel, avatarGlyph, avatarSrc, buildTeamTree } from '../team_tree.mjs';
import { subscribe } from '../stream.mjs';

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

  function renderAgentTile(name) {
    const rec = TEAM.agentsById[name] || { name };
    const st = TEAM.status[name] || 'idle';
    const img = el('img', { src: avatarSrc(rec), alt: '', onerror: (e) => e.target.remove() });
    return el('button', {
      class: `tagent ${st}`, 'data-agent': name, role: 'treeitem',
      'aria-selected': String(TEAM.selected === name), onclick: () => selectTeamAgent(name),
    },
      el('div', { class: 'tagent-avatar', 'aria-hidden': 'true' },
        el('span', { class: 'tagent-glyph', text: avatarGlyph(rec) }), img),
      el('div', { class: 'tagent-name', text: rec.displayName || name }),
      el('div', { class: 'tagent-status', text: st === 'working' ? '● working' : '○ idle' }),
      el('div', { class: 'harness-badge', text: harnessLabel(rec) }));
  }

  function renderTeamCanvas() {
    if (!TEAM.team) { canvas.replaceChildren(el('div', { class: 'empty', text: 'No team selected.' })); return; }
    const tree = buildTeamTree(TEAM.team, TEAM.agentsById);
    if (!tree) { canvas.replaceChildren(el('div', { class: 'empty', text: 'This team has no lead.' })); return; }
    const flat = [];
    (function walk(n) { for (const c of n.children) { flat.push(c.name); walk(c); } })(tree);
    const nodes = [el('div', { class: 'team-row' }, renderAgentTile(tree.name))];
    if (flat.length) {
      nodes.push(el('div', { class: 'team-children' },
        el('div', { class: 'team-row' }, flat.map((n) => renderAgentTile(n)))));
    }
    canvas.replaceChildren(...nodes);
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
  return off;
}
