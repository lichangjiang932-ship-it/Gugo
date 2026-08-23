import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { profileForConfig } from '../server/adapters/modelEndpoint.js'
import { resolveModelConfigForModel } from '../server/adapters/modelProviderConfig.js'
import { reconcileModelRequestWithProvider } from '../server/adapters/modelRequestReconciler.js'

function readAdapterSource(fileName) {
  return readFileSync(new URL(`../server/adapters/${fileName}`, import.meta.url), 'utf8')
}

const reconcilerSource = readAdapterSource('modelRequestReconciler.js')
const dependencySources = [
  readAdapterSource('modelEndpoint.js'),
  readAdapterSource('modelProviderConfig.js'),
]

test('model request reconciler depends on endpoint and provider-config leaves, never the modelProxy facade', () => {
  assert.equal(typeof reconcileModelRequestWithProvider, 'function')
  assert.equal(typeof profileForConfig, 'function')
  assert.equal(typeof resolveModelConfigForModel, 'function')
  assert.match(
    reconcilerSource,
    /from\s+['"]\.\/modelEndpoint\.js['"]/u,
  )
  assert.match(
    reconcilerSource,
    /from\s+['"]\.\/modelProviderConfig\.js['"]/u,
  )
  assert.doesNotMatch(
    reconcilerSource,
    /['"]\.\/modelProxy\.js['"]/u,
  )
  for (const dependencySource of dependencySources) {
    assert.doesNotMatch(
      dependencySource,
      /['"]\.\/(?:modelProxy|modelRequestReconciler)\.js['"]/u,
    )
  }
})
