import { getOfficialModelProfile } from '../../shared/modelCapabilityCatalog.js'
import { bundledModelContextWindow } from './bundledModelCatalog.js'
import { readModelsDevCache } from './modelsDevCache.js'

/** Preserve per-model limits from settings; catalogue metadata only fills gaps. */
export function modelRuntimeProfiles(models = [], env = process.env, providerId = '') {
  const cached = readModelsDevCache(env).models
  return Object.fromEntries(models.filter(model => model && model.enabled !== false).map(model => {
    const id = String(model.id || model)
    const metadata = cached[id] || {}
    const explicitContextWindow = Number(model.contextWindow)
    const cacheContextWindow = Number(metadata.contextWindow)
    // The curated official catalogue is more specific than the bundled
    // models.dev snapshot and already carries its source; leave the endpoint
    // resolver to use it instead of shadowing it with a generic estimate.
    const officialContextWindow = Number(getOfficialModelProfile(id)?.contextWindow)
    const bundledContextWindow = officialContextWindow > 0
      ? null
      : bundledModelContextWindow(id, { providerId })
    const contextWindow = explicitContextWindow > 0
      ? explicitContextWindow
      : cacheContextWindow > 0
        ? cacheContextWindow
        : bundledContextWindow
    const source = explicitContextWindow > 0
      ? (model.contextWindowSource || 'provider_override')
      : cacheContextWindow > 0
        ? 'models.dev'
        : bundledContextWindow
          ? 'bundled_catalog'
          : ''
    const maxOutputTokens = Number(model.maxTokens || metadata.maxTokens)
    return [id, {
      ...(contextWindow > 0 ? {
        contextWindow,
        source,
        contextWindowEstimated: source === 'bundled_catalog',
        // Generated catalogue metadata must not hide an explicit per-model
        // override (a capability flag, for example) for the same id.
        ...(source === 'models.dev' || source === 'bundled_catalog' ? { catalogOnly: true } : {}),
      } : {}),
      ...(maxOutputTokens > 0 ? { maxOutputTokens } : {}),
    }]
  }).filter(([, profile]) => Object.keys(profile).length > 0))
}
