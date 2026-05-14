export const SELECTED_MODEL_STORAGE_KEY = 'your-model-atelier:selected-model:v1'

export function resolveInitialModel(models = [], storedModel = '') {
  if (!Array.isArray(models) || models.length === 0) return ''
  if (storedModel && models.some((model) => model.name === storedModel)) return storedModel
  return models.find((model) => model.active)?.name || models[0]?.name || ''
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
  } catch {
    // Ignore storage failures; the selected model still works for this session.
  }
}
