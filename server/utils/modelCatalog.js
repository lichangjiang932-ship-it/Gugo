function positiveModelLimit(...values) {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  }
  return null
}

export function parseRemoteModelCatalog(data) {
  const items = Array.isArray(data?.data)
    ? data.data
    : (Array.isArray(data?.models) ? data.models : [])
  const remoteModels = []
  const remoteModelProfiles = {}
  for (const item of items.slice(0, 100)) {
    const name = String(item?.id || item?.name || '').trim()
    if (!name || remoteModels.includes(name)) continue
    remoteModels.push(name)
    const contextWindow = positiveModelLimit(
      item?.top_provider?.context_length,
      item?.context_length,
      item?.context_window,
      item?.contextWindow,
      item?.max_context_length,
      item?.max_model_len,
      item?.inputTokenLimit,
      item?.input_token_limit,
      item?.architecture?.context_length,
      item?.architecture?.context_window,
    )
    const maxOutputTokens = positiveModelLimit(
      item?.top_provider?.max_completion_tokens,
      item?.max_completion_tokens,
      item?.max_output_tokens,
      item?.maxOutputTokens,
      item?.outputTokenLimit,
      item?.output_token_limit,
    )
    if (contextWindow || maxOutputTokens) {
      remoteModelProfiles[name] = {
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        source: 'models-endpoint',
      }
    }
  }
  return { remoteModels, remoteModelProfiles }
}

export function buildVisibleModelCatalog({ names = [], defaultModel = '', providerModelEntries = [], resolveProfile }) {
  const uniqueNames = [...new Set(names.length ? names : [defaultModel].filter(Boolean))]
  const providerByModel = new Map()
  for (const entry of providerModelEntries) {
    if (!providerByModel.has(entry.name)) providerByModel.set(entry.name, entry.provider)
  }
  return uniqueNames.map((name) => {
    const profile = resolveProfile(name)
    return {
      name,
      active: name === defaultModel,
      ...(providerByModel.has(name) ? { provider: providerByModel.get(name) } : {}),
      contextWindow: profile.contextWindow,
      contextWindowSource: profile.contextWindowSource,
    }
  })
}
