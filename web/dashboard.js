// web/dashboard.js — the dashboard entry. Everything real lives in /ui.
import { mount } from '/ui/shell.mjs';
import { connect } from '/ui/stream.mjs';
import { mountPalette } from '/ui/palette.mjs';

import * as chat from '/ui/panels/chat.mjs';
import * as tasks from '/ui/panels/tasks.mjs';
import * as sessions from '/ui/panels/sessions.mjs';
import * as agents from '/ui/panels/agents.mjs';
import * as teams from '/ui/panels/teams.mjs';
import * as team from '/ui/panels/team.mjs';
import * as workflows from '/ui/panels/workflows.mjs';
import * as scheduling from '/ui/panels/scheduling.mjs';
import * as trainer from '/ui/panels/trainer.mjs';
import * as skills from '/ui/panels/skills.mjs';
import * as recall from '/ui/panels/recall.mjs';
import * as sandbox from '/ui/panels/sandbox.mjs';
import * as approvals from '/ui/panels/approvals.mjs';
import * as gateway from '/ui/panels/gateway.mjs';
import * as providers from '/ui/panels/providers.mjs';
import * as rates from '/ui/panels/rates.mjs';
import * as metrics from '/ui/panels/metrics.mjs';
import * as doctor from '/ui/panels/doctor.mjs';
import * as config from '/ui/panels/config.mjs';
import * as status from '/ui/panels/status.mjs';
import * as channels from '/ui/panels/channels.mjs';

mount({ panels: {
  chat, tasks, sessions, agents, teams, team, workflows, scheduling, trainer,
  skills, recall, sandbox, approvals, gateway, providers, rates, metrics,
  doctor, config, status, channels,
} });

// Team- and agent-specific entries (task-9-brief.md Step 5's `cachedTeams` /
// `cachedAgents` maps) are not wired in here: they would need a boot-time
// `GET /teams` + `GET /agents` cache plus exported selectTeam/selectAgent
// hooks from panels/team.mjs — and a way to hand a "select this one" argument
// through shell.mjs's `panel.render(host)` contract, which takes no such
// argument today. None of Tasks 1-8 built that, so wiring it here would be
// inventing cross-module API on the spot rather than following one that
// exists; flagged in task-9-report.md instead. The four static actions below
// need none of that — they just point at panel ids `open()` already handles.
mountPalette({
  extraItems: () => [
    { label: 'Start a task', kind: 'run', hint: 'tasks', go: 'tasks' },
    { label: 'New team', kind: 'run', hint: 'teams', go: 'teams' },
    { label: 'Review pending approvals', kind: 'run', hint: 'gateway', go: 'approvals' },
    { label: 'Rebuild search index', kind: 'run', hint: 'doctor', go: 'doctor' },
  ],
});
connect();
