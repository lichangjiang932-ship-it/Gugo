import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const ENV_KEYS = [
  'AGENT_INJECT_ENABLED',
  'APP_DATA_DIR',
  'GUGO_LOAD_DOTENV',
  'MODEL_API_KEY',
  'MODEL_BASE_URL',
  'MODEL_NAME',
  'MODEL_NAMES',
  'MODEL_PROVIDERS',
]
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-model-proxy-loopback-'))

process.env.APP_DATA_DIR = dataDir
process.env.GUGO_LOAD_DOTENV = '0'
process.env.AGENT_INJECT_ENABLED = '0'
process.env.MODEL_NAME = 'loopback-model'
process.env.MODEL_API_KEY = 'loopback-secret'
process.env.MODEL_NAMES = ''
process.env.MODEL_PROVIDERS = ''

const upstreamRequests = []
const upstream = http.createServer((req, res) => {
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    const body = JSON.parse(raw)
    upstreamRequests.push({ body, headers: req.headers, url: req.url })

    if (body.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'hello ' }, finish_reason: null }],
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'world' }, finish_reason: null }],
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })}\n\n`)
      res.end('data: [DONE]\n\n')
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'loopback json reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }))
  })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
process.env.MODEL_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`

const { handleModelProxyRequest } = await import('../server/adapters/modelProxy.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')

const compactionArchiveController = activateTestCompactionArchivePort({
  source: 'test.model-proxy-response-loopback',
})
const proxy = http.createServer((req, res) => {
  void handleModelProxyRequest(req, res)
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`
const { token } = issueTestSession()

function requestHeaders() {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function parseSseData(text) {
  return text
    .split(/\r?\n\r?\n/u)
    .map((frame) => frame.split(/\r?\n/u).find((line) => line.startsWith('data:')))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(5).trimStart()))
}

test('model proxy preserves non-streaming JSON behavior across a real HTTP loopback', async () => {
  const response = await fetch(`${proxyOrigin}/api/model/chat`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({
      modelName: 'loopback-model',
      messages: [{ role: 'user', content: 'json ping' }],
    }),
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /^application\/json\b/u)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.reply, 'loopback json reply')
  assert.deepEqual(payload.injectedMemoryIds, [])

  const outbound = upstreamRequests.at(-1)
  assert.equal(outbound.url, '/v1/chat/completions')
  assert.equal(outbound.headers.authorization, 'Bearer loopback-secret')
  assert.equal(outbound.body.model, 'loopback-model')
  assert.equal(outbound.body.stream, false)
  assert.deepEqual(outbound.body.messages.at(-1), { role: 'user', content: 'json ping' })
})

test('model proxy preserves connecting, delta, and done SSE ordering across a real HTTP loopback', async () => {
  const response = await fetch(`${proxyOrigin}/api/model/chat`, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({
      modelName: 'loopback-model',
      stream: true,
      messages: [{ role: 'user', content: 'stream ping' }],
    }),
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream\b/u)
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  const frames = parseSseData(await response.text())

  assert.equal(frames[0].phase, 'connecting')
  const streamingIndex = frames.findIndex((frame) => frame.phase === 'streaming')
  const firstDeltaIndex = frames.findIndex((frame) => Object.hasOwn(frame, 'delta'))
  assert.ok(streamingIndex > 0)
  assert.ok(firstDeltaIndex > streamingIndex)
  assert.equal(frames.filter((frame) => Object.hasOwn(frame, 'delta')).map((frame) => frame.delta).join(''), 'hello world')
  assert.equal(frames.at(-1).done, true)
  assert.equal(frames.at(-1).finishReason, 'stop')
  assert.equal(frames.at(-1).usage.totalTokens, 5)

  const outbound = upstreamRequests.at(-1)
  assert.equal(outbound.url, '/v1/chat/completions')
  assert.equal(outbound.body.model, 'loopback-model')
  assert.equal(outbound.body.stream, true)
  assert.deepEqual(outbound.body.messages.at(-1), { role: 'user', content: 'stream ping' })
})

test.after(async () => {
  await new Promise((resolve) => proxy.close(resolve))
  await new Promise((resolve) => upstream.close(resolve))
  compactionArchiveController.release()
  closeDb()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
})
