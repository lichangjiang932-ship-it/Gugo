const KNOWN_PROVIDER_LABELS = Object.freeze({
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  qwen: 'Qwen',
  siliconflow: 'SiliconFlow',
  moonshot: 'Moonshot Kimi',
  zhipu: 'Zhipu GLM',
  xai: 'xAI',
  groq: 'Groq',
  mistral: 'Mistral AI',
  ollama: 'Ollama',
  'lm-studio': 'LM Studio',
  llamacpp: 'llama.cpp',
  vllm: 'vLLM',
})

export function modelProviderLabel(provider = '', configuredLabel = '') {
  const label = String(configuredLabel || '').trim()
  if (label) return label
  const id = String(provider || '').trim()
  if (!id) return ''
  const known = KNOWN_PROVIDER_LABELS[id.toLowerCase()]
  if (known) return known
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

export function groupModelOptions(modelOptions = []) {
  const groups = []
  const byProvider = new Map()
  for (const model of modelOptions) {
    const provider = String(model?.provider || '').trim()
    const key = provider || '__default__'
    let group = byProvider.get(key)
    if (!group) {
      group = {
        key,
        provider,
        label: modelProviderLabel(provider, model?.providerLabel),
        models: [],
      }
      byProvider.set(key, group)
      groups.push(group)
    }
    group.models.push(model)
  }
  let startIndex = 0
  return groups.map((group) => {
    const result = { ...group, startIndex }
    startIndex += group.models.length
    return result
  })
}
