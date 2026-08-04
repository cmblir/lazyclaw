// tests/f-team-tree.test.mjs — the reporting line. teams.mjs stores `manager`
// on the AGENT record and buildTeamTree only honours it when the manager is
// also on that team's roster; renderTeamCanvas read all of that and then
// flattened every descendant into one row. These cases pin the real rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { managerIn, tierRows, reportsOf, chainOf, isDescendant, canReassign }
  from '../web/ui/team_tree.mjs';

const AGENTS = {
  orchestrator: { name: 'orchestrator', manager: null },
  backend:      { name: 'backend',      manager: 'orchestrator' },
  frontend:     { name: 'frontend',     manager: 'orchestrator' },
  reviewer:     { name: 'reviewer',     manager: 'backend' },
  qa:           { name: 'qa',           manager: 'backend' },
  analyst:      { name: 'analyst',      manager: null },
};
const SHIP = { name: 'ship-it', lead: 'orchestrator',
  agents: ['orchestrator', 'backend', 'frontend', 'reviewer', 'qa'] };
// reviewer is on this team too, but its manager (backend) is not.
const RESEARCH = { name: 'research', lead: 'analyst', agents: ['analyst', 'reviewer'] };

test('the lead is the only root', () => {
  assert.equal(managerIn(SHIP, AGENTS.orchestrator), null);
  assert.equal(managerIn(SHIP, AGENTS.backend), 'orchestrator');
});

test('a manager outside the roster falls back to the lead, not to a second root', () => {
  assert.equal(managerIn(RESEARCH, AGENTS.reviewer), 'analyst',
    'buildTeamTree hangs such a member off the lead');
});

test('an agent with no manager at all still hangs off the lead', () => {
  const team = { name: 't', lead: 'analyst', agents: ['analyst', 'orchestrator'] };
  assert.equal(managerIn(team, AGENTS.orchestrator), 'analyst');
});

test('tiers group by depth and order children under their own manager', () => {
  assert.deepEqual(tierRows(SHIP, AGENTS), [
    ['orchestrator'],
    ['backend', 'frontend'],
    ['qa', 'reviewer'],
  ]);
});

test('a manager cycle terminates instead of hanging', () => {
  // The cycle must not involve the lead: managerIn() returns null for the lead
  // before it ever looks at `manager`, so a two-agent team whose lead is inside
  // the cycle has the cycle broken for it and exercises nothing. Keep the lead
  // out of it, and a->b->a is genuinely unreachable from the root — which is
  // what the orphan row at the end of tierRows() exists to catch.
  const cyc = {
    lead: { name: 'lead', manager: null },
    a: { name: 'a', manager: 'b' },
    b: { name: 'b', manager: 'a' },
  };
  const team = { name: 'c', lead: 'lead', agents: ['lead', 'a', 'b'] };
  const rows = tierRows(team, cyc);
  assert.deepEqual(rows[0], ['lead'], 'the root still renders');
  assert.deepEqual(rows.flat().slice(1).sort(), ['a', 'b'],
    'the unreachable pair lands in the orphan row');
  assert.equal(rows.flat().length, 3, 'every member appears exactly once');
});

test('reportsOf and chainOf walk the in-team line', () => {
  assert.deepEqual(reportsOf(SHIP, AGENTS, 'backend').sort(), ['qa', 'reviewer']);
  assert.deepEqual([...chainOf(SHIP, AGENTS, 'reviewer')].sort(),
    ['backend', 'orchestrator', 'reviewer']);
});

test('reassignment refuses a cycle and refuses moving the lead', () => {
  assert.equal(isDescendant(SHIP, AGENTS, 'reviewer', 'backend'), true);
  assert.equal(canReassign(SHIP, AGENTS, 'backend', 'reviewer'), false, 'would cycle');
  assert.equal(canReassign(SHIP, AGENTS, 'orchestrator', 'backend'), false, 'the lead is the root');
  assert.equal(canReassign(SHIP, AGENTS, 'qa', 'frontend'), true);
  assert.equal(canReassign(SHIP, AGENTS, 'qa', 'nobody'), false, 'not on this roster');
});

test("the dedicated lead-guard is not redundant with the cycle check", () => {
  // The assertion above — canReassign(SHIP, ..., 'orchestrator', 'backend')
  // === false — does not actually pin canReassign's `name === team.lead`
  // guard: in SHIP, `backend` IS a descendant of `orchestrator` (it reports
  // straight to it), so the cycle check alone (`!isDescendant(newManager,
  // name)`) already returns false for that data, guard or no guard.
  // Deleting the guard would not fail that test.
  //
  // To actually exercise the guard we need a newManager the cycle check
  // does NOT catch: one sitting in a manager cycle disconnected from the
  // lead, exactly like the tierRows orphan-row fixture above. `a` is
  // unreachable from `lead` (isDescendant walks a->b->a and terminates via
  // its own seen-set before ever reaching `lead`), so without the guard
  // `canReassign(team, cyc, 'lead', 'a')` would fall through to
  // `!isDescendant(...)` and incorrectly return `true`.
  const cyc = {
    lead: { name: 'lead', manager: null },
    a: { name: 'a', manager: 'b' },
    b: { name: 'b', manager: 'a' },
  };
  const team = { name: 'c', lead: 'lead', agents: ['lead', 'a', 'b'] };
  assert.equal(isDescendant(team, cyc, 'a', 'lead'), false,
    'a is unreachable from the lead — the cycle check alone would not block this');
  assert.equal(canReassign(team, cyc, 'lead', 'a'), false,
    'only the dedicated lead-guard blocks this; removing it flips the result to true');
});
