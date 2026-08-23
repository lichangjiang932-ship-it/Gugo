export const SELECTED_MODEL_STORAGE_KEY = 'your-model-atelier:selected-model:v1'

function normalizedSelection(value = {}) {
  if (typeof value === 'string') return { modelName: value.trim(), providerId: '' }
  return {
    modelName: String(value?.modelName || value?.name || '').trim(),
    providerId: String(value?.providerId || value?.provider || '').trim(),
  }
}

function optionSelection(option = {}) {
  return {
    modelName: String(option?.name || '').trim(),
    providerId: String(option?.provider || option?.providerId || '').trim(),
  }
}

function findSelection(models = [], selection = {}) {
  const normalized = normalizedSelection(selection)
  if (!normalized.modelName) return null
  if (normalized.providerId) {
    return models.find((model) => {
      const candidate = optionSelection(model)
      return candidate.modelName === normalized.modelName && candidate.providerId === normalized.providerId
    }) || null
  }
  return models.find((model) => optionSelection(model).modelName === normalized.modelName) || null
}

export function resolveInitialModelSelection(models = [], storedSelection = '') {
  if (!Array.isArray(models) || models.length === 0) return { modelName: '', providerId: '' }
  const stored = findSelection(models, storedSelection)
  const selected = stored || models.find((model) => model?.active) || models[0]
  return optionSelection(selected)
}

export function resolveInitialModel(models = [], storedModel = '') {
  return resolveInitialModelSelection(models, storedModel).modelName
}

export function resolveSessionModelSelection(models = [], {
  sessionModel = '',
  sessionProviderId = '',
  selectedModel = '',
  selectedProviderId = '',
  storedModel = '',
  storedProviderId = '',
} = {}) {
  if (!Array.isArray(models) || models.length === 0) return { modelName: '', providerId: '' }
  for (const selection of [
    { modelName: sessionModel, providerId: sessionProviderId },
    { modelName: selectedModel, providerId: selectedProviderId },
    { modelName: storedModel, providerId: storedProviderId },
  ]) {
    const matched = findSelection(models, selection)
    if (matched) return optionSelection(matched)
  }
  return resolveInitialModelSelection(models)
}

export function resolveSessionModel(models = [], {
  sessionModel = '',
  selectedModel = '',
  storedModel = '',
} = {}) {
  return resolveSessionModelSelection(models, { sessionModel, selectedModel, storedModel }).modelName
}

export function withSessionModelSelection(
  sessions = [],
  sessionId = '',
  selection = {},
  updatedAt = Date.now(),
) {
  const normalized = normalizedSelection(selection)
  if (!Array.isArray(sessions) || !sessionId || !normalized.modelName) return sessions
  let changed = false
  const next = sessions.map((session) => {
    if (session?.id !== sessionId) return session
    const currentProviderId = String(session.modelProviderId || '').trim()
    if (session.modelName === normalized.modelName && currentProviderId === normalized.providerId) return session
    changed = true
    const sessionWithoutProvider = { ...session }
    delete sessionWithoutProvider.modelProviderId
    return {
      ...sessionWithoutProvider,
      modelName: normalized.modelName,
      ...(normalized.providerId ? { modelProviderId: normalized.providerId } : {}),
      updatedAt,
    }
  })
  return changed ? next : sessions
}

export function withSessionModel(sessions = [], sessionId = '', modelName = '', updatedAt = Date.now()) {
  return withSessionModelSelection(sessions, sessionId, { modelName }, updatedAt)
}

export function readStoredModelSelection(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(SELECTED_MODEL_STORAGE_KEY) || ''
    if (!raw) return { modelName: '', providerId: '' }
    if (!raw.trim().startsWith('{')) return { modelName: raw, providerId: '' }
    return normalizedSelection(JSON.parse(raw))
  } catch {
    return { modelName: '', providerId: '' }
  }
}

export function readStoredModel(storage = globalThis.localStorage) {
  return readStoredModelSelection(storage).modelName
}

export function writeStoredModelSelection(selection, storage = globalThis.localStorage) {
  try {
    const normalized = normalizedSelection(selection)
    if (!normalized.modelName) storage?.removeItem?.(SELECTED_MODEL_STORAGE_KEY)
    else if (normalized.providerId) storage?.setItem(SELECTED_MODEL_STORAGE_KEY, JSON.stringify(normalized))
    else storage?.setItem(SELECTED_MODEL_STORAGE_KEY, normalized.modelName)
  } catch {
    // Ignore storage failures; the selected model still works for this session.
  }
}

export function writeStoredModel(modelName, storage = globalThis.localStorage, providerId = '') {
  writeStoredModelSelection({ modelName, providerId }, storage)
}
