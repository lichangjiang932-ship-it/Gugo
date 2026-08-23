import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configureSubagentModelBindingResolver,
  resolveSubagentModelBinding,
} from '../server/services/subagentModelBindingRuntime.js'

test('subagent model binding resolver leases compose and release fail-closed', () => {
  assert.throws(
    () => resolveSubagentModelBinding({ userId: 'owner-1' }),
    (error) => error?.code === 'SUBAGENT_MODEL_BINDING_RESOLVER_NOT_CONFIGURED'
      && error?.statusCode === 503
      && error?.retryable === false,
  )

  const releaseOuter = configureSubagentModelBindingResolver((input) => ({
    source: 'outer',
    input,
  }))
  const releaseInner = configureSubagentModelBindingResolver((input) => ({
    source: 'inner',
    input,
  }))

  assert.deepEqual(resolveSubagentModelBinding({ userId: 'owner-1' }), {
    source: 'inner',
    input: { userId: 'owner-1' },
  })
  assert.equal(releaseOuter(), true)
  assert.equal(releaseOuter(), false)
  assert.equal(resolveSubagentModelBinding({ userId: 'owner-2' }).source, 'inner')
  assert.equal(releaseInner(), true)
  assert.equal(releaseInner(), false)

  assert.throws(
    () => resolveSubagentModelBinding({ userId: 'owner-3' }),
    (error) => error?.code === 'SUBAGENT_MODEL_BINDING_RESOLVER_NOT_CONFIGURED',
  )
})
