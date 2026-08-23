import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-model-vision-fallback-'))

let receivedBody = null
const mockModel = http.createServer((req, res) => {
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    receivedBody = JSON.parse(raw)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fallback received' } }] }))
  })
})
await new Promise((resolve) => mockModel.listen(0, '127.0.0.1', resolve))

process.env.MODEL_BASE_URL = `http://127.0.0.1:${mockModel.address().port}/v1`
process.env.MODEL_NAME = 'text-model'
process.env.MODEL_API_KEY = ''
process.env.MODEL_PROVIDERS = ''
process.env.MODEL_NAMES_VISION = 'vision-only'
process.env.VISION_ASSIST_BASE_URL = ''
process.env.VISION_ASSIST_MODEL = ''
process.env.VISION_ASSIST_API_KEY = ''
process.env.AGENT_INJECT_ENABLED = '0'

const { createAppServer } = await import('../server/appServer.js')
const {
  COMPACTION_ARCHIVE_PORT_VERSION,
  createCompactionArchivePortController,
} = await import('../server/core/compactionArchivePort.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const compactionArchiveController = createCompactionArchivePortController({
  apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
  id: 'test.model-vision-fallback',
  create(input) {
    return {
      id: input.id || 'test-model-vision-fallback-archive',
      userId: input.userId,
      sessionId: input.sessionId,
      replacedMessageCount: input.archivedMessages.length,
      archivedMessages: input.archivedMessages,
      summaryText: input.summaryText,
      createdAt: 0,
    }
  },
  get() {
    return null
  },
  cleanup() {
    return { removed: 0 }
  },
}, { source: 'test.model-vision-fallback' })
compactionArchiveController.activate()

test('text-only model receives placeholders instead of a 422 or raw image payload', async () => {
  const { token } = issueTestSession()
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  try {
    const response = await fetch(`${baseUrl}/api/model/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        modelName: 'text-model',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is shown here?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        }],
      }),
    })

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-vision-fallback-count'), '1')
    assert.equal(response.headers.get('x-vision-fallback-reason'), 'assist_unavailable')
    const payload = await response.json()
    assert.equal(payload.reply, 'fallback received')

    const outboundUser = receivedBody.messages.find((message) => message.role === 'user')
    assert.ok(outboundUser)
    assert.equal(outboundUser.content.some((part) => part.type === 'image_url'), false)
    assert.equal(outboundUser.content[0].text, 'What is shown here?')
    assert.match(outboundUser.content[1].text, /text-model does not accept vision input/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test.after(async () => {
  await new Promise((resolve) => mockModel.close(resolve))
  compactionArchiveController.release()
  try { fs.rmSync(process.env.APP_DATA_DIR, { recursive: true, force: true }) } catch { /* best effort */ }
})
