// sandbox.mjs — v4 compat shim. Real implementations live under
// sandbox/. Kept so providers/{claude_cli,codex_cli,gemini_cli}.mjs
// can keep their `import { spawnSandboxed } from '../sandbox.mjs'`
// statements unchanged during the v5 phase rollout.

export {
  parseSandboxSpec,
  buildDockerArgs,
  spawnSandboxed,
} from './sandbox/docker.mjs';
export { SandboxError } from './sandbox/base.mjs';
