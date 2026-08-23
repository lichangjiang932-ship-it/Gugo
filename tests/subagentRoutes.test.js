import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { handleSubagentRequest } from '../server/routes/subagentRoutes.js'
import { issueTestSession } from './helpers/testAuth.js'

const session = issueTestSession({ email: `subagent-route-${Date.now()}@example.com` })

function request(body, { accept = 'application/json' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = '/api/subagent/run'
  req.headers = {
    accept,
    authorization: `Bearer ${session.token}`,
    'content-type': 'application/json',
  }
  return req
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHeadCalls: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      this.headers = headers
      this.writeHeadCalls.push({ statusCode, headers })
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end(chunk = '') {
      if (chunk) this.chunks.push(String(chunk))
      this.ended = true
    },
    text() {
      return this.chunks.join('')
    },
  }
}

test('POST /api/subagent/run forwards the selected model binding in JSON mode', async () => {
  let received = null
  const req = request({
    type: 'general',
    prompt: 'inspect JSON binding',
    modelName: 'json-model',
    modelProviderId: 'json-provider',
    modelConfigRevision: 3,
  })
  const res = response()

  await handleSubagentRequest(req, res, {
    assertReady: () => true,
    runSubagentImpl: async (input) => {
      received = input
      return {
        id: 'json-run',
        resultText: 'done',
        modelName: input.modelName,
        modelProviderId: input.modelProviderId,
        modelConfigRevision: input.modelConfigRevision,
      }
    },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(received.modelName, 'json-model')
  assert.equal(received.modelProviderId, 'json-provider')
  assert.equal(received.modelConfigRevision, 3)
  const body = JSON.parse(res.text())
  assert.equal(body.run.modelProviderId, 'json-provider')
  assert.equal(body.run.modelConfigRevision, 3)
})

test('POST /api/subagent/run forwards the selected model binding in SSE mode', async () => {
  let received = null
  const req = request({
    type: 'general',
    prompt: 'inspect SSE binding',
    model_name: 'sse-model',
    model_provider_id: 'sse-provider',
    model_config_revision: 4,
    stream: true,
  }, { accept: 'text/event-stream' })
  const res = response()

  await handleSubagentRequest(req, res, {
    assertReady: () => true,
    runSubagentImpl: async (input) => {
      received = input
      return {
        id: 'sse-run',
        resultText: 'done',
        modelName: input.modelName,
        modelProviderId: input.modelProviderId,
        modelConfigRevision: input.modelConfigRevision,
      }
    },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Content-Type'], 'text/event-stream')
  assert.equal(received.modelName, 'sse-model')
  assert.equal(received.modelProviderId, 'sse-provider')
  assert.equal(received.modelConfigRevision, 4)
  assert.match(res.text(), /"type":"start"/)
  assert.match(res.text(), /"type":"done"/)
  assert.match(res.text(), /"modelProviderId":"sse-provider"/)
})

test('POST /api/subagent/run fails closed with JSON 503 before invoking the runtime', async () => {
  let invoked = false
  const req = request({ type: 'general', prompt: 'must not run' })
  const res = response()
  const unavailable = Object.assign(new Error('subagent persistence is not ready'), { statusCode: 503 })

  await handleSubagentRequest(req, res, {
    assertReady: () => {
      throw unavailable
    },
    runSubagentImpl: async () => {
      invoked = true
      throw new Error('unreachable')
    },
  })

  assert.equal(invoked, false)
  assert.deepEqual(res.writeHeadCalls.map(({ statusCode }) => statusCode), [503])
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(res.text()), {
    ok: false,
    error: 'subagent persistence is not ready',
    run: null,
  })
})

test('POST /api/subagent/run SSE fails with 503 before any 200 event-stream headers', async () => {
  let invoked = false
  const req = request(
    { type: 'general', prompt: 'must not stream', stream: true },
    { accept: 'text/event-stream' },
  )
  const res = response()
  const unavailable = Object.assign(new Error('subagent persistence is not ready'), { statusCode: 503 })

  await handleSubagentRequest(req, res, {
    assertReady: () => {
      throw unavailable
    },
    runSubagentImpl: async () => {
      invoked = true
      throw new Error('unreachable')
    },
  })

  assert.equal(invoked, false)
  assert.deepEqual(res.writeHeadCalls.map(({ statusCode }) => statusCode), [503])
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.doesNotMatch(res.text(), /data:/)
  assert.deepEqual(JSON.parse(res.text()), {
    ok: false,
    error: 'subagent persistence is not ready',
    run: null,
  })
})
