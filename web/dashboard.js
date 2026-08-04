// web/dashboard.js — the dashboard entry. Everything real lives in /ui.
//
// palette.mjs (Task 9) doesn't exist yet — its import and mountPalette()
// call are omitted rather than stubbed, per this task's brief: a stub file
// left behind is worse than an import added later.
import { mount } from '/ui/shell.mjs';
import { connect } from '/ui/stream.mjs';

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
connect();
