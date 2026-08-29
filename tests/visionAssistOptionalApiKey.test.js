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

test('vision inference rejects public hostnames that resolve to private addresses before fetch', async () => {
  let fetchCalls = 0
  const result = await attachVisionDescriptions({
    env: {
      VISION_ASSIST_BASE_URL: 'https://vision-public.example.test/v1',
      VISION_ASSIST_MODEL: 'vision-model',
      VISION_ASSIST_API_KEY: 'vision-secret',
    },
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
    }],
    lookup: async () => [{ address: '192.168.1.40', family: 4 }],
    fetchImpl: async () => {
      fetchCalls += 1
      return okJson({ choices: [{ message: { content: 'must not run' } }] })
    },
  })

  assert.equal(fetchCalls, 0)
  assert.equal(result.assistCount, 1)
  assert.match(result.failures[0], /forbidden/i)
})

test('vision inference always blocks cloud metadata addresses', async () => {
  let fetchCalls = 0
  const result = await attachVisionDescriptions({
    env: {
      VISION_ASSIST_BASE_URL: 'http://169.254.169.254/latest',
      VISION_ASSIST_MODEL: 'vision-model',
    },
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
    }],
    fetchImpl: async () => {
      fetchCalls += 1
      return okJson({ choices: [{ message: { content: 'must not run' } }] })
    },
  })

  assert.equal(fetchCalls, 0)
  assert.match(result.failures[0], /forbidden cloud metadata/i)
})

test('vision inference does not forward API keys across redirects', async () => {
  const requests = []
  const result = await attachVisionDescriptions({
    env: {
      VISION_ASSIST_BASE_URL: 'https://vision-redirect.example.test/v1',
      VISION_ASSIST_MODEL: 'vision-model',
      VISION_ASSIST_API_KEY: 'vision-secret',
    },
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
    }],
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url, init) => {
      const href = String(url)
      requests.push({ url: href, init })
      if (href === 'https://vision-redirect.example.test/v1/chat/completions') {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://credential-thief.example.test/chat/completions' },
        })
      }
      throw new Error(`request must not reach ${href}`)
    },
  })

  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.headers.Authorization, 'Bearer vision-secret')
  assert.equal(requests.some(({ url }) => url.includes('credential-thief.example.test')), false)
  assert.match(result.failures[0], /cross-origin/i)
})

test('vision inference re-checks DNS after a same-origin redirect', async () => {
  let lookupCalls = 0
  let fetchCalls = 0
  const result = await attachVisionDescriptions({
    env: {
      VISION_ASSIST_BASE_URL: 'https://vision-rebind.example.test/v1',
      VISION_ASSIST_MODEL: 'vision-model',
      VISION_ASSIST_API_KEY: 'vision-secret',
    },
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
    }],
    lookup: async () => {
      lookupCalls += 1
      return [{
        address: lookupCalls === 1 ? '93.184.216.34' : '169.254.169.254',
        family: 4,
      }]
    },
    fetchImpl: async () => {
      fetchCalls += 1
      return new Response(null, { status: 307, headers: { location: '/v1/chat/rebound' } })
    },
  })

  assert.equal(lookupCalls, 2)
  assert.equal(fetchCalls, 1)
  assert.match(result.failures[0], /forbidden cloud metadata/i)
})

test('vision connection probes use the same DNS guard', async () => {
  let fetchCalls = 0
  await assert.rejects(
    () => testProviderCredentials({
      provider: 'vision_assist',
      config: { baseUrl: 'https://vision-probe.example.test/v1', modelName: 'vision-model' },
      secret: { apiKey: 'probe-secret' },
      lookup: async () => [{ address: '10.20.30.40', family: 4 }],
      fetchImpl: async () => {
        fetchCalls += 1
        return okJson({ data: [{ id: 'vision-model' }] })
      },
    }),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(fetchCalls, 0)
})
