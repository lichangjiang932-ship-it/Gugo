import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizePluginManifest } from '../shared/pluginManifest.js'
import { normalizeRuntimePluginManifest } from '../server/plugins/pluginLifecycle.js'

test('runtime and trusted UI plugins share one immutable manifest envelope', () => {
  const input = {
    id: 'shared-envelope',
    name: 'Shared envelope',
    version: '1.2.3',
    requires: ['base-plugin'],
    contributes: ['tool:example', 'ui:route:example-route'],
  }
  const shared = normalizePluginManifest(input)
  const runtime = normalizeRuntimePluginManifest(input)

  assert.deepEqual(runtime, shared)
  assert.equal(Object.isFrozen(shared), true)
  assert.equal(Object.isFrozen(shared.requires), true)
  assert.equal(Object.isFrozen(shared.contributes), true)
  assert.throws(() => shared.requires.push('forged-plugin'), TypeError)
  assert.throws(() => shared.contributes.splice(0), TypeError)
})

test('shared plugin manifests fail closed for invalid identity, version, dependencies, and declarations', () => {
  const valid = { id: 'valid-plugin', name: 'Valid plugin', version: '1.0.0' }
  assert.throws(() => normalizePluginManifest({ ...valid, id: 'Invalid ID' }), /plugin id/)
  assert.throws(() => normalizePluginManifest({ ...valid, version: 'latest' }), /valid semver/)
  assert.throws(() => normalizePluginManifest({ ...valid, requires: ['valid-plugin'] }), /cannot require itself/)
  assert.throws(() => normalizePluginManifest({ ...valid, requires: ['base', 'base'] }), /must not contain duplicates/)
  assert.throws(() => normalizePluginManifest({ ...valid, contributes: [''] }), /non-empty strings/)
})
