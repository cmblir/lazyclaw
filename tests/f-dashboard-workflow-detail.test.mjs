// Source-level regression tests for three dashboard SPA bugs.
//
// The dashboard ships as a static script with no DOM test harness, so these
// assertions read web/dashboard.js as a string and pin the specific
// regressions. This is a weak guard (it cannot exercise runtime behaviour),
// but it stops the exact pre-fix strings from creeping back in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'web', 'dashboard.js'), 'utf8');

test('BUG 1: workflow detail reads .nodes (not nodeResults)', () => {
  // GET /workflows/<id> returns the per-node map under `nodes`
  // (daemon/routes/workflows.mjs returns `nodes: state.nodes`), so reading
  // `nodeResults` always yields {} and the node table shows empty.
  assert.ok(!/nodeResults/.test(src), 'must not reference the wrong key `nodeResults`');
  assert.match(src, /r\.nodes\b/, 'must read `r.nodes` from the workflow detail response');
});

test('BUG 2: no dead /trajectories/ link (route is deferred / 404s)', () => {
  assert.ok(!/\/trajectories\//.test(src), 'must not open a non-existent /trajectories/ route');
  // The per-session Trajectory button/handler is removed entirely.
  assert.ok(!/data-action="trajectory"/.test(src), 'trajectory button must be gone');
});

test('BUG 1b: node status pill matches canonical NodeStatus "success" (not "done")', () => {
  // NodeStatus = pending|running|success|failed (workflow/summary.mjs). The
  // pre-fix pill keyed off status === 'done', which never matches, so every
  // completed node rendered as plain unstyled text.
  assert.ok(!/status === 'done'/.test(src), "must not key the pill off the non-existent 'done' status");
  assert.match(src, /status === 'success'/, "completed-node pill must key off 'success'");
});

test('BUG 1c: Done stat shows the success COUNT, not the allDone boolean', () => {
  // summary.done is a boolean (allDone); the completed-node count is
  // summary.success. Pre-fix rendered `sm.done ?? 0` (both the detail modal
  // and the list-view progress column), showing true/false instead of a count.
  // The boolean `if (sm.done)` badge uses are correct and stay.
  assert.ok(!/sm\.done \?\? 0/.test(src), 'must not render the boolean sm.done as a count');
  assert.match(src, /sm\.success \?\? 0/, 'completed-node count must render sm.success');
});

test('BUG 3: reindex confirm reflects repopulation, not data loss', () => {
  // The route now calls reindexAll which REPOPULATES from the corpus, so the
  // old "deleted and recreated empty" warning is false and scary.
  assert.ok(
    !/deleted and recreated empty/.test(src),
    'reindex confirm must not claim the index is recreated empty',
  );
  assert.match(
    src,
    /rebuilt|repopulat|recall/i,
    'reindex confirm must explain recall is rebuilt from the corpus',
  );
});
