// web/ui/liverail.mjs — the strip under the topbar. The only ambient motion in
// the shell lives here, and it is the one place a user sees that something is
// happening without having opened the panel it happened in.
import { el } from './dom.mjs';
import { subscribe } from './stream.mjs';
import { reduced } from './motion.mjs';

function describe(type, d) {
  switch (type) {
    case 'delegate': return [{ b: d.from }, { arrow: true }, { b: d.to }];
    case 'tool.call': return [{ b: d.agent }, { t: ' ' + d.tool }];
    case 'turn.end': return [{ b: d.agent }, { t: ' finished' }];
    case 'agent.status': return [{ b: d.agent }, { t: ' → ' + d.status }];
    case 'task.start': return [{ t: 'task started: ' }, { b: d.title || d.taskId }];
    case 'task.done': return [{ b: d.taskId }, { t: ' ' + (d.status || 'done') }];
    case 'workflow.step': return [{ b: d.node }, { t: ` ${d.done} of ${d.total} done` }];
    case 'cost.tick': return [{ t: 'spend today ' }, { b: '$' + Number(d.total).toFixed(2) }];
    case 'channel.inbound': return [{ b: d.channel }, { t: ' routed to ' }, { b: d.to }];
    case 'provider.error': return [{ b: d.provider }, { t: ' ' + d.detail }];
    // No `cron.fire` case — a fire happens in a subprocess launchd spawns, so
    // the daemon's bus never sees one. See task-10-brief.md's file-list note.
    case 'exec.approval.requested': return [{ b: d.agentId }, { t: ' wants ' }, { b: d.tool }, { t: ' · awaiting a human' }];
    default: return [{ t: type }];
  }
}

function nodes(parts) {
  const f = document.createDocumentFragment();
  for (const p of parts) {
    if (p.b) f.append(el('b', { text: p.b }));
    else if (p.arrow) f.append(el('span', { class: 'arrow', text: ' → ' }));
    else f.append(document.createTextNode(p.t));
  }
  return f;
}

export function mountLiveRail() {
  const ticker = document.getElementById('ticker');
  subscribe((type, d) => {
    // The outgoing tick must finish before the incoming one starts: both are
    // absolutely positioned in a 40px band and overlapping text is unreadable.
    const prev = ticker.lastElementChild;
    if (prev) {
      prev.classList.remove('enter');
      prev.classList.add('exit');
      prev.addEventListener('animationend', () => prev.remove(), { once: true });
      if (reduced()) prev.remove();     // animationend never fires when animations are off
    }
    ticker.append(el('div', { class: 'tick enter' },
      el('span', { class: 'type', text: type }),
      el('span', { class: 'body' }, d.team ? [el('b', { text: d.team }), ' · '] : null, nodes(describe(type, d)))));

    if (type === 'cost.tick') {
      document.getElementById('rs-cost').textContent = '$' + Number(d.total).toFixed(2);
    }
  });
}
