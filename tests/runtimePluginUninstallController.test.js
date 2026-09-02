import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimePluginUninstallController } from '../server/plugins/runtimePluginUninstallController.js'

test('uninstall controller reselects the current record after a pending reload', async () => {
  const id = 'reloaded-plugin'
  const oldRecord = {
    managedContributions: [],
    revocationErrors: [],
    state: 'active',
  }
  const replacement = {
    managedContributions: [],
    revocationErrors: [],
    state: 'active',
  }
  const plugins = new Map([[id, oldRecord]])
  const operatedRecords = []
  let finishReload
  let pendingReloadReads = 0
  const reload = new Promise((resolve) => {
    finishReload = () => {
      plugins.set(id, replacement)
      resolve()
    }
  })

  const { unregisterPluginUnchecked } = createRuntimePluginUninstallController({
    assertNoDependents: (record, pluginId) => {
      assert.equal(pluginId, id)
      operatedRecords.push(record)
    },
    assertRecordCanDeactivate: (record) => operatedRecords.push(record),
    disposePluginEffects: async (record) => {
      operatedRecords.push(record)
      return []
    },
    emitAudit: () => {},
    getPlugin: (pluginId) => plugins.get(pluginId),
    hasPlugin: (pluginId) => plugins.has(pluginId),
    listPendingReloads: () => {
      pendingReloadReads += 1
      return pendingReloadReads === 1 ? [reload] : []
    },
    removePlugin: (pluginId) => plugins.delete(pluginId),
    revokeVisibleEffects: async (record) => operatedRecords.push(record),
    waitForCallbacksToDrain: async (record) => operatedRecords.push(record),
  })

  const uninstall = unregisterPluginUnchecked(id)
  assert.equal(oldRecord.state, 'active')
  finishReload()

  assert.equal(await uninstall, true)
  assert.equal(pendingReloadReads, 2)
  assert.equal(plugins.has(id), false)
  assert.equal(oldRecord.state, 'active')
  assert.equal(replacement.state, 'uninstalling')
  assert.deepEqual(operatedRecords, Array(5).fill(replacement))
})
