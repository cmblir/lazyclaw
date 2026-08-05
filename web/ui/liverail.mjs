// web/ui/liverail.mjs — the strip under the topbar. The only ambient motion in
// the shell lives here, and it is the one place a user sees that something is
// happening without having opened the panel it happened in.
import { el } from './dom.mjs';
import { subscribe } from './stream.mjs';
import { reduced } from './motion.mjs';

// Formats an amount in the event's OWN currency rather than a hard-coded
// '$', so a KRW/EUR rate card isn't mislabelled as USD in the topbar.
function fmtMoney(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(Number(amount) || 0);
  } catch {
    // Intl.NumberFormat throws (RangeError) on a currency code it doesn't
    // recognize — fall back to a plain, labelled number rather than losing
    // the amount entirely.
    return `${Number(amount) || 0} ${currency || 'USD'}`;
  }
}

// `cap: null` means "no cap configured" for this currency (see
// daemon/lib/cost.mjs's makeTeamUsageAccountant) and must read differently
// from a cap of zero — collapsing the two would tell an operator who set a
// real zero-cap the same thing as one who set no cap at all.
function capText(cap, currency) {
  return cap == null ? 'no cap' : 'cap ' + fmtMoney(cap, currency);
}

function describe(type, d) {
  switch (type) {
    case 'delegate': return [{ b: d.from }, { arrow: true }, { b: d.to }];
    case 'tool.call': return [{ b: d.agent }, { t: ' ' + d.tool }];
    case 'turn.end': return [{ b: d.agent }, { t: ' finished' }];
    case 'agent.status': return [{ b: d.agent }, { t: ' → ' + d.status }];
    case 'task.start': return [{ t: 'task started: ' }, { b: d.title || d.taskId }];
    case 'task.done': return [{ b: d.taskId }, { t: ' ' + (d.status || 'done') }];
    case 'workflow.step': return [{ b: d.node }, { t: ` ${d.done} of ${d.total} done` }];
    case 'cost.tick': return [{ t: 'spend today ' }, { b: fmtMoney(d.total, d.currency) }, { t: ' · ' + capText(d.cap, d.currency) }];
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
    // Backstop: the ticker must hold at most the outgoing tick plus the
    // incoming one. Every branch below only ever reaches ONE prior node —
    // `ticker.lastElementChild` — so if an earlier node's exit animation
    // never completes (hidden tab, some future CSS rename of tick-out's
    // animation-name, anything), nothing here retries it: the very next
    // event promotes a NEWER node to `lastElementChild` and the stale one is
    // never looked at again by this closure. Without an unconditional prune,
    // a dashboard left open in a background tab — the normal way this
    // project expects to be used, not an edge case; see Task 5's
    // watchVisibility() deliberately treating a hidden document as the
    // ambient-off state — leaks one permanently-orphaned, absolutely
    // positioned div per event, forever. This loop makes the bound
    // structural instead of dependent on an animation event firing.
    while (ticker.childElementCount > 1) ticker.firstElementChild.remove();

    // The outgoing tick must finish before the incoming one starts: both are
    // absolutely positioned in a 40px band and overlapping text is unreadable.
    const prev = ticker.lastElementChild;
    if (prev) {
      prev.classList.remove('enter');
      prev.classList.add('exit');
      // A hidden document — the background-tab case above — suspends or
      // indefinitely delays Chromium's animation event dispatch even though
      // the animation's own timeline still reports 'finished', so waiting
      // for animationend here would strand `prev` until the backstop's next
      // cycle. Remove it synchronously, same as reduced-motion.
      if (reduced() || document.visibilityState === 'hidden') prev.remove();
      else prev.addEventListener('animationend', () => prev.remove(), { once: true });
    }
    ticker.append(el('div', { class: 'tick enter' },
      el('span', { class: 'type', text: type }),
      el('span', { class: 'body' }, d.team ? [el('b', { text: d.team }), ' · '] : null, nodes(describe(type, d)))));

    if (type === 'cost.tick') {
      document.getElementById('rs-cost').textContent = fmtMoney(d.total, d.currency) + ' · ' + capText(d.cap, d.currency);
    }
  });
}
