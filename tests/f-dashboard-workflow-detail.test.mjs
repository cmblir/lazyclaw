// Source-level regression tests for three dashboard SPA bugs.
//
// The dashboard ships as a static script with no DOM test harness, so these
// assertions read the workflow-detail source as a string and pin the
// specific regressions. This is a weak guard (it cannot exercise runtime
// behaviour), but it stops the exact pre-fix strings from creeping back in.
//
// dashboard-shell-motion Task 3 replaced web/dashboard.js with a thin shell
// entry point (grouped sidebar + hash router); every panel body, including
// the workflow-detail rendering these tests pin, left the file. Task 4 moves
// it (unchanged) into web/ui/panels/workflows.mjs — recovered verbatim from
// git, not rewritten (Task 3 report, "Panel source for Task 4": `git show
// 236e60fb3bd7a352160bce858e16a023c338769b:web/dashboard.js`). Until that
// file exists there is nowhere in the tree for these regressions to hide or
// resurface, so the checks below are skipped rather than weakened — once
// workflows.mjs lands they run unchanged against it.
//
// BUG 3 is the one exception: the reindex confirm it pins belongs to the
// Doctor panel's FTS5 "Rebuild" button (LOADERS.doctor in the pre-split
// monolith), not workflow-detail rendering — the two just happened to live in
// the same file before Task 3 split it. It moves to web/ui/panels/doctor.mjs,
// so it's gated on that file separately rather than on workflows.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowsPanel = join(here, '..', 'web', 'ui', 'panels', 'workflows.mjs');
const skip = !existsSync(workflowsPanel)
  ? 'workflow-detail rendering moved out of web/dashboard.js in Task 3 and has not yet landed in web/ui/panels/workflows.mjs (Task 4)'
  : false;
const src = skip ? '' : readFileSync(workflowsPanel, 'utf8');

const doctorPanel = join(here, '..', 'web', 'ui', 'panels', 'doctor.mjs');
const doctorSkip = !existsSync(doctorPanel)
  ? 'doctor panel (FTS5 rebuild confirm) has not yet landed in web/ui/panels/doctor.mjs (Task 4)'
  : false;
const doctorSrc = doctorSkip ? '' : readFileSync(doctorPanel, 'utf8');

test('BUG 1: workflow detail reads .nodes (not nodeResults)', { skip }, () => {
  // GET /workflows/<id> returns the per-node map under `nodes`
  // (daemon/routes/workflows.mjs returns `nodes: state.nodes`), so reading
  // `nodeResults` always yields {} and the node table shows empty.
  assert.ok(!/nodeResults/.test(src), 'must not reference the wrong key `nodeResults`');
  assert.match(src, /r\.nodes\b/, 'must read `r.nodes` from the workflow detail response');
});

test('BUG 2: no dead /trajectories/ link (route is deferred / 404s)', { skip }, () => {
  assert.ok(!/\/trajectories\//.test(src), 'must not open a non-existent /trajectories/ route');
  // The per-session Trajectory button/handler is removed entirely.
  assert.ok(!/data-action="trajectory"/.test(src), 'trajectory button must be gone');
});

test('BUG 1b: node status pill matches canonical NodeStatus "success" (not "done")', { skip }, () => {
  // NodeStatus = pending|running|success|failed (workflow/summary.mjs). The
  // pre-fix pill keyed off status === 'done', which never matches, so every
  // completed node rendered as plain unstyled text.
  assert.ok(!/status === 'done'/.test(src), "must not key the pill off the non-existent 'done' status");
  assert.match(src, /status === 'success'/, "completed-node pill must key off 'success'");
});

test('BUG 1c: Done stat shows the success COUNT, not the allDone boolean', { skip }, () => {
  // summary.done is a boolean (allDone); the completed-node count is
  // summary.success. Pre-fix rendered `sm.done ?? 0` (both the detail modal
  // and the list-view progress column), showing true/false instead of a count.
  // The boolean `if (sm.done)` badge uses are correct and stay.
  assert.ok(!/sm\.done \?\? 0/.test(src), 'must not render the boolean sm.done as a count');
  assert.match(src, /sm\.success \?\? 0/, 'completed-node count must render sm.success');
});

test('BUG 3: reindex confirm reflects repopulation, not data loss', { skip: doctorSkip }, () => {
  // The route now calls reindexAll which REPOPULATES from the corpus, so the
  // old "deleted and recreated empty" warning is false and scary.
  assert.ok(
    !/deleted and recreated empty/.test(doctorSrc),
    'reindex confirm must not claim the index is recreated empty',
  );
  assert.match(
    doctorSrc,
    /rebuilt|repopulat|recall/i,
    'reindex confirm must explain recall is rebuilt from the corpus',
  );
});
