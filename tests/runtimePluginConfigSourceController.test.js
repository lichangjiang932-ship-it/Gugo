import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createRuntimePluginConfigSourceController } from '../server/plugins/runtimePluginConfigSourceController.js'

function layerSources(value) {
  return [{
    source: 'owner',
    layers: [{
      id: 'owner-settings',
      kind: 'profile',
      priority: 10,
      plugins: { sample: { value } },
    }],
  }]
}

test('runtime plugin config sources initialize before installation and retain resolver replacement', () => {
  const controller = createRuntimePluginConfigSourceController({
    configLayers: [],
    configLayerSources: layerSources(1),
  })

  assert.equal(controller.getActiveResolver().resolve('sample').config.value, 1)
  assert.equal(controller.initialize(layerSources(2)), true)
  assert.equal(controller.getActiveResolver().resolve('sample').config.value, 2)

  const replacement = controller.getActiveResolver().withLayerSources(layerSources(3))
  controller.replaceActiveResolver(replacement)
  assert.strictEqual(controller.getActiveResolver(), replacement)
})

test('runtime plugin config sources fail closed after installation seals them', () => {
  const controller = createRuntimePluginConfigSourceController({ configLayers: [] })
  controller.seal()

  assert.throws(
    () => controller.initialize([]),
    (error) => error?.code === 'PLUGIN_CONFIG_INITIALIZATION_TOO_LATE'
      && error?.retryable === false,
  )
})

test('runtime plugin registry delegates configuration-source state to its focused controller', () => {
  const registrySource = readFileSync(
    new URL('../server/plugins/runtimePluginRegistry.js', import.meta.url),
    'utf8',
  )

  assert.match(registrySource, /createRuntimePluginConfigSourceController/u)
  assert.doesNotMatch(registrySource, /createPluginConfigResolver/u)
  assert.doesNotMatch(registrySource, /configLayerSourcesSealed/u)
  assert.doesNotMatch(registrySource, /PLUGIN_CONFIG_INITIALIZATION_TOO_LATE/u)
})
