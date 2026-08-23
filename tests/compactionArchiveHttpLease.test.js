import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { handleModelProxyRequest } from '../server/adapters/modelProxy.js'
import { createBuiltinHttpCapabilities } from '../server/core/builtinHttpCapabilities.js'
import { handleCompactionRequest } from '../server/routes/compactionRoutes.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createDefinitions({ acquireArchivePort, modelProxyRequestHandler, compactionRequestHandler }) {
  return createBuiltinHttpCapabilities({
    acquireArchivePort,
    modelProxyRequestHandler,
    compactionRequestHandler,
    jobRuntime: {},
  })
}

function createResponse() {
  return {
    statusCode: null,
    body: '',
    headers: new Map(),
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    },
    end(body = '') {
      this.body = String(body)
    },
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), String(value))
    },
  }
}

test('builtin HTTP capability construction defers the Job runtime until request dispatch', async () => {
  let resolutions = 0
  const definitions = createBuiltinHttpCapabilities({
    resolveJobRuntime() {
      resolutions += 1
      return {}
    },
  })
  assert.equal(resolutions, 0)

  const jobs = definitions.find((entry) => entry.id === 'builtin.jobs')
  const res = createResponse()
  await jobs.handle({ method: 'GET', url: '/api/jobs', headers: {} }, res)
  assert.equal(resolutions, 1)
  assert.equal(res.statusCode, 401)
})

test('builtin model proxy and compaction handlers delegate the archive lease factory without acquiring it', async () => {
  for (const capabilityId of ['builtin.model.proxy', 'builtin.compaction']) {
    const gate = deferred()
    let acquisitions = 0
    let receivedFactory = null
    const acquireArchivePort = () => {
      acquisitions += 1
      throw new Error('builtin capability must not acquire the archive port')
    }
    const handler = async (_req, _res, options) => {
      receivedFactory = options.acquireCompactionArchivePort
      await gate.promise
      return capabilityId
    }
    const definitions = createDefinitions({
      acquireArchivePort,
      modelProxyRequestHandler: capabilityId === 'builtin.model.proxy' ? handler : async () => {},
      compactionRequestHandler: capabilityId === 'builtin.compaction' ? handler : async () => {},
    })
    const definition = definitions.find((entry) => entry.id === capabilityId)

    const pending = definition.handle({ method: 'POST', url: '/' }, {})
    assert.equal(acquisitions, 0, capabilityId)
    assert.equal(receivedFactory, acquireArchivePort, capabilityId)

    gate.resolve()
    assert.equal(await pending, capabilityId)
    assert.equal(acquisitions, 0, capabilityId)
  }
})

test('model proxy and compaction early rejections do not require an active archive port', async () => {
  const { issueTestSession } = await import('./helpers/testAuth.js')
  const auth = issueTestSession()
  let acquisitions = 0
  const acquireCompactionArchivePort = () => {
    acquisitions += 1
    throw new Error('early rejection must not acquire the archive port')
  }
  const cases = [
    {
      invoke: (res) => handleModelProxyRequest({
        method: 'GET',
        url: '/api/model/chat',
        headers: {},
      }, res, { acquireCompactionArchivePort }),
      statusCode: 405,
    },
    {
      invoke: (res) => handleModelProxyRequest({
        method: 'POST',
        url: '/api/model/chat',
        headers: {},
      }, res, { acquireCompactionArchivePort }),
      statusCode: 401,
    },
    {
      invoke: (res) => handleCompactionRequest({
        method: 'GET',
        url: '/api/compaction/archive/archive-1',
        headers: {},
      }, res, { acquireCompactionArchivePort }),
      statusCode: 401,
    },
    {
      invoke: (res) => handleCompactionRequest({
        method: 'GET',
        url: '/api/compaction/not-a-route',
        headers: { authorization: `Bearer ${auth.token}` },
      }, res, { acquireCompactionArchivePort }),
      statusCode: 404,
    },
  ]

  for (const entry of cases) {
    const res = createResponse()
    await entry.invoke(res)
    assert.equal(res.statusCode, entry.statusCode)
  }

  const modelEnvKeys = ['MODEL_API_KEY', 'MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_PROVIDERS']
  const previousModelEnv = Object.fromEntries(modelEnvKeys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    MODEL_API_KEY: '',
    MODEL_BASE_URL: '',
    MODEL_NAME: '',
    MODEL_PROVIDERS: '',
  })
  try {
    const res = createResponse()
    await handleModelProxyRequest({
      method: 'POST',
      url: '/api/model/chat',
      headers: { authorization: `Bearer ${auth.token}` },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{}')
      },
    }, res, { acquireCompactionArchivePort })
    assert.equal(res.statusCode, 503)
    assert.equal(JSON.parse(res.body).code, 'MODEL_CONFIG_MISSING')
  } finally {
    for (const key of modelEnvKeys) {
      if (previousModelEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousModelEnv[key]
    }
  }
  assert.equal(acquisitions, 0)
})

test('model proxy reads session archives through the request-scoped port', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-model-proxy-archive-lease-'))
  const envKeys = [
    'AGENT_INJECT_ENABLED',
    'APP_DATA_DIR',
    'APP_DB_PATH',
    'GUGO_LOAD_DOTENV',
    'MODEL_API_KEY',
    'MODEL_BASE_URL',
    'MODEL_NAME',
    'MODEL_PROVIDERS',
  ]
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  Object.assign(process.env, {
    AGENT_INJECT_ENABLED: '0',
    APP_DATA_DIR: tempDir,
    APP_DB_PATH: path.join(tempDir, 'app.db'),
    GUGO_LOAD_DOTENV: '0',
    MODEL_API_KEY: '',
    MODEL_BASE_URL: 'http://127.0.0.1:11434/v1',
    MODEL_NAME: 'lease-test-model',
    MODEL_PROVIDERS: '',
  })

  const nativeFetch = globalThis.fetch
  const { closeDb } = await import('../server/db.js')
  t.after(() => {
    globalThis.fetch = nativeFetch
    closeDb()
    fs.rmSync(tempDir, { recursive: true, force: true })
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key]
      else process.env[key] = previousEnv[key]
    }
  })

  const { issueTestSession } = await import('./helpers/testAuth.js')
  const {
    COMPACTION_ARCHIVE_PORT_VERSION,
    createCompactionArchivePort,
  } = await import('../server/core/compactionArchivePort.js')
  const auth = issueTestSession()
  const getInputs = []
  const port = createCompactionArchivePort({
    apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
    id: 'test.model-proxy-request',
    create() {
      throw new Error('create is not expected')
    },
    get(input) {
      getInputs.push(input)
      return {
        id: input.id,
        userId: input.userId,
        sessionId: 'archive-session',
        replacedMessageCount: 1,
        archivedMessages: [{ role: 'user', content: 'old context' }],
        summaryText: 'REQUEST SCOPED ARCHIVE SUMMARY',
        createdAt: 1,
      }
    },
    cleanup() {
      return { removed: 0 }
    },
  })
  const upstreamStarted = deferred()
  const upstreamGate = deferred()
  let outboundMessages = null
  globalThis.fetch = async (_url, init) => {
    outboundMessages = JSON.parse(init.body).messages
    upstreamStarted.resolve()
    await upstreamGate.promise
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const requestBody = JSON.stringify({
    messages: [{ role: 'user', content: 'continue' }],
    recentMessages: [{
      id: 'summary-message',
      role: 'assistant',
      content: 'summary marker',
      meta: { archiveId: 'archive-1' },
    }],
  })
  const req = {
    method: 'POST',
    url: '/api/model/chat',
    headers: { authorization: `Bearer ${auth.token}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(requestBody)
    },
  }
  let acquisitions = 0
  let releases = 0
  const acquireCompactionArchivePort = () => {
    acquisitions += 1
    let released = false
    return Object.freeze({
      port,
      release() {
        if (released) return false
        released = true
        releases += 1
        return true
      },
    })
  }
  const res = createResponse()

  const pending = handleModelProxyRequest(req, res, { acquireCompactionArchivePort })
  await upstreamStarted.promise

  assert.equal(acquisitions, 1)
  assert.equal(releases, 0)

  upstreamGate.resolve()
  await pending

  assert.equal(res.statusCode, 200)
  assert.equal(releases, 1)
  assert.deepEqual(getInputs.map((input) => ({ userId: input.userId, id: input.id })), [{
    userId: auth.userId,
    id: 'archive-1',
  }])
  assert.ok(outboundMessages.some((message) => (
    message.role === 'system'
    && String(message.content).includes('REQUEST SCOPED ARCHIVE SUMMARY')
  )))
})

test('compaction releases its request-scoped archive lease when the archive adapter fails', async () => {
  const { issueTestSession } = await import('./helpers/testAuth.js')
  const {
    COMPACTION_ARCHIVE_PORT_VERSION,
    createCompactionArchivePort,
  } = await import('../server/core/compactionArchivePort.js')
  const expected = new Error('archive read failed')
  const port = createCompactionArchivePort({
    apiVersion: COMPACTION_ARCHIVE_PORT_VERSION,
    id: 'test.compaction-request-failure',
    create() {
      throw new Error('create is not expected')
    },
    async get() {
      await Promise.resolve()
      throw expected
    },
    cleanup() {
      return { removed: 0 }
    },
  })
  let acquisitions = 0
  let releases = 0
  const acquireCompactionArchivePort = () => {
    acquisitions += 1
    return {
      port,
      release() {
        releases += 1
        return true
      },
    }
  }
  const auth = issueTestSession()
  const req = {
    method: 'GET',
    url: '/api/compaction/archive/archive-failure',
    headers: { authorization: `Bearer ${auth.token}` },
  }
  const res = createResponse()

  await handleCompactionRequest(req, res, { acquireCompactionArchivePort })

  assert.equal(res.statusCode, 400)
  assert.match(res.body, /archive read failed/)
  assert.equal(acquisitions, 1)
  assert.equal(releases, 1)
})
