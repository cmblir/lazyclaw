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
