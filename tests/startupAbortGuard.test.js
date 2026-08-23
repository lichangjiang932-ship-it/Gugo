import assert from 'node:assert/strict'
import test from 'node:test'

import { createStartupAbortGuard } from '../server/core/startupAbortGuard.js'

test('startup abort guard permanently fences continuations after the first shutdown request', () => {
  const guard = createStartupAbortGuard()

  assert.equal(guard.isRequested(), false)
  assert.doesNotThrow(() => guard.assertNotRequested())
  assert.equal(guard.request('SIGTERM'), true)
  assert.equal(guard.request('SIGINT'), false)
  assert.equal(guard.isRequested(), true)
  assert.throws(
    () => guard.assertNotRequested(),
    (error) => error?.code === 'APP_STARTUP_ABORTED'
      && error?.reason === 'SIGTERM'
      && error?.retryable === false,
  )
})
