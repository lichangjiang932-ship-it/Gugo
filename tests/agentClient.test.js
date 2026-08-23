import assert from 'node:assert/strict'
import test from 'node:test'

import { jsonOk } from '../src/lib/agentClient.js'

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }
}

test('agent client preserves structured provider errors', async () => {
  const details = { providerIds: ['provider-a', 'provider-b'] }
  await assert.rejects(
    jsonOk(response({
      ok: false,
      error: {
        code: 'MODEL_PROVIDER_AMBIGUOUS',
        message: 'Choose a provider for this model.',
        action: 'choose_agent_provider',
        providerId: null,
        modelName: 'shared-model',
        configRevision: 7,
        details,
      },
    }, 409)),
    (error) => {
      assert.equal(error.message, 'Choose a provider for this model.')
      assert.equal(error.status, 409)
      assert.equal(error.code, 'MODEL_PROVIDER_AMBIGUOUS')
      assert.equal(error.action, 'choose_agent_provider')
      assert.equal(error.providerId, null)
      assert.equal(error.modelName, 'shared-model')
      assert.equal(error.configRevision, 7)
      assert.deepEqual(error.details, details)
      return true
    },
  )
})

test('agent client keeps legacy string errors readable', async () => {
  await assert.rejects(
    jsonOk(response({ ok: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401)),
    (error) => {
      assert.equal(error.message, 'Unauthorized')
      assert.equal(error.status, 401)
      assert.equal(error.code, 'UNAUTHORIZED')
      return true
    },
  )
})

test('agent client returns successful response payloads unchanged', async () => {
  const payload = { ok: true, agents: [{ id: 'agent-1' }] }
  assert.deepEqual(await jsonOk(response(payload)), payload)
})
