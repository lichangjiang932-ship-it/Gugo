import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimePluginInstallController } from '../server/plugins/runtimePluginInstallController.js'

test('install controller revalidates after setup and only removes its own failed record', async () => {
  const order = []
  const plugins = new Map()
  const sentinel = new Error('compatibility changed during setup')
  const replacement = Object.freeze({ state: 'active' })
  const manifest = Object.freeze({
    id: 'racing-plugin',
    version: '1.0.0',
    configSchema: null,
  })
  const record = {
    cancelRequested: false,
    managedContributions: [],
    revocationErrors: [],
    state: 'installing',
  }
  let compatibilityChecks = 0
  let activationCalls = 0
  let removeCalls = 0
  let snapshotCalls = 0
  let settled = false

  const { registerPlugin } = createRuntimePluginInstallController({
    activateManagedContributions: async () => {
      activationCalls += 1
    },
    assertManifestCompatible: (candidate) => {
      assert.equal(candidate, manifest)
      compatibilityChecks += 1
      order.push(`compatibility:${compatibilityChecks}`)
      if (compatibilityChecks === 2) throw sentinel
    },
    createContextForRecord: (candidate) => {
      assert.equal(candidate, record)
      return Object.freeze({})
    },
    createPluginRecord: (input) => {
      assert.equal(input.manifest, manifest)
      return record
    },
    disposePluginEffects: async (candidate) => {
      assert.equal(candidate, record)
      order.push('dispose')
      return []
    },
    emitAudit: (event) => order.push(`audit:${event}`),
    getActivePluginConfigResolver: () => ({
      resolve: () => Object.freeze({ config: Object.freeze({}) }),
    }),
    getPlugin: (id) => {
      order.push('remove-check')
      return plugins.get(id)
    },
    hasPlugin: (id) => plugins.has(id),
    invokePluginSetup: async (candidate, setup, context) => {
      assert.equal(candidate, record)
      order.push('setup')
      await setup(context)
    },
    isShuttingDown: () => false,
    normalizeManifest: (candidate) => {
      assert.equal(candidate, manifest)
      return manifest
    },
    publishPlugin: (id, candidate) => {
      order.push('publish')
      plugins.set(id, candidate)
    },
    removePlugin: (id) => {
      removeCalls += 1
      return plugins.delete(id)
    },
    revokeVisibleEffects: async (candidate) => {
      assert.equal(candidate, record)
      order.push('revoke')
      plugins.set(manifest.id, replacement)
    },
    sealConfigLayerSources: () => order.push('seal-config'),
    snapshotPlugin: () => {
      snapshotCalls += 1
    },
  })

  const install = registerPlugin(manifest, async () => {})
  record.installSettled.then(() => {
    settled = true
  })

  await assert.rejects(install, (error) => error === sentinel)
  await record.installSettled

  assert.equal(compatibilityChecks, 2)
  assert.equal(activationCalls, 0)
  assert.equal(removeCalls, 0)
  assert.equal(snapshotCalls, 0)
  assert.equal(settled, true)
  assert.equal(plugins.get(manifest.id), replacement)
  for (const [before, after] of [
    ['compatibility:1', 'publish'],
    ['publish', 'setup'],
    ['setup', 'compatibility:2'],
    ['compatibility:2', 'revoke'],
    ['revoke', 'dispose'],
    ['dispose', 'remove-check'],
  ]) {
    assert.ok(order.indexOf(before) < order.indexOf(after), `${before} must precede ${after}`)
  }
})
