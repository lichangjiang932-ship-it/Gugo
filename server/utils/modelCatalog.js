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
  const fallbackEntries = [...new Set(names.length ? names : [defaultModel].filter(Boolean))]
    .map((name) => ({ name }))
  const sourceEntries = providerModelEntries.length ? providerModelEntries : fallbackEntries
  const seen = new Set()
  let activeAssigned = false
  return sourceEntries.filter((entry) => {
    const name = String(entry?.name || '').trim()
    if (!name) return false
    const provider = String(entry?.provider || '').trim()
    const key = `${provider}\u0000${name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map((entry) => {
    const name = String(entry.name).trim()
    const provider = {
      id: String(entry.provider || '').trim(),
      label: String(entry.providerLabel || '').trim(),
    }
    const profile = resolveProfile(name, provider.id)
    const active = !activeAssigned && name === defaultModel
    if (active) activeAssigned = true
    return {
      name,
      active,
      ...(provider.id ? { provider: provider.id } : {}),
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
