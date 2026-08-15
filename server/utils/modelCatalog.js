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
    if (!providerByModel.has(entry.name)) {
      providerByModel.set(entry.name, {
        id: entry.provider,
        label: String(entry.providerLabel || '').trim(),
      })
    }
  }
  return uniqueNames.map((name) => {
    const profile = resolveProfile(name)
    const provider = providerByModel.get(name)
    return {
      name,
      active: name === defaultModel,
      ...(provider ? { provider: provider.id } : {}),
      ...(provider?.label ? { providerLabel: provider.label } : {}),
      contextWindow: profile.contextWindow,
      contextWindowSource: profile.contextWindowSource,
      contextWindowEstimated: profile.contextWindowEstimated,
      ...(profile.contextWindowSourceUrl ? { contextWindowSourceUrl: profile.contextWindowSourceUrl } : {}),
      ...(profile.contextWindowVerifiedAt ? { contextWindowVerifiedAt: profile.contextWindowVerifiedAt } : {}),
      ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    }
  })
}
