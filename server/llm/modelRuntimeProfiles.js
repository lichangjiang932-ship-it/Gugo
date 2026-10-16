import { readModelsDevCache } from './modelsDevCache.js'

/** Preserve per-model limits from settings; catalogue metadata only fills gaps. */
export function modelRuntimeProfiles(models = [], env = process.env) {
  const cached = readModelsDevCache(env).models
  return Object.fromEntries(models.filter(model => model && model.enabled !== false).map(model => {
    const id = String(model.id || model)
    const metadata = cached[id] || {}
    const contextWindow = Number(model.contextWindow || metadata.contextWindow)
    const maxOutputTokens = Number(model.maxTokens || metadata.maxTokens)
    return [id, {
      ...(contextWindow > 0 ? { contextWindow, source: model.contextWindow ? (model.contextWindowSource || 'provider_override') : 'models.dev' } : {}),
      ...(maxOutputTokens > 0 ? { maxOutputTokens } : {}),
    }]
  }))
}
