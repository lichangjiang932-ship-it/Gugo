import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachVisionDescriptions,
  resolveVisionAssistConfig,
  setVisionAssistResolver,
} from '../server/adapters/visionAssist.js'
import { testProviderCredentials } from '../server/services/integrationsStore.js'

const KEYLESS_ENV = {
  VISION_ASSIST_BASE_URL: 'http://127.0.0.1:11434/v1/',
  VISION_ASSIST_MODEL: 'llava',
}

function okJson(data) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  }
}

test('keyless environment configuration is ready for a local vision endpoint', () => {
  const resolved = resolveVisionAssistConfig({ env: KEYLESS_ENV })
  assert.equal(resolved?.config?.baseUrl, 'http://127.0.0.1:11434/v1')
  assert.equal(resolved?.config?.modelName, 'llava')
  assert.equal(resolved?.secret?.apiKey, '')
})

test('keyless saved configuration is accepted and normalized', () => {
  setVisionAssistResolver(() => ({
    config: { baseUrl: 'http://127.0.0.1:1234/v1', modelName: 'local-vision' },
    secret: {},
  }))
  try {
    const resolved = resolveVisionAssistConfig({ userId: 'local-user', env: {} })
    assert.equal(resolved?.config?.modelName, 'local-vision')
    assert.equal(resolved?.secret?.apiKey, '')
  } finally {
    setVisionAssistResolver(null)
  }
})

test('keyless vision requests omit Authorization instead of sending an empty bearer token', async () => {
  let captured = null
  const result = await attachVisionDescriptions({
    env: KEYLESS_ENV,
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
    }],
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return okJson({ choices: [{ message: { content: '一张测试图片' } }] })
    },
  })

  assert.equal(result.assistCount, 1)
  assert.equal(result.failures.length, 0)
  assert.equal(captured.url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(captured.init.headers['Content-Type'], 'application/json')
  assert.equal('Authorization' in captured.init.headers, false)
})

test('connection test supports a keyless endpoint and omits Authorization', async () => {
  let captured = null
  const result = await testProviderCredentials({
    provider: 'vision_assist',
    config: { baseUrl: 'http://127.0.0.1:11434/v1', modelName: 'llava' },
    secret: {},
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return okJson({ data: [{ id: 'llava' }] })
    },
  })

  assert.equal(result.ok, true)
  assert.equal(captured.url, 'http://127.0.0.1:11434/v1/models')
  assert.equal('Authorization' in captured.init.headers, false)
})
