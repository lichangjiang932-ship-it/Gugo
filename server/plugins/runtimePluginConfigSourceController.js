import { createPluginConfigResolver } from './pluginConfig.js'

export function createRuntimePluginConfigSourceController({
  config,
  configLayers,
  configLayerSources,
} = {}) {
  let activeResolver = createPluginConfigResolver({
    legacyConfig: config,
    layers: configLayers,
    layerSources: configLayerSources,
  })
  let sealed = false

  const initialize = (nextLayerSources) => {
    if (sealed) {
      const error = new Error(
        'runtime plugin configuration sources cannot change after plugin installation begins',
      )
      error.code = 'PLUGIN_CONFIG_INITIALIZATION_TOO_LATE'
      error.retryable = false
      throw error
    }
    activeResolver = activeResolver.withLayerSources(nextLayerSources)
    return true
  }

  return Object.freeze({
    getActiveResolver: () => activeResolver,
    initialize,
    replaceActiveResolver: (resolver) => {
      activeResolver = resolver
    },
    seal: () => {
      sealed = true
    },
  })
}
