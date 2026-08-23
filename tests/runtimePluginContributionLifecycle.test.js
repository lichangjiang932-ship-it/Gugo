import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginContributionLifecycle,
} from '../server/plugins/runtimePluginContributionLifecycle.js'

function v2Handle(beginRevoke) {
  return attachRuntimePluginBeginRevoke(() => false, beginRevoke)
}

test('revoked visibility remains authoritative when independent cleanup rejects', async () => {
  const cleanupError = new Error('cleanup failed after visibility commit')
  const lifecycle = createRuntimePluginContributionLifecycle([{
    id: 'tool',
    handle: v2Handle(() => ({
      visibility: 'revoked',
      cleanup: Promise.reject(cleanupError),
    })),
  }])

  const receipt = lifecycle.beginRevoke()
  assert.equal(receipt.visibility, 'revoked')
  await assert.rejects(receipt.cleanup, {
    code: 'PLUGIN_REVOKE_CLEANUP_FAILED',
    message: /cleanup failed after visibility commit/,
  })
  assert.deepEqual(lifecycle.snapshot(), {
    state: 'revoked',
    parts: [{
      id: 'tool',
      state: 'revoked',
      cleanupState: 'failed',
      attempts: 1,
      errorCode: 'PLUGIN_REVOKE_CLEANUP_FAILED',
    }],
  })
  assert.equal(lifecycle.retire(), false)
})

test('retained part keeps its handle and can be explicitly retried', async () => {
  let attempts = 0
  const lifecycle = createRuntimePluginContributionLifecycle([{
    id: 'provider',
    handle: v2Handle(() => {
      attempts += 1
      if (attempts === 1) {
        return {
          visibility: 'retained',
          cleanup: Promise.reject(new Error('host remained visible')),
        }
      }
      return { visibility: 'revoked', cleanup: null }
    }),
  }])

  const first = lifecycle.beginRevoke()
  assert.equal(first.visibility, 'retained')
  await assert.rejects(first.cleanup, /host remained visible/)
  const second = lifecycle.beginRevoke()
  assert.equal(second.visibility, 'revoked')
  await second.cleanup
  assert.equal(attempts, 2)
  assert.equal(lifecycle.retire(), true)
  assert.equal(lifecycle.snapshot().state, 'retired')
})

test('multi-part lifecycle reports partial visibility without replaying revoked parts', async () => {
  let capabilityAttempts = 0
  let toolAttempts = 0
  const lifecycle = createRuntimePluginContributionLifecycle([
    {
      id: 'capability',
      handle: v2Handle(() => {
        capabilityAttempts += 1
        return { visibility: 'revoked', cleanup: null }
      }),
    },
    {
      id: 'tool',
      handle: v2Handle(() => {
        toolAttempts += 1
        return toolAttempts === 1
          ? { visibility: 'retained', cleanup: null }
          : { visibility: 'revoked', cleanup: null }
      }),
    },
  ])

  const first = lifecycle.beginRevoke()
  assert.equal(first.visibility, 'partial')
  await first.cleanup
  assert.equal(lifecycle.snapshot().state, 'partial')

  const second = lifecycle.beginRevoke()
  assert.equal(second.visibility, 'revoked')
  await second.cleanup
  assert.equal(capabilityAttempts, 1)
  assert.equal(toolAttempts, 2)
})

test('legacy async disposer is indeterminate even when its Promise resolves', async () => {
  const lifecycle = createRuntimePluginContributionLifecycle([{
    id: 'legacy-async',
    handle: () => Promise.resolve(true),
  }])

  const receipt = lifecycle.beginRevoke()
  assert.equal(receipt.visibility, 'indeterminate')
  await assert.rejects(receipt.cleanup, {
    code: 'PLUGIN_REVOKE_VISIBILITY_INDETERMINATE',
  })
  assert.equal(lifecycle.snapshot().state, 'indeterminate')
  assert.equal(lifecycle.retire(), false)
})

test('legacy synchronous return values cannot upgrade indeterminate visibility', async () => {
  let attempts = 0
  const lifecycle = createRuntimePluginContributionLifecycle([{
    id: 'legacy-sync',
    handle: () => {
      attempts += 1
      if (attempts === 1) throw new Error('visibility unknown')
      return false
    },
  }])

  const first = lifecycle.beginRevoke()
  assert.equal(first.visibility, 'indeterminate')
  await assert.rejects(first.cleanup)
  const second = lifecycle.beginRevoke()
  assert.equal(second.visibility, 'indeterminate')
  await assert.rejects(second.cleanup, { code: 'PLUGIN_REVOKE_PROTOCOL_REQUIRED' })
  assert.equal(lifecycle.snapshot().state, 'indeterminate')
})

test('malformed v2 receipts fail closed without reading accessors or thenables', async () => {
  let cleanupRead = 0
  const receipt = Object.create(null)
  Object.defineProperty(receipt, 'visibility', {
    value: 'revoked',
    enumerable: true,
  })
  Object.defineProperty(receipt, 'cleanup', {
    get() {
      cleanupRead += 1
      return Promise.resolve()
    },
    enumerable: true,
  })
  const lifecycle = createRuntimePluginContributionLifecycle([{
    id: 'hostile-receipt',
    handle: v2Handle(() => receipt),
  }])

  const result = lifecycle.beginRevoke()
  assert.equal(result.visibility, 'indeterminate')
  await assert.rejects(result.cleanup, { code: 'PLUGIN_REVOKE_PROTOCOL_INVALID' })
  assert.equal(cleanupRead, 0)
})

test('hostile thrown values and frozen rejected cleanup cannot escape accounting', async () => {
  let codeReads = 0
  const hostile = Object.defineProperty({}, 'code', {
    get() {
      codeReads += 1
      throw new Error('code getter escaped')
    },
  })
  const thrownLifecycle = createRuntimePluginContributionLifecycle([{
    id: 'hostile-throw',
    handle: v2Handle(() => { throw hostile }),
  }])
  const thrownReceipt = thrownLifecycle.beginRevoke()
  assert.equal(thrownReceipt.visibility, 'indeterminate')
  await assert.rejects(thrownReceipt.cleanup)
  assert.equal(codeReads, 0)

  const frozenCleanup = Object.freeze(Promise.reject(new Error('frozen cleanup')))
  const cleanupLifecycle = createRuntimePluginContributionLifecycle([{
    id: 'frozen-cleanup',
    handle: v2Handle(() => ({ visibility: 'revoked', cleanup: frozenCleanup })),
  }])
  const cleanupReceipt = cleanupLifecycle.beginRevoke()
  assert.equal(cleanupReceipt.visibility, 'revoked')
  await assert.rejects(cleanupReceipt.cleanup, /frozen cleanup/)
  assert.equal(cleanupLifecycle.snapshot().parts[0].cleanupState, 'failed')
})

test('reactivation is allowed only after every part is confirmed revoked', async () => {
  let activeGeneration = 1
  const createHandle = () => v2Handle(() => ({ visibility: 'revoked', cleanup: null }))
  const lifecycle = createRuntimePluginContributionLifecycle([{
    id: 'service',
    handle: createHandle(),
    reactivate: () => {
      activeGeneration += 1
      return createHandle()
    },
  }])

  const receipt = lifecycle.beginRevoke()
  await receipt.cleanup
  const restored = await lifecycle.reactivateRevoked()
  assert.equal(activeGeneration, 2)
  assert.equal(restored.state, 'active')
})

test('confirmed revoked visibility can be restored after cleanup debt settles', async () => {
  let restored = 0
  const lifecycle = createRuntimePluginContributionLifecycle([{
    id: 'revoked-with-debt',
    handle: v2Handle(() => ({
      visibility: 'revoked',
      cleanup: Promise.reject(new Error('cleanup debt')),
    })),
    reactivate: () => {
      restored += 1
      return v2Handle(() => ({ visibility: 'revoked', cleanup: null }))
    },
  }])

  const receipt = lifecycle.beginRevoke()
  await assert.rejects(receipt.cleanup, /cleanup debt/)
  const snapshot = await lifecycle.reactivateRevoked()
  assert.equal(restored, 1)
  assert.equal(snapshot.state, 'active')
})

test('failed reactivation never leaves a permanent reactivating state', async () => {
  const lifecycle = createRuntimePluginContributionLifecycle([{
    id: 'failed-restore',
    handle: v2Handle(() => ({ visibility: 'revoked', cleanup: null })),
    reactivate: () => { throw new Error('restore failed') },
  }])
  await lifecycle.beginRevoke().cleanup
  await assert.rejects(lifecycle.reactivateRevoked(), /restore failed/)
  assert.equal(lifecycle.snapshot().state, 'indeterminate')
  assert.notEqual(lifecycle.snapshot().parts[0].state, 'reactivating')
})
