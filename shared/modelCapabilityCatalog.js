const VERIFIED_AT = '2026-08-15'

function verifiedProfile({ provider, contextWindow, maxOutputTokens, sourceUrl, contextWindowType = 'combined' }) {
  return Object.freeze({
    provider,
    contextWindow,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    contextWindowType,
    source: 'official-catalog',
    sourceUrl,
    verifiedAt: VERIFIED_AT,
  })
}

const openAiSource = 'https://platform.openai.com/docs/models/gpt-5.6-sol'
const anthropicSource = 'https://platform.claude.com/docs/en/about-claude/models/overview.md'
const geminiSource = 'https://ai.google.dev/gemini-api/docs/models'
const deepseekSource = 'https://api-docs.deepseek.com/quick_start/pricing/'
const mimoSource = 'https://platform.xiaomimimo.com/'
const openRouterSource = 'https://openrouter.ai/api/v1/models'
const qwenSource = 'https://help.aliyun.com/zh/model-studio/getting-started/models'
const siliconFlowSource = 'https://docs.siliconflow.cn/cn/userguide/models'
const moonshotSource = 'https://platform.moonshot.cn/docs/guide/use-kimi-api'
const zhipuSource = 'https://docs.bigmodel.cn/cn/guide/models'
const xaiSource = 'https://docs.x.ai/developers/models'
const groqSource = 'https://console.groq.com/docs/models'
const mistralSource = 'https://docs.mistral.ai/getting-started/models/models_overview/'

export const OFFICIAL_MODEL_CAPABILITY_CATALOG = Object.freeze({
  'gpt-5.6-sol': verifiedProfile({ provider: 'openai', contextWindow: 1_050_000, maxOutputTokens: 128_000, sourceUrl: openAiSource }),
  'gpt-5.6-terra': verifiedProfile({ provider: 'openai', contextWindow: 1_050_000, maxOutputTokens: 128_000, sourceUrl: openAiSource }),
  'gpt-5.6-luna': verifiedProfile({ provider: 'openai', contextWindow: 1_050_000, maxOutputTokens: 128_000, sourceUrl: openAiSource }),

  'claude-opus-4-8': verifiedProfile({ provider: 'anthropic', contextWindow: 1_000_000, maxOutputTokens: 128_000, sourceUrl: anthropicSource }),
  'claude-sonnet-4-6': verifiedProfile({ provider: 'anthropic', contextWindow: 1_000_000, maxOutputTokens: 128_000, sourceUrl: anthropicSource }),
  'claude-haiku-4-5': verifiedProfile({ provider: 'anthropic', contextWindow: 200_000, maxOutputTokens: 64_000, sourceUrl: anthropicSource }),

  'gemini-3.6-flash': verifiedProfile({ provider: 'gemini', contextWindow: 1_048_576, maxOutputTokens: 65_536, contextWindowType: 'input', sourceUrl: geminiSource }),
  'gemini-3.5-flash': verifiedProfile({ provider: 'gemini', contextWindow: 1_048_576, maxOutputTokens: 65_536, contextWindowType: 'input', sourceUrl: geminiSource }),
  'gemini-3.1-pro-preview': verifiedProfile({ provider: 'gemini', contextWindow: 1_048_576, maxOutputTokens: 65_536, contextWindowType: 'input', sourceUrl: geminiSource }),

  'deepseek-v4-flash': verifiedProfile({ provider: 'deepseek', contextWindow: 1_000_000, maxOutputTokens: 384_000, sourceUrl: deepseekSource }),
  'deepseek-v4-flash-0731': verifiedProfile({ provider: 'deepseek', contextWindow: 1_000_000, maxOutputTokens: 384_000, sourceUrl: deepseekSource }),
  'deepseek-v4-pro': verifiedProfile({ provider: 'deepseek', contextWindow: 1_000_000, maxOutputTokens: 384_000, sourceUrl: deepseekSource }),

  'mimo-v2.5': verifiedProfile({ provider: 'mimo', contextWindow: 1_000_000, sourceUrl: mimoSource }),
  'mimo-v2.5-pro': verifiedProfile({ provider: 'mimo', contextWindow: 1_000_000, sourceUrl: mimoSource }),

  'openai/gpt-5.6-sol': verifiedProfile({ provider: 'openrouter', contextWindow: 1_050_000, maxOutputTokens: 128_000, sourceUrl: openRouterSource }),
  'anthropic/claude-opus-4.8': verifiedProfile({ provider: 'openrouter', contextWindow: 1_000_000, maxOutputTokens: 128_000, sourceUrl: openRouterSource }),
  'google/gemini-3.1-pro-preview': verifiedProfile({ provider: 'openrouter', contextWindow: 1_048_576, maxOutputTokens: 65_536, contextWindowType: 'input', sourceUrl: openRouterSource }),

  'qwen3.8-max': verifiedProfile({ provider: 'qwen', contextWindow: 1_000_000, maxOutputTokens: 131_072, sourceUrl: qwenSource }),
  'qwen3.7-plus': verifiedProfile({ provider: 'qwen', contextWindow: 1_000_000, maxOutputTokens: 131_072, sourceUrl: qwenSource }),
  'qwen3.7-flash': verifiedProfile({ provider: 'qwen', contextWindow: 1_000_000, maxOutputTokens: 65_536, sourceUrl: qwenSource }),

  'deepseek-ai/DeepSeek-V3.2': verifiedProfile({ provider: 'siliconflow', contextWindow: 163_840, maxOutputTokens: 65_536, sourceUrl: siliconFlowSource }),
  'Qwen/Qwen3-Next-80B-A3B-Instruct': verifiedProfile({ provider: 'siliconflow', contextWindow: 262_144, sourceUrl: siliconFlowSource }),
  'moonshotai/Kimi-K2.5': verifiedProfile({ provider: 'siliconflow', contextWindow: 262_144, sourceUrl: siliconFlowSource }),

  'kimi-k3': verifiedProfile({ provider: 'moonshot', contextWindow: 1_048_576, sourceUrl: moonshotSource }),
  'kimi-k2.6': verifiedProfile({ provider: 'moonshot', contextWindow: 262_144, sourceUrl: moonshotSource }),
  'kimi-k2.5': verifiedProfile({ provider: 'moonshot', contextWindow: 262_144, sourceUrl: moonshotSource }),
  'kimi-k2-thinking': verifiedProfile({ provider: 'moonshot', contextWindow: 262_144, maxOutputTokens: 100_352, sourceUrl: moonshotSource }),
  'moonshot-v1-128k': verifiedProfile({ provider: 'moonshot', contextWindow: 131_072, sourceUrl: moonshotSource }),

  'glm-5': verifiedProfile({ provider: 'zhipu', contextWindow: 204_800, maxOutputTokens: 128_000, sourceUrl: zhipuSource }),
  'glm-5-flash': verifiedProfile({ provider: 'zhipu', contextWindow: 204_800, maxOutputTokens: 128_000, sourceUrl: zhipuSource }),
  'glm-4.6v': verifiedProfile({ provider: 'zhipu', contextWindow: 131_072, maxOutputTokens: 32_768, sourceUrl: zhipuSource }),

  'grok-4.6': verifiedProfile({ provider: 'xai', contextWindow: 500_000, sourceUrl: xaiSource }),
  'grok-4.5': verifiedProfile({ provider: 'xai', contextWindow: 500_000, sourceUrl: xaiSource }),
  'grok-4.3': verifiedProfile({ provider: 'xai', contextWindow: 1_000_000, sourceUrl: xaiSource }),

  'openai/gpt-oss-120b': verifiedProfile({ provider: 'groq', contextWindow: 131_072, maxOutputTokens: 65_536, sourceUrl: groqSource }),
  'moonshotai/kimi-k2-instruct-0905': verifiedProfile({ provider: 'groq', contextWindow: 262_144, sourceUrl: groqSource }),
  'llama-3.3-70b-versatile': verifiedProfile({ provider: 'groq', contextWindow: 131_072, maxOutputTokens: 32_768, sourceUrl: groqSource }),

  'mistral-large-latest': verifiedProfile({ provider: 'mistral', contextWindow: 262_144, sourceUrl: mistralSource }),
  'magistral-medium-latest': verifiedProfile({ provider: 'mistral', contextWindow: 131_072, sourceUrl: mistralSource }),
  'codestral-latest': verifiedProfile({ provider: 'mistral', contextWindow: 256_000, sourceUrl: mistralSource }),
})

export function getOfficialModelProfile(modelName = '') {
  const exactName = String(modelName || '').trim()
  return OFFICIAL_MODEL_CAPABILITY_CATALOG[exactName] || null
}
