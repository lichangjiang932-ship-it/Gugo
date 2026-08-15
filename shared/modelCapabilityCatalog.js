const VERIFIED_AT = '2026-08-15'

function verifiedProfile({ provider, contextWindow, maxOutputTokens, sourceUrl, contextWindowType = 'combined' }) {
  return Object.freeze({
    provider,
    contextWindow,
    maxOutputTokens,
    contextWindowType,
    source: 'official-catalog',
    sourceUrl,
    verifiedAt: VERIFIED_AT,
  })
}

const anthropicSource = 'https://platform.claude.com/docs/en/about-claude/models/overview.md'
const deepseekSource = 'https://api-docs.deepseek.com/quick_start/pricing/'

export const OFFICIAL_MODEL_CAPABILITY_CATALOG = Object.freeze({
  'gpt-5.6-sol': verifiedProfile({ provider: 'openai', contextWindow: 1_050_000, maxOutputTokens: 128_000, sourceUrl: 'https://platform.openai.com/docs/models/gpt-5.6-sol' }),
  'gpt-5.6-terra': verifiedProfile({ provider: 'openai', contextWindow: 1_050_000, maxOutputTokens: 128_000, sourceUrl: 'https://platform.openai.com/docs/models/gpt-5.6-terra' }),
  'gpt-5.6-luna': verifiedProfile({ provider: 'openai', contextWindow: 1_050_000, maxOutputTokens: 128_000, sourceUrl: 'https://platform.openai.com/docs/models/gpt-5.6-luna' }),
  'claude-opus-4-8': verifiedProfile({ provider: 'anthropic', contextWindow: 1_000_000, maxOutputTokens: 128_000, sourceUrl: anthropicSource }),
  'claude-sonnet-4-6': verifiedProfile({ provider: 'anthropic', contextWindow: 1_000_000, maxOutputTokens: 128_000, sourceUrl: anthropicSource }),
  'claude-haiku-4-5': verifiedProfile({ provider: 'anthropic', contextWindow: 200_000, maxOutputTokens: 64_000, sourceUrl: anthropicSource }),
  'gemini-3.6-flash': verifiedProfile({ provider: 'gemini', contextWindow: 1_048_576, maxOutputTokens: 65_536, contextWindowType: 'input', sourceUrl: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash' }),
  'gemini-3.5-flash': verifiedProfile({ provider: 'gemini', contextWindow: 1_048_576, maxOutputTokens: 65_536, contextWindowType: 'input', sourceUrl: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash' }),
  'gemini-3.1-pro-preview': verifiedProfile({ provider: 'gemini', contextWindow: 1_048_576, maxOutputTokens: 65_536, contextWindowType: 'input', sourceUrl: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview' }),
  'deepseek-v4-flash': verifiedProfile({ provider: 'deepseek', contextWindow: 1_000_000, maxOutputTokens: 384_000, sourceUrl: deepseekSource }),
  'deepseek-v4-pro': verifiedProfile({ provider: 'deepseek', contextWindow: 1_000_000, maxOutputTokens: 384_000, sourceUrl: deepseekSource }),
  'glm-5': verifiedProfile({ provider: 'zhipu', contextWindow: 200_000, maxOutputTokens: 128_000, sourceUrl: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5' }),
})

export function getOfficialModelProfile(modelName = '') {
  const exactName = String(modelName || '').trim()
  return OFFICIAL_MODEL_CAPABILITY_CATALOG[exactName] || null
}
