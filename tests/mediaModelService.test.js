import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'gugo-media-model-tests', String(process.pid))

const { issueTestSession } = await import('./helpers/testAuth.js')
const { upsertModelProvider } = await import('../server/services/modelProviderStore.js')
const { generateImage, transcribeAudio } = await import('../server/services/mediaModelService.js')

test('media model service uses the saved user provider for images and transcription', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'media', label: 'Media', baseUrl: 'https://media.example/v1',
      models: ['image-latest', 'whisper-1'], defaultModel: 'image-latest', apiKey: 'media-secret',
    },
  })
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith('/images/generations')) {
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }), { status: 200 })
    }
    return new Response(JSON.stringify({ text: 'server transcript' }), { status: 200 })
  }
  const image = await generateImage({ userId, model: 'image-latest', prompt: 'a pet', fetchImpl })
  const transcript = await transcribeAudio({ userId, audio: Buffer.from('audio'), fetchImpl })
  assert.equal(image.buffer.toString(), 'png')
  assert.equal(transcript.text, 'server transcript')
  assert.equal(requests[0].url, 'https://media.example/v1/images/generations')
  assert.equal(requests[1].url, 'https://media.example/v1/audio/transcriptions')
  assert.equal(requests.every((request) => request.init.headers.Authorization === 'Bearer media-secret'), true)
})

test('generated image MIME type follows the actual returned bytes', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'jpeg-media', label: 'JPEG Media', baseUrl: 'https://jpeg.example/v1',
      models: ['image-latest'], defaultModel: 'image-latest', apiKey: 'secret',
    },
  })
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
  const fetchImpl = async () => new Response(JSON.stringify({
    data: [{ b64_json: jpeg.toString('base64') }],
  }), { status: 200 })
  const image = await generateImage({ userId, prompt: 'jpeg', fetchImpl })
  assert.equal(image.mimeType, 'image/jpeg')
})

test('media model service preserves explicitly configured local providers', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'loopback-media', label: 'Loopback Media', baseUrl: 'http://127.0.0.1:8080/v1',
      models: ['image-latest'], defaultModel: 'image-latest', apiKey: 'secret',
    },
  })
  let fetchCalls = 0
  const image = await generateImage({
    userId,
    prompt: 'local image',
    fetchImpl: async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from('local').toString('base64') }],
      }))
    },
  })
  assert.equal(image.buffer.toString(), 'local')
  assert.equal(fetchCalls, 1)
})

test('media model API rejects private DNS answers for non-local providers before fetch', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'private-dns-media', label: 'Private DNS Media', baseUrl: 'https://media-cloud.example/v1',
      models: ['image-latest'], defaultModel: 'image-latest', apiKey: 'secret',
    },
  })
  let fetchCalls = 0
  await assert.rejects(
    generateImage({
      userId,
      prompt: 'blocked DNS',
      lookup: async () => [{ address: '192.168.1.20', family: 4 }],
      fetchImpl: async () => {
        fetchCalls += 1
        return new Response('{}')
      },
    }),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(fetchCalls, 0)
})

test('generated image download rejects loopback and private upstream URLs before fetching them', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'private-image-media', label: 'Private Image Media', baseUrl: 'http://127.0.0.1:8081/v1',
      models: ['image-latest'], defaultModel: 'image-latest', apiKey: 'secret',
    },
  })
  for (const url of ['http://127.0.0.1/image.png', 'http://10.0.0.8/image.png']) {
    let fetchCalls = 0
    await assert.rejects(
      generateImage({
        userId,
        prompt: 'blocked download',
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response(JSON.stringify({ data: [{ url }] }))
        },
      }),
      (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
    )
    assert.equal(fetchCalls, 1)
  }
})

test('generated image download revalidates DNS after a redirect', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'redirect-media', label: 'Redirect Media', baseUrl: 'https://redirect-media.example/v1',
      models: ['image-latest'], defaultModel: 'image-latest', apiKey: 'secret',
    },
  })
  let assetLookups = 0
  let fetchCalls = 0
  let pinnedRequests = 0
  const lookup = async (hostname) => {
    if (hostname === 'assets.example') {
      assetLookups += 1
      return [{
        address: assetLookups === 1 ? '93.184.216.34' : '192.168.1.20',
        family: 4,
      }]
    }
    return [{ address: '93.184.216.34', family: 4 }]
  }
  await assert.rejects(
    generateImage({
      userId,
      prompt: 'redirected download',
      lookup,
      fetchImpl: async (url, init) => {
        fetchCalls += 1
        if (init.dispatcher) pinnedRequests += 1
        if (String(url).includes('/images/generations')) {
          return new Response(JSON.stringify({ data: [{ url: 'https://assets.example/start' }] }))
        }
        return new Response(null, { status: 302, headers: { location: '/image.png' } })
      },
    }),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(assetLookups, 2)
  assert.equal(fetchCalls, 2)
  assert.equal(pinnedRequests, 2)
})

test('generated image download follows safe cross-origin redirects with injected fetch', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'cdn-media', label: 'CDN Media', baseUrl: 'https://cdn-media.example/v1',
      models: ['image-latest'], defaultModel: 'image-latest', apiKey: 'secret',
    },
  })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const requests = []
  const image = await generateImage({
    userId,
    prompt: 'safe redirect',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init })
      if (String(url).includes('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'http://assets.example/start' }] }))
      }
      if (String(url) === 'http://assets.example/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://cdn.example/image.png' },
        })
      }
      return new Response(png, { headers: { 'content-type': 'image/png' } })
    },
  })
  assert.equal(image.buffer.equals(png), true)
  assert.deepEqual(requests.map(({ url }) => url), [
    'https://cdn-media.example/v1/images/generations',
    'http://assets.example/start',
    'http://cdn.example/image.png',
  ])
  assert.equal(requests.every(({ init }) => init.redirect === 'manual'), true)
})

test('media model service rejects declared oversized JSON and error responses before reading them', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'bounded-json-media', label: 'Bounded JSON Media', baseUrl: 'https://bounded-json.example/v1',
      models: ['image-latest'], defaultModel: 'image-latest', apiKey: 'secret',
    },
  })

  for (const response of [
    new Response('{}', {
      status: 200,
      headers: { 'content-length': String(30 * 1024 * 1024 + 1) },
    }),
    new Response('upstream failure', {
      status: 502,
      headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
    }),
  ]) {
    await assert.rejects(
      generateImage({
        userId,
        prompt: 'oversized response',
        fetchImpl: async () => response,
      }),
      (error) => error?.code === 'MEDIA_RESPONSE_TOO_LARGE'
        && error?.statusCode === 502
        && error?.retryable === false,
    )
  }
})

test('generated image download cancels a chunked response above the decoded image limit', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'bounded-download-media', label: 'Bounded Download Media', baseUrl: 'https://bounded-download.example/v1',
      models: ['image-latest'], defaultModel: 'image-latest', apiKey: 'secret',
    },
  })
  let fetchCalls = 0
  let cancelled = false
  let chunksSent = 0
  const oversizedResponse = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/png' }),
    body: {
      getReader: () => ({
        async read() {
          if (chunksSent >= 21) return { done: true, value: undefined }
          chunksSent += 1
          return { done: false, value: new Uint8Array(1024 * 1024) }
        },
        async cancel() {
          cancelled = true
        },
      }),
    },
  }

  await assert.rejects(
    generateImage({
      userId,
      prompt: 'oversized chunked image',
      fetchImpl: async (url) => {
        fetchCalls += 1
        if (String(url).endsWith('/images/generations')) {
          return new Response(JSON.stringify({ data: [{ url: 'https://assets.example/image.png' }] }))
        }
        return oversizedResponse
      },
    }),
    (error) => error?.code === 'MEDIA_RESPONSE_TOO_LARGE'
      && error?.statusCode === 502
      && error?.retryable === false,
  )
  assert.equal(fetchCalls, 2)
  assert.equal(chunksSent, 21)
  assert.equal(cancelled, true)
})

test('generated base64 images retain the decoded 20 MiB hard limit', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'bounded-base64-media', label: 'Bounded Base64 Media', baseUrl: 'https://bounded-base64.example/v1',
      models: ['image-latest'], defaultModel: 'image-latest', apiKey: 'secret',
    },
  })
  const maxImageBytes = 20 * 1024 * 1024
  const encodedImage = 'A'.repeat(4 * Math.ceil((maxImageBytes + 1) / 3))

  await assert.rejects(
    generateImage({
      userId,
      prompt: 'oversized base64 image',
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{ b64_json: encodedImage }],
      })),
    }),
    (error) => error?.code === 'MEDIA_RESPONSE_TOO_LARGE'
      && error?.statusCode === 502
      && error?.retryable === false,
  )
})

test('audio transcription cancels a chunked JSON response above its limit', async () => {
  const { userId } = issueTestSession()
  upsertModelProvider({
    userId,
    provider: {
      key: 'bounded-audio-media', label: 'Bounded Audio Media', baseUrl: 'https://bounded-audio.example/v1',
      models: ['whisper-1'], defaultModel: 'whisper-1', apiKey: 'secret',
    },
  })
  let cancelled = false
  let chunksSent = 0
  const oversizedResponse = {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {
      getReader: () => ({
        async read() {
          if (chunksSent >= 3) return { done: true, value: undefined }
          chunksSent += 1
          return { done: false, value: new Uint8Array(1024 * 1024) }
        },
        async cancel() {
          cancelled = true
        },
      }),
    },
  }

  await assert.rejects(
    transcribeAudio({
      userId,
      audio: Buffer.from('audio'),
      fetchImpl: async () => oversizedResponse,
    }),
    (error) => error?.code === 'MEDIA_RESPONSE_TOO_LARGE',
  )
  assert.equal(chunksSent, 3)
  assert.equal(cancelled, true)
})
