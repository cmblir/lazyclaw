// sandbox.mjs — v4 compat shim. Real implementations live under
// sandbox/. Kept so providers/{claude_cli,codex_cli,gemini_cli}.mjs
// can keep their `import { spawnSandboxed } from '../sandbox.mjs'`
// statements unchanged during the v5 phase rollout.

export {
  parseSandboxSpec,
  buildDockerArgs,
} from './sandbox/docker.mjs';
// spawnSandboxed now comes from the unified dispatcher, which adds
// {kind:'local'} confiner support on top of the byte-identical null/docker
// paths. bash.mjs + the 3 CLI providers import it via this shim, so they
// transparently get the upgraded dispatcher.
export { spawnSandboxed, spawnSyncSandboxed } from './sandbox/spawn.mjs';
export { SandboxError } from './sandbox/base.mjs';
