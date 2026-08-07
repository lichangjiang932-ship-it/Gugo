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
