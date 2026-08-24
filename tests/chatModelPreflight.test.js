import assert from 'node:assert/strict'
import test from 'node:test'

import { preflightChatModelSelection } from '../src/pages/ChatSplit/chatModelPreflight.js'

test('model preflight classifies only a Gugo status endpoint 401 as an expired login', async () => {
  const result = await preflightChatModelSelection({
    getStatus: async () => {
      const error = new Error('expired login')
      error.status = 401
      throw error
    },
  })

  assert.deepEqual(result, { ok: false, authenticationRequired: true })
})

test('model preflight keeps non-401 transport failures in the model error path', async () => {
  for (const status of [undefined, 403, 500]) {
    const result = await preflightChatModelSelection({
      getStatus: async () => {
        const error = new Error('status request failed')
        error.status = status
        throw error
      },
    })

    assert.deepEqual(result, {
      ok: false,
      readiness: { kind: 'error', canSend: false, modelName: '', authoritative: true },
    })
  }
})

test('model preflight bounds the status request so a hung check cannot lock chat sending', async () => {
  let receivedSignal = null
  // AbortSignal.timeout() intentionally uses an unref'ed timer in Node. Keep
  // the test process alive long enough to observe the browser-equivalent abort.
  const keepAlive = setTimeout(() => {}, 100)
  let result
  try {
    result = await preflightChatModelSelection({
      timeoutMs: 25,
      getStatus: async ({ signal } = {}) => {
        receivedSignal = signal
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })
  } finally {
    clearTimeout(keepAlive)
  }

  assert.ok(receivedSignal)
  assert.equal(receivedSignal.aborted, true)
  assert.deepEqual(result, {
    ok: false,
    readiness: { kind: 'error', canSend: false, modelName: '', authoritative: true },
  })
})
