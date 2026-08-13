export const SELECTED_MODEL_STORAGE_KEY = 'your-model-atelier:selected-model:v1'

export function resolveInitialModel(models = [], storedModel = '') {
  if (!Array.isArray(models) || models.length === 0) return ''
  if (storedModel && models.some((model) => model.name === storedModel)) return storedModel
  return models.find((model) => model.active)?.name || models[0]?.name || ''
}

export function resolveSessionModel(models = [], {
  sessionModel = '',
  selectedModel = '',
  storedModel = '',
} = {}) {
  if (!Array.isArray(models) || models.length === 0) return ''
  const allowed = new Set(models.map((model) => model?.name).filter(Boolean))
  for (const candidate of [sessionModel, selectedModel, storedModel]) {
    if (candidate && allowed.has(candidate)) return candidate
  }
  return resolveInitialModel(models)
}

export function withSessionModel(sessions = [], sessionId = '', modelName = '', updatedAt = Date.now()) {
  if (!Array.isArray(sessions) || !sessionId || !String(modelName || '').trim()) return sessions
  const normalizedModel = String(modelName).trim()
  let changed = false
  const next = sessions.map((session) => {
    if (session?.id !== sessionId || session.modelName === normalizedModel) return session
    changed = true
    return { ...session, modelName: normalizedModel, updatedAt }
  })
  return changed ? next : sessions
}

export function readStoredModel(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(SELECTED_MODEL_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export function writeStoredModel(modelName, storage = globalThis.localStorage) {
  try {
    if (modelName) storage?.setItem(SELECTED_MODEL_STORAGE_KEY, modelName)
    else storage?.removeItem?.(SELECTED_MODEL_STORAGE_KEY)
  } catch {
    // Ignore storage failures; the selected model still works for this session.
  }
}
