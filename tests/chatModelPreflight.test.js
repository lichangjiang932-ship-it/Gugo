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
