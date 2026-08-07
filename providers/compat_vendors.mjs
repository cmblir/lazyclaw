// providers/compat_vendors.mjs — the built-in OpenAI-compatible vendor
// catalogue, split out of registry.mjs (file-size ratchet). Pure data:
// registry.mjs imports this and expands it into PROVIDERS / PROVIDER_INFO.

// Built-in OpenAI-compatible vendors. Same wire format → one factory call
// each. The picker treats these like first-class providers so users don't
// have to walk through "+ Add a custom endpoint" for the popular ones.
//
// Each entry must define baseUrl + envKey (the env var the chat path
// consults when no api-key is configured) + suggestedModels (curated list
// shown before the user fetches the live /v1/models catalogue).
//
// Adding a new vendor: drop a row here. The PROVIDERS / PROVIDER_INFO loops
// below pick it up automatically.
export const OPENAI_COMPAT_BUILTINS = {
  nim: {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envKey: 'NVIDIA_API_KEY',
    altEnvKeys: ['NIM_API_KEY'],
    keyPrefix: 'nvapi-',
    docs: 'NVIDIA NIM hosted catalogue (Llama 3.x, Nemotron, DeepSeek-R1, Mixtral, Phi-3, Qwen, etc.). Auth: NVIDIA_API_KEY env var or in-app api-key. Endpoint speaks the OpenAI v1 wire format.',
    defaultModel: 'meta/llama-3.1-405b-instruct',
    suggestedModels: [
      'meta/llama-3.1-405b-instruct',
      'meta/llama-3.1-70b-instruct',
      'meta/llama-3.1-8b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'nvidia/nemotron-mini-4b-instruct',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'mistralai/mistral-nemo-12b-instruct',
      'mistralai/mixtral-8x22b-instruct-v0.1',
      'microsoft/phi-3-medium-4k-instruct',
      'deepseek-ai/deepseek-r1',
      'qwen/qwen2.5-7b-instruct',
      'qwen/qwen2.5-coder-32b-instruct',
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    keyPrefix: 'sk-or-',
    docs: 'OpenRouter unified gateway — 200+ models behind one OpenAI-compatible endpoint. Auth: OPENROUTER_API_KEY env var or in-app api-key. Uses x-title/HTTP-Referer headers for attribution.',
    defaultModel: 'anthropic/claude-3.5-sonnet',
    headers: { 'http-referer': 'https://github.com/cmblir/lazyclaude', 'x-title': 'pompos' },
    suggestedModels: [
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3-opus',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'openai/o1-preview',
      'meta-llama/llama-3.1-405b-instruct',
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.0-flash-exp:free',
      'google/gemini-pro-1.5',
      'deepseek/deepseek-chat',
      'deepseek/deepseek-r1',
      'qwen/qwen-2.5-coder-32b-instruct',
      'mistralai/mistral-large',
    ],
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    keyPrefix: 'gsk_',
    docs: 'Groq LPU inference — fastest-token-per-second tier for Llama / Mixtral / Gemma. Auth: GROQ_API_KEY env var or in-app api-key.',
    defaultModel: 'llama-3.3-70b-versatile',
    suggestedModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-70b-versatile',
      'llama-3.1-8b-instant',
      'llama-3.2-90b-vision-preview',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
      'qwen-2.5-coder-32b',
      'qwen-2.5-32b',
      'deepseek-r1-distill-llama-70b',
    ],
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    envKey: 'TOGETHER_API_KEY',
    docs: 'Together AI hosted inference for open-weight models (Llama, Mixtral, Qwen, DeepSeek, etc.). Auth: TOGETHER_API_KEY env var or in-app api-key.',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    suggestedModels: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
      'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
      'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
      'mistralai/Mixtral-8x22B-Instruct-v0.1',
      'mistralai/Mixtral-8x7B-Instruct-v0.1',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
    ],
  },
  xai: {
    label: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
    altEnvKeys: ['GROK_API_KEY'],
    keyPrefix: 'xai-',
    docs: 'xAI Grok models. Auth: XAI_API_KEY env var or in-app api-key.',
    defaultModel: 'grok-2-latest',
    suggestedModels: [
      'grok-2-latest',
      'grok-2-1212',
      'grok-2-vision-1212',
      'grok-beta',
      'grok-vision-beta',
    ],
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    keyPrefix: 'sk-',
    docs: 'DeepSeek (deepseek-chat / deepseek-reasoner). Auth: DEEPSEEK_API_KEY env var or in-app api-key.',
    defaultModel: 'deepseek-chat',
    suggestedModels: [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-coder',
    ],
  },
  mistral: {
    label: 'Mistral La Plateforme',
    baseUrl: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
    docs: 'Mistral La Plateforme (mistral-large, codestral, ministral, pixtral). Auth: MISTRAL_API_KEY env var or in-app api-key.',
    defaultModel: 'mistral-large-latest',
    suggestedModels: [
      'mistral-large-latest',
      'mistral-small-latest',
      'codestral-latest',
      'ministral-8b-latest',
      'ministral-3b-latest',
      'pixtral-large-latest',
      'open-mistral-nemo',
    ],
  },
  fireworks: {
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    envKey: 'FIREWORKS_API_KEY',
    docs: 'Fireworks AI hosted models. Auth: FIREWORKS_API_KEY env var or in-app api-key.',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    suggestedModels: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/llama-v3p1-405b-instruct',
      'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
      'accounts/fireworks/models/deepseek-r1',
      'accounts/fireworks/models/deepseek-v3',
      'accounts/fireworks/models/mixtral-8x22b-instruct',
    ],
  },
};
