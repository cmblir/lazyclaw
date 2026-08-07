// tui/orchestrator_setup.mjs — the composite-provider (orchestrator) setup
// wizard, extracted verbatim from tui/pickers.mjs. It builds
// `cfg.orchestrator = { planner, workers, maxSubtasks }` interactively and
// persists it.
//
// CIRCULAR IMPORT: this module imports _arrowMenu / _quickPrompt from
// ./pickers.mjs, and pickers re-exports _setupOrchestratorInteractive from
// here — a pickers ↔ orchestrator_setup cycle. It is safe because both helpers
// are referenced at CALL TIME (inside the function body), never at module load,
// and ES live bindings resolve them once pickers finishes loading. pickers puts
// its re-export line at the bottom (after _arrowMenu/_quickPrompt are declared),
// and both helpers are hoisted top-level function declarations.
import { readConfig, writeConfig } from '../lib/config.mjs';
import { getRegistry } from '../lib/registry_boot.mjs';
import { paint } from './theme.mjs';
import { _arrowMenu, _quickPrompt } from './pickers.mjs';

// Step-3 alternative for composite providers (currently only the
// orchestrator). Builds `cfg.orchestrator = { planner, workers,
// maxSubtasks }` interactively and persists it before returning.
//
// planner: single picker over registered non-composite providers.
// workers: multi-select with a running list + add/remove/done loop.
// maxSubtasks: typed integer, default 5.
export async function _setupOrchestratorInteractive() {
  const accent = (s) => paint('38;5;208', s);
  const dim    = (s) => paint('2', s);
  const bold   = (s) => paint('1', s);
  const ok     = (s) => paint('32', s);
  const info = getRegistry().PROVIDER_INFO || {};
  const eligibleNames = Object.keys(getRegistry().PROVIDERS).filter((n) => n !== 'orchestrator' && n !== 'mock');
  if (eligibleNames.length === 0) {
    process.stdout.write('\n' + accent('orchestrator setup') + ': no eligible workers — register a real provider first.\n');
    await _quickPrompt('  press Enter to continue ');
    return 'CANCEL';
  }
  const cfg = readConfig();
  const existing = cfg.orchestrator && typeof cfg.orchestrator === 'object' ? cfg.orchestrator : {};

  // ── Pick planner ─────────────────────────────────────────────────
  const plannerItems = eligibleNames.map((name) => {
    const m = info[name] || {};
    const defaultModel = m.defaultModel || '';
    return {
      id: `${name}${defaultModel ? ':' + defaultModel : ''}`,
      label: m.label && m.label !== name ? `${name} — ${m.label}` : name,
      desc: defaultModel ? `default model: ${defaultModel}` : '',
    };
  });
  const plannerPick = await _arrowMenu({
    title: 'Pompos setup — Step 3 of 3:  orchestrator — pick the planner',
    subtitle: 'The planner decomposes the user request into subtasks and writes the final synthesis. Strong reasoning models work best here.',
    items: plannerItems,
    searchable: true,
    defaultIdx: Math.max(0, plannerItems.findIndex((p) => p.id === existing.planner)),
  });
  if (plannerPick === 'CANCEL') return 'CANCEL';
  if (plannerPick === 'BACK')   return 'BACK';
  const planner = plannerPick.id;

  // ── Pick workers (iterative add/remove) ──────────────────────────
  const workers = Array.isArray(existing.workers) ? existing.workers.slice() : [];
  while (true) {
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(accent('Orchestrator workers') + '\n');
    process.stdout.write(dim('Subtasks are dispatched round-robin across this list.') + '\n\n');
    if (workers.length === 0) {
      process.stdout.write('  ' + dim('(none yet — add at least one)') + '\n\n');
    } else {
      workers.forEach((w, i) => {
        process.stdout.write(`  ${i + 1}. ${ok(w)}\n`);
      });
      process.stdout.write('\n');
    }
    const items = [
      { id: '__add__',    label: '+ Add a worker',     desc: 'pick from registered providers' },
      { id: '__remove__', label: '- Remove a worker',  desc: workers.length ? 'pick which entry to drop' : '(nothing to remove)' },
      { id: '__done__',   label: `Done${workers.length ? ` (${workers.length} worker${workers.length === 1 ? '' : 's'})` : ' — at least one worker required'}`, desc: workers.length ? 'save cfg.orchestrator and finish' : 'add one worker first' },
    ];
    const action = await _arrowMenu({
      title: 'Pompos setup — orchestrator workers',
      subtitle: `Planner: ${planner}`,
      items,
    });
    if (action === 'CANCEL') return 'CANCEL';
    if (action === 'BACK')   return 'BACK';
    if (action.id === '__add__') {
      const wPick = await _arrowMenu({
        title: 'Add worker',
        subtitle: 'Picked entries are appended to the workers list.',
        items: plannerItems.filter((p) => !workers.includes(p.id)),
        searchable: true,
      });
      if (wPick === 'CANCEL' || wPick === 'BACK') continue;
      workers.push(wPick.id);
      continue;
    }
    if (action.id === '__remove__') {
      if (!workers.length) continue;
      const rPick = await _arrowMenu({
        title: 'Remove worker',
        subtitle: 'Highlighted entry is removed from the list.',
        items: workers.map((w) => ({ id: w, label: w })),
      });
      if (rPick === 'CANCEL' || rPick === 'BACK') continue;
      const idx = workers.indexOf(rPick.id);
      if (idx >= 0) workers.splice(idx, 1);
      continue;
    }
    if (action.id === '__done__') {
      if (workers.length === 0) continue;
      break;
    }
  }

  // ── maxSubtasks ──────────────────────────────────────────────────
  const defaultMax = Number.isFinite(existing.maxSubtasks) && existing.maxSubtasks > 0
    ? Math.min(10, existing.maxSubtasks)
    : 5;
  const rawMax = (await _quickPrompt(`  ${bold('maxSubtasks')} ${dim(`(2..10, blank → ${defaultMax}):`)} `)).trim();
  let maxSubtasks = defaultMax;
  if (rawMax) {
    const n = parseInt(rawMax, 10);
    if (Number.isFinite(n) && n >= 1) maxSubtasks = Math.min(10, Math.max(1, n));
  }

  // ── Persist ──────────────────────────────────────────────────────
  cfg.orchestrator = { planner, workers, maxSubtasks };
  writeConfig(cfg);
  process.stdout.write('\n');
  process.stdout.write(`  ${ok('✓ orchestrator saved')}  ${dim('→')} ` +
    `planner ${ok(planner)}  ·  ${workers.length} worker${workers.length === 1 ? '' : 's'}  ·  maxSubtasks ${maxSubtasks}\n`);
  await _quickPrompt('  press Enter to continue ');
  return { ok: true };
}
