// sandbox/index.mjs — config-driven backend resolver.
//
// Spec §0.1 C8 (6-enum), §1.7 (cfg.sandbox additive).
//
// Config schema (additive, all optional):
//
//   sandbox: {
//     default: 'local' | 'docker' | 'ssh' | 'singularity' | 'modal' | 'daytona',
//     local:        { confiner: 'none'|'seatbelt'|'bubblewrap'|'firejail'|'landlock',
//                     readOnly?: string[], readWrite?: string[], allowNet?: boolean },
//     docker:       { image, network?, mounts?: string[], envPassthrough?: string[] },
//     ssh:          { host, user?, port?, identityFile? },
//     singularity:  { image, bind?: string[], net?: boolean, useApptainer?: boolean },
//     modal:        { app, region?, token?, idleWake?: boolean, host? },
//     daytona:      { workspace, persistent?: boolean },
//     bindings:     { '<workerName>': '<kind>' | { kind, ...overrides } },
//   }

import os from 'node:os';
import path from 'node:path';
import { SANDBOX_KINDS, SandboxError } from './base.mjs';
import { LocalSandbox } from './local.mjs';
import { DockerSandbox, parseSandboxSpec } from './docker.mjs';
import { SshSandbox } from './ssh.mjs';
import { SingularitySandbox } from './singularity.mjs';
import { ModalSandbox } from './modal.mjs';
import { DaytonaSandbox } from './daytona.mjs';

const CTORS = {
  local: LocalSandbox,
  docker: DockerSandbox,
  ssh: SshSandbox,
  singularity: SingularitySandbox,
  modal: ModalSandbox,
  daytona: DaytonaSandbox,
};

export function listBackends() { return [...SANDBOX_KINDS]; }

export { parseSandboxSpec };

export function resolveSandbox(cfg, workerName) {
  const sb = (cfg && cfg.sandbox) || {};
  let kind = sb.default || 'local';
  let overrides = {};

  const binding = workerName && sb.bindings && sb.bindings[workerName];
  if (binding) {
    if (typeof binding === 'string') kind = binding;
    else { kind = binding.kind || kind; overrides = binding; }
  }

  if (!CTORS[kind]) {
    throw new SandboxError(
      `unknown sandbox kind "${kind}" — expected one of ${SANDBOX_KINDS.join(', ')}`,
      'SANDBOX_BAD_KIND',
    );
  }

  const sectionDefaults = sb[kind] || {};
  const spec = {
    kind,
    ...(kind === 'local' ? { confiner: 'none' } : {}),
    ...sectionDefaults,
    ...overrides,
    kind,
  };
  return new CTORS[kind](spec);
}

// Directories whose reads are blocked inside a confined child even though reads
// are otherwise allowed — credential stores + the pompos config dir (which
// holds auth profiles and channel tokens).
function defaultDenyRead(homeDir, configDir) {
  const h = homeDir || os.homedir();
  const dirs = [
    path.join(h, '.ssh'),
    path.join(h, '.aws'),
    path.join(h, '.gnupg'),
    path.join(h, '.config', 'gcloud'),
    path.join(h, '.docker'),
    path.join(h, '.kube'),
    path.join(h, '.npmrc'),
    path.join(h, '.netrc'),
  ];
  if (configDir) dirs.push(configDir);
  return dirs;
}

// Build the flat sandbox spec applied BY DEFAULT to sensitive tool execution
// (the tool hot path: bash, python_exec/node_exec, git_*, os_*). Returns null to
// mean "no confinement" (bare host).
//
// Default-on policy (operator-chosen): confine every sensitive child-spawning
// tool, with the filesystem confined to the workspace (cwd) + temp, secret dirs
// unreadable, and network ALLOWED. Opt out with cfg.sandbox.confine === false or
// cfg.sandbox.default of 'off'/'none'. An explicitly-configured docker backend
// is honoured instead of local confinement.
//
// This is threaded in by the production entrypoints (task tick, agentic chat,
// task_spawn); the library defaults of runTool/runAgentTurn stay null so direct
// API callers and unit tests remain byte-stable.
export function defaultSandboxSpec(cfg, { cwd, configDir } = {}) {
  const sb = (cfg && cfg.sandbox) || {};
  if (sb.confine === false || sb.default === 'off' || sb.default === 'none') return null;
  if (sb.default === 'docker' && sb.docker && sb.docker.image) {
    return { kind: 'docker', ...sb.docker };
  }
  return {
    kind: 'local',
    confiner: sb.local?.confiner || 'auto',
    readWrite: [cwd || process.cwd()],
    denyRead: defaultDenyRead(sb.homeDir, configDir),
    allowNet: sb.allowNet !== false,
  };
}
