import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-model-provider-routes-'))
process.env.APP_DATA_DIR = dir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb, getDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')
const {
  buildProviderProfileOverrides,
  validateProviderToolProbe,
} = await import('../server/routes/modelProviderRoutes.js')
const {
  recordModelProviderReadiness,
  upsertModelProvider,
} = await import('../server/services/modelProviderStore.js')

const compactionArchiveController = activateTestCompactionArchivePort({
  source: 'test.model-provider-routes',
})
const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/api/model/providers`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  compactionArchiveController.release()
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function headers(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

test('provider diagnostics prefer the selected model profile over provider fallback', () => {
  assert.deepEqual(buildProviderProfileOverrides({
    contextWindow: 128000,
    modelProfiles: { small: { contextWindow: 8192, supportsTools: false } },
  }), {
    kind: undefined,
    contextWindow: 128000,
    supportsTools: undefined,
    supportsStreaming: undefined,
    supportsVision: undefined,
    supportsPdf: undefined,
    firstTokenTimeoutMs: undefined,
    idleTimeoutMs: undefined,
    failoverEnabled: undefined,
    keepAlive: undefined,
    models: { small: { contextWindow: 8192, supportsTools: false } },
  })
})

test('provider tool probe rejects text-only and malformed function-call responses', () => {
  assert.throws(
    () => validateProviderToolProbe({ content: 'pong', toolCalls: [] }),
    (error) => error.code === 'PROVIDER_TOOL_CALL_MISSING',
  )
  assert.throws(
    () => validateProviderToolProbe({
      toolCalls: [{ type: 'function', function: { name: 'gugo_provider_probe', arguments: '{bad' } }],
    }),
    (error) => error.code === 'PROVIDER_TOOL_ARGUMENTS_INVALID',
  )
  assert.throws(
    () => validateProviderToolProbe({
      toolCalls: [{
        type: 'function',
        function: { name: 'gugo_provider_probe', arguments: '{"value":"ok","unexpected":true}' },
      }],
    }),
    (error) => error.code === 'PROVIDER_TOOL_ARGUMENTS_INVALID',
  )
  assert.throws(
    () => validateProviderToolProbe({
      toolCalls: [
        {
          type: 'function',
          function: { name: 'gugo_provider_probe', arguments: '{"value":"ok"}' },
        },
        {
          type: 'function',
          function: { name: 'unexpected_tool', arguments: '{}' },
        },
      ],
    }),
    (error) => error.code === 'PROVIDER_TOOL_CALL_INVALID',
  )
  assert.throws(
    () => validateProviderToolProbe({
      toolCalls: [{
        type: 'function',
        function: { name: 'unexpected_tool', arguments: '{"value":"ok"}' },
      }],
    }),
    (error) => error.code === 'PROVIDER_TOOL_CALL_INVALID',
  )
  assert.equal(validateProviderToolProbe({
    toolCalls: [{
      id: 'probe-1',
      type: 'function',
      function: { name: 'gugo_provider_probe', arguments: '{"value":"ok"}' },
    }],
  }).toolCallId, 'probe-1')
})

test('model provider routes require authentication', async () => {
  const response = await fetch(baseUrl)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED')
})

test('model status exposes Provider UUID, config revision, and revision-bound readiness', async () => {
  const session = issueTestSession({ email: 'model-status-binding@example.com' })
  const provider = upsertModelProvider({
    userId: session.userId,
    provider: {
      key: 'statusbinding',
      label: 'Status binding',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      models: ['status-model', 'status-untested'],
      defaultModel: 'status-model',
      enabled: true,
      isDefault: true,
      kind: 'openai-compatible',
    },
  })
  const tested = recordModelProviderReadiness({
    userId: session.userId,
    id: provider.id,
    expectedConfigRevision: provider.configRevision,
    readiness: { chat: true, tools: true, agent: true, mode: 'agent' },
  })

  const response = await fetch(`${new URL(baseUrl).origin}/api/model/status`, {
    headers: headers(session.token),
  })
  assert.equal(response.status, 200)
  const status = await response.json()
  assert.equal(status.configured, true)
  const model = status.models.find((entry) => entry.name === 'status-model')
  assert.ok(model)
  assert.equal(model.provider, provider.id)
  assert.equal(model.providerKey, provider.key)
  assert.equal(model.configRevision, provider.configRevision)
  assert.deepEqual(model.readiness, tested.readiness)
  assert.equal(model.readiness.configRevision, provider.configRevision)
  const untested = status.models.find((entry) => entry.name === 'status-untested')
  assert.ok(untested)
  assert.equal(untested.provider, provider.id)
  assert.equal(untested.configRevision, provider.configRevision)
  assert.equal(untested.readiness, null)
})

test('legacy model chat binds a same-named model to the selected Provider UUID', async () => {
  const hits = { primary: 0, selected: 0 }
  const createUpstream = (name) => http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    hits[name] += 1
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { content: name }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
  const primaryUpstream = createUpstream('primary')
  const selectedUpstream = createUpstream('selected')
  await Promise.all([
    new Promise((resolve) => primaryUpstream.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => selectedUpstream.listen(0, '127.0.0.1', resolve)),
  ])

  try {
    const session = issueTestSession({ email: 'legacy-provider-binding@example.com' })
    upsertModelProvider({
      userId: session.userId,
      provider: {
        key: 'legacy-chat-primary',
        baseUrl: `http://127.0.0.1:${primaryUpstream.address().port}/v1`,
        models: ['shared-legacy-model'],
        defaultModel: 'shared-legacy-model',
        enabled: true,
        isDefault: true,
      },
    })
    const selected = upsertModelProvider({
      userId: session.userId,
      provider: {
        key: 'legacy-chat-selected',
        baseUrl: `http://127.0.0.1:${selectedUpstream.address().port}/v1`,
        models: ['shared-legacy-model'],
        defaultModel: 'shared-legacy-model',
        enabled: true,
        isDefault: false,
      },
    })

    const response = await fetch(`${new URL(baseUrl).origin}/api/model/chat`, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'use the selected Provider' }],
        modelName: 'shared-legacy-model',
        modelProviderId: selected.id,
      }),
    })
    const responseBody = await response.json()
    assert.equal(response.status, 200, JSON.stringify(responseBody))
    assert.equal(responseBody.reply, 'selected')
    assert.deepEqual(hits, { primary: 0, selected: 1 })
  } finally {
    await Promise.all([
      new Promise((resolve) => primaryUpstream.close(resolve)),
      new Promise((resolve) => selectedUpstream.close(resolve)),
    ])
  }
})

test('model provider routes provide redacted user-scoped CRUD', async () => {
  const alice = issueTestSession({ email: 'model-route-alice@example.com' })
  const bob = issueTestSession({ email: 'model-route-bob@example.com' })

  const createdResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({
      key: 'route-provider',
      label: 'Route Provider',
      baseUrl: 'https://models.example.com/v1',
      apiKey: 'sk-route-secret',
      models: ['route-a', 'route-b'],
      defaultModel: 'route-b',
      headers: { 'X-Tenant': 'route-secret' },
      enabled: true,
      isDefault: true,
    }),
  })
  assert.equal(createdResponse.status, 200)
  const created = (await createdResponse.json()).provider
  assert.equal(created.hasApiKey, true)
  assert.equal('apiKey' in created, false)
  assert.notEqual(created.headers['X-Tenant'], 'route-secret')

  const aliceList = await (await fetch(baseUrl, { headers: headers(alice.token) })).json()
  assert.equal(aliceList.providers.length, 1)
  assert.equal(aliceList.providers[0].defaultModel, 'route-b')

  const bobList = await (await fetch(baseUrl, { headers: headers(bob.token) })).json()
  assert.deepEqual(bobList.providers, [])

  const bobDelete = await fetch(`${baseUrl}/${created.id}`, { method: 'DELETE', headers: headers(bob.token) })
  assert.equal(bobDelete.status, 404)

  const updatedResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ ...created, label: 'Updated Provider', apiKey: '' }),
  })
  assert.equal(updatedResponse.status, 200)
  const updated = (await updatedResponse.json()).provider
  assert.equal(updated.label, 'Updated Provider')
  assert.equal(updated.hasApiKey, true)

  const deleted = await fetch(`${baseUrl}/${created.id}`, { method: 'DELETE', headers: headers(alice.token) })
  assert.equal(deleted.status, 200)
  const empty = await (await fetch(baseUrl, { headers: headers(alice.token) })).json()
  assert.deepEqual(empty.providers, [])
})

test('model provider save requires the current config revision and returns 409 for stale updates', async () => {
  const { token } = issueTestSession({ email: 'model-route-config-cas@example.com' })
  const createdResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      key: 'route-config-cas',
      label: 'Route config CAS',
      baseUrl: 'https://route-original.example.test/v1',
      apiKey: 'route-original-secret',
      headers: { 'X-Writer': 'original' },
      models: ['route-original-model'],
      defaultModel: 'route-original-model',
    }),
  })
  assert.equal(createdResponse.status, 200)
  const created = (await createdResponse.json()).provider
  const withoutRevision = { ...created }
  delete withoutRevision.configRevision

  const missingRevisionResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      ...withoutRevision,
      baseUrl: 'https://route-missing-revision.example.test/v1',
    }),
  })
  assert.equal(missingRevisionResponse.status, 409)
  const missingRevisionError = (await missingRevisionResponse.json()).error
  assert.equal(missingRevisionError.code, 'MODEL_PROVIDER_CONFIG_REVISION_REQUIRED')
  assert.equal(missingRevisionError.action, 'reload_model_provider')
  assert.equal(missingRevisionError.details.actualConfigRevision, created.configRevision)

  const createdUpdate = { ...created }
  delete createdUpdate.headers
  const winnerResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      ...createdUpdate,
      baseUrl: 'https://route-winner.example.test/v1',
      apiKey: 'route-winner-secret',
      headerUpdates: { 'X-Writer': 'winner' },
      models: ['route-winner-model'],
      defaultModel: 'route-winner-model',
    }),
  })
  assert.equal(winnerResponse.status, 200)
  const winner = (await winnerResponse.json()).provider
  assert.equal(winner.configRevision, created.configRevision + 1)

  const staleResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      ...createdUpdate,
      baseUrl: 'https://route-stale.example.test/v1',
      apiKey: 'route-stale-secret',
      headerUpdates: { 'X-Writer': 'stale' },
      models: ['route-stale-model'],
      defaultModel: 'route-stale-model',
    }),
  })
  assert.equal(staleResponse.status, 409)
  const staleError = (await staleResponse.json()).error
  assert.equal(staleError.code, 'MODEL_PROVIDER_CONFIG_CHANGED')
  assert.equal(staleError.action, 'reload_model_provider')
  assert.deepEqual(staleError.details, {
    expectedConfigRevision: created.configRevision,
    actualConfigRevision: winner.configRevision,
  })

  const listed = await (await fetch(baseUrl, { headers: headers(token) })).json()
  const stored = listed.providers.find((provider) => provider.id === created.id)
  assert.equal(stored.configRevision, winner.configRevision)
  assert.equal(stored.baseUrl, 'https://route-winner.example.test/v1')
  assert.deepEqual(stored.models, ['route-winner-model'])
})

test('model provider discovery reads a local OpenAI-compatible catalog without an API key', async () => {
  let receivedAuthorization = null
  const modelServer = http.createServer((req, res) => {
    receivedAuthorization = req.headers.authorization || null
    if (req.url !== '/v1/models') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [
      { id: 'qwen3:8b', context_length: 8192, max_output_tokens: 2048 },
      { id: 'deepseek-r1:7b', top_provider: { context_length: 131072, max_completion_tokens: 16384 } },
    ] }))
  })
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve))

  try {
    const { token } = issueTestSession({ email: 'model-route-discovery@example.com' })
    const response = await fetch(`${baseUrl}/discover`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, apiKey: '' }),
    })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.deepEqual(data.models, ['qwen3:8b', 'deepseek-r1:7b'])
    assert.deepEqual(data.modelProfiles, {
      'qwen3:8b': { contextWindow: 8192, maxOutputTokens: 2048, source: 'models-endpoint' },
      'deepseek-r1:7b': { contextWindow: 131072, maxOutputTokens: 16384, source: 'models-endpoint' },
    })
    assert.equal(receivedAuthorization, null)
  } finally {
    await new Promise((resolve) => modelServer.close(resolve))
  }
})

test('model provider discovery honors credential clearing and merges Header updates', async () => {
  const received = []
  const modelServer = http.createServer((req, res) => {
    received.push({
      authorization: req.headers.authorization || null,
      savedHeader: req.headers['x-saved-auth'] || null,
      newHeader: req.headers['x-new-auth'] || null,
      replacementHeader: req.headers['x-replace-auth'] || null,
    })
    if (req.url !== '/v1/models') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'local-model' }] }))
  })
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve))

  try {
    const session = issueTestSession({ email: 'model-route-clear-discovery@example.com' })
    const providerBaseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`
    const provider = upsertModelProvider({
      userId: session.userId,
      provider: {
        key: 'clear-discovery',
        label: 'Clear Discovery',
        baseUrl: providerBaseUrl,
        apiKey: 'saved-api-key',
        headers: {
          'X-Saved-Auth': 'saved-header-value',
          'X-Replace-Auth': 'saved-replacement-value',
        },
        models: ['local-model'],
      },
    })

    const cleared = await fetch(`${baseUrl}/discover`, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({
        id: provider.id,
        baseUrl: providerBaseUrl,
        apiKey: '',
        headers: {},
        clearApiKey: true,
        clearHeaders: true,
      }),
    })
    assert.equal(cleared.status, 200)
    assert.deepEqual(received.at(-1), {
      authorization: null,
      savedHeader: null,
      newHeader: null,
      replacementHeader: null,
    })

    const merged = await fetch(`${baseUrl}/discover`, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({
        id: provider.id,
        baseUrl: providerBaseUrl,
        apiKey: '',
        headers: { 'X-New-Auth': 'new-header-value' },
      }),
    })
    assert.equal(merged.status, 200)
    assert.deepEqual(received.at(-1), {
      authorization: 'Bearer saved-api-key',
      savedHeader: 'saved-header-value',
      newHeader: 'new-header-value',
      replacementHeader: 'saved-replacement-value',
    })

    const removedThenUpdated = await fetch(`${baseUrl}/discover`, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({
        id: provider.id,
        baseUrl: providerBaseUrl,
        removeHeaderKeys: [' x-saved-auth ', 'X-REPLACE-AUTH'],
        headerUpdates: { 'x-replace-auth': 'replacement-header-value' },
      }),
    })
    assert.equal(removedThenUpdated.status, 200)
    const responseText = await removedThenUpdated.text()
    assert.doesNotMatch(
      responseText,
      /saved-api-key|saved-header-value|saved-replacement-value|replacement-header-value/,
    )
    assert.deepEqual(received.at(-1), {
      authorization: 'Bearer saved-api-key',
      savedHeader: null,
      newHeader: null,
      replacementHeader: 'replacement-header-value',
    })
  } finally {
    await new Promise((resolve) => modelServer.close(resolve))
  }
})

test('model provider discovery rejects malformed custom Headers with structured field errors', async () => {
  const { token } = issueTestSession({ email: 'model-route-header-validation@example.com' })
  const cases = [
    [null, 'MODEL_PROVIDER_HEADERS_TYPE_INVALID'],
    [[], 'MODEL_PROVIDER_HEADERS_TYPE_INVALID'],
    ['X-Test: value', 'MODEL_PROVIDER_HEADERS_TYPE_INVALID'],
    [{ '': 'empty' }, 'MODEL_PROVIDER_HEADER_NAME_INVALID'],
    [{ 'X-Test\r\nInjected': 'unsafe' }, 'MODEL_PROVIDER_HEADER_NAME_INVALID'],
    [{ 'X-Unsafe': 'ok\r\ninjected' }, 'MODEL_PROVIDER_HEADER_VALUE_INVALID'],
  ]

  for (const [customHeaders, code] of cases) {
    const response = await fetch(`${baseUrl}/discover`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        baseUrl: 'http://127.0.0.1:1/v1',
        headers: customHeaders,
      }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, code)
    assert.equal(body.error.field, 'headers')
  }

  for (const [removeHeaderKeys, code] of [
    [null, 'MODEL_PROVIDER_HEADERS_TYPE_INVALID'],
    [['X-Valid', 1], 'MODEL_PROVIDER_HEADERS_TYPE_INVALID'],
    [['X Invalid'], 'MODEL_PROVIDER_HEADER_NAME_INVALID'],
  ]) {
    const response = await fetch(`${baseUrl}/discover`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        baseUrl: 'http://127.0.0.1:1/v1',
        removeHeaderKeys,
      }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, code)
    assert.equal(body.error.field, 'removeHeaderKeys')
  }
})

test('model provider save maps custom Header validation failures to stable API errors', async () => {
  const { token } = issueTestSession({ email: 'model-route-save-header-validation@example.com' })
  const cases = [
    [[], 'MODEL_PROVIDER_HEADERS_TYPE_INVALID'],
    [{ 'X-Test\r\nInjected': 'unsafe' }, 'MODEL_PROVIDER_HEADER_NAME_INVALID'],
    [{ 'X-Unsafe': 'ok\r\ninjected' }, 'MODEL_PROVIDER_HEADER_VALUE_INVALID'],
  ]

  for (const [index, [customHeaders, code]] of cases.entries()) {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        key: `invalid-headers-${index}`,
        baseUrl: 'https://models.example.test/v1',
        models: ['model-a'],
        headers: customHeaders,
      }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, code)
    assert.equal(body.error.field, 'headers')
  }


  for (const [index, [removeHeaderKeys, code]] of [
    [{ key: 'not-an-array' }, 'MODEL_PROVIDER_HEADERS_TYPE_INVALID'],
    [['X-Valid', false], 'MODEL_PROVIDER_HEADERS_TYPE_INVALID'],
    [['X Invalid'], 'MODEL_PROVIDER_HEADER_NAME_INVALID'],
  ].entries()) {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        key: `invalid-remove-headers-${index}`,
        baseUrl: 'https://models.example.test/v1',
        models: ['model-a'],
        removeHeaderKeys,
      }),
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error.code, code)
    assert.equal(body.error.field, 'removeHeaderKeys')
  }

  const conflict = await fetch(baseUrl, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      key: 'conflicting-header-mutations',
      baseUrl: 'https://models.example.test/v1',
      models: ['model-a'],
      headers: {},
      removeHeaderKeys: [],
    }),
  })
  assert.equal(conflict.status, 400)
  const conflictBody = await conflict.json()
  assert.equal(conflictBody.error.code, 'MODEL_PROVIDER_HEADERS_CONFLICT')
  assert.equal(conflictBody.error.field, 'removeHeaderKeys')
})

test('provider test calls the selected provider chat endpoint even when it is disabled', async () => {
  let receivedAuthorization = null
  const receivedBodies = []
  const modelServer = http.createServer((req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    receivedAuthorization = req.headers.authorization || null
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const receivedBody = JSON.parse(body)
      receivedBodies.push(receivedBody)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{
          message: receivedBody.tools
            ? {
                content: null,
                tool_calls: [{
                  id: 'provider-probe-1',
                  type: 'function',
                  function: {
                    name: 'gugo_provider_probe',
                    arguments: receivedBody.model === 'invalid-tool-model'
                      ? '{"value":"ok","unexpected":true}'
                      : '{"value":"ok"}',
                  },
                }],
              }
            : { content: 'pong' },
        }],
      }))
    })
  })
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve))

  try {
    const { token } = issueTestSession({ email: 'model-route-selected-test@example.com' })
    await fetch(baseUrl, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        key: 'wrong-default',
        label: 'Wrong default',
        baseUrl: 'http://127.0.0.1:1/v1',
        models: ['wrong-model'],
        defaultModel: 'wrong-model',
        enabled: true,
        isDefault: true,
      }),
    })
    const selectedResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        key: 'selected-local',
        label: 'Selected local',
        baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
        apiKey: '',
        models: ['default-model', 'qwen3:8b'],
        defaultModel: 'default-model',
        enabled: false,
        isDefault: false,
      }),
    })
    assert.equal(selectedResponse.status, 200)
    const selected = (await selectedResponse.json()).provider

    const testResponse = await fetch(`${baseUrl}/${selected.id}/test`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ modelName: 'qwen3:8b' }),
    })
    assert.equal(testResponse.status, 200)
    const data = await testResponse.json()
    assert.equal(data.ok, true)
    assert.equal(data.modelName, 'qwen3:8b')
    assert.equal(data.endpoint.model, 'qwen3:8b')
    assert.equal(data.reply, 'pong')
    assert.deepEqual(data.capabilities, { chat: true, tools: true, agent: true, mode: 'agent' })
    assert.equal(receivedAuthorization, null)
    assert.equal(receivedBodies.length, 2)
    assert.equal(receivedBodies[0].model, 'qwen3:8b')
    assert.equal(receivedBodies[0].messages[0].content, 'Reply with only: pong')
    assert.equal(receivedBodies[0].max_tokens, 512)
    assert.equal(receivedBodies[1].tools[0].function.name, 'gugo_provider_probe')
    assert.equal(receivedBodies[1].tool_choice.function.name, 'gugo_provider_probe')
    assert.equal(data.provider.readiness, null)
    assert.deepEqual(data.provider.modelReadiness['qwen3:8b'], data.readiness)

    const chatOnlyResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        key: 'selected-chat-only',
        label: 'Selected chat only',
        baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
        apiKey: '',
        models: ['chat-only-model'],
        defaultModel: 'chat-only-model',
        supportsTools: false,
        enabled: false,
        isDefault: false,
      }),
    })
    const chatOnly = (await chatOnlyResponse.json()).provider
    const beforeChatOnlyTest = receivedBodies.length
    const chatOnlyTestResponse = await fetch(`${baseUrl}/${chatOnly.id}/test`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ modelName: 'chat-only-model' }),
    })
    assert.equal(chatOnlyTestResponse.status, 200)
    const chatOnlyData = await chatOnlyTestResponse.json()
    assert.deepEqual(chatOnlyData.capabilities, {
      chat: true,
      tools: false,
      agent: false,
      mode: 'chat_only',
    })
    assert.equal(chatOnlyData.steps.find((step) => step.name === 'tools').errorCode, 'PROVIDER_TOOLS_DISABLED')
    assert.equal(receivedBodies.length, beforeChatOnlyTest + 1)

    const invalidToolResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        key: 'invalid-tool-provider',
        label: 'Invalid tool provider',
        baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
        apiKey: '',
        models: ['invalid-tool-model'],
        defaultModel: 'invalid-tool-model',
        supportsTools: true,
        enabled: false,
        isDefault: false,
      }),
    })
    const invalidToolProvider = (await invalidToolResponse.json()).provider
    const invalidToolTestResponse = await fetch(`${baseUrl}/${invalidToolProvider.id}/test`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ modelName: 'invalid-tool-model' }),
    })
    assert.equal(invalidToolTestResponse.status, 200)
    const invalidToolData = await invalidToolTestResponse.json()
    assert.deepEqual(invalidToolData.capabilities, {
      chat: true,
      tools: false,
      agent: false,
      mode: 'chat_only',
    })
    assert.equal(
      invalidToolData.steps.find((step) => step.name === 'tools').errorCode,
      'PROVIDER_TOOL_ARGUMENTS_INVALID',
    )
    assert.equal(invalidToolData.readiness.mode, 'chat_only')
    assert.equal(invalidToolData.readiness.tools, false)
  } finally {
    await new Promise((resolve) => modelServer.close(resolve))
  }
})

test('provider deletion returns a structured conflict while durable jobs still reference it', async () => {
  const session = issueTestSession({ email: 'model-route-delete-reference@example.com' })
  const provider = upsertModelProvider({
    userId: session.userId,
    provider: {
      key: 'route-referenced-provider',
      baseUrl: 'https://models.example.test/v1',
      models: ['route-referenced-model'],
      defaultModel: 'route-referenced-model',
    },
  })
  getDb().prepare(`
    INSERT INTO jobs (
      id, user_id, title, prompt, status, created_at, updated_at,
      model_name, model_provider_id, model_config_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'route-job-provider-reference', session.userId, 'Referenced job', 'Keep the binding', 'completed', 1, 1,
    'route-referenced-model', provider.id, provider.configRevision,
  )

  const response = await fetch(`${baseUrl}/${provider.id}`, {
    method: 'DELETE',
    headers: headers(session.token),
  })
  assert.equal(response.status, 409)
  assert.deepEqual((await response.json()).error, {
    code: 'MODEL_PROVIDER_IN_USE',
    message: '该模型 Provider 仍被 1 条任务或运行记录引用，请先清理相关记录。',
    action: 'clear_provider_references',
    providerId: provider.id,
    details: { total: 1, references: { jobs: 1 } },
  })
  assert.equal(
    getDb().prepare('SELECT model_provider_id FROM jobs WHERE id = ?').get('route-job-provider-reference')?.model_provider_id,
    provider.id,
  )
})

test('provider test rejects a stale probe when the configuration changes in flight', async () => {
  let releaseModelsProbe
  let markModelsProbeStarted
  const modelsProbeReleased = new Promise((resolve) => { releaseModelsProbe = resolve })
  const modelsProbeStarted = new Promise((resolve) => { markModelsProbeStarted = resolve })
  const modelServer = http.createServer((req, res) => {
    if (req.url === '/v1/models' && req.method === 'GET') {
      markModelsProbeStarted()
      void modelsProbeReleased.then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'revision-model' }] }))
      })
      return
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }))
    })
  })
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve))

  try {
    const { token } = issueTestSession({ email: 'model-route-stale-probe@example.com' })
    const providerConfig = {
      key: 'stale-probe-provider',
      label: 'Stale probe provider',
      baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
      models: ['revision-model'],
      defaultModel: 'revision-model',
      supportsTools: false,
      enabled: true,
    }
    const savedResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify(providerConfig),
    })
    assert.equal(savedResponse.status, 200)
    const original = (await savedResponse.json()).provider

    const testRequest = fetch(`${baseUrl}/${original.id}/test`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ modelName: 'revision-model' }),
    })
    let barrierTimeout
    try {
      await Promise.race([
        modelsProbeStarted,
        new Promise((_, reject) => {
          barrierTimeout = setTimeout(() => reject(new Error('provider probe did not start')), 5_000)
        }),
      ])
    } finally {
      clearTimeout(barrierTimeout)
    }

    const updatedResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        ...providerConfig,
        id: original.id,
        configRevision: original.configRevision,
        label: 'Updated during probe',
        supportsStreaming: false,
      }),
    })
    assert.equal(updatedResponse.status, 200)
    const updated = (await updatedResponse.json()).provider
    assert.equal(updated.configRevision, original.configRevision + 1)
    assert.equal(updated.readiness, null)

    releaseModelsProbe()
    const testResponse = await testRequest
    assert.equal(testResponse.status, 409)
    assert.deepEqual((await testResponse.json()).error, {
      code: 'MODEL_PROVIDER_CONFIG_CHANGED',
      message: 'Provider 配置在测试期间已变更，本次测试结果未保存；请重新测试最新配置。',
    })

    const listed = await (await fetch(baseUrl, { headers: headers(token) })).json()
    const latest = listed.providers.find((provider) => provider.id === original.id)
    assert.equal(latest.configRevision, updated.configRevision)
    assert.equal(latest.readiness, null)
  } finally {
    releaseModelsProbe()
    await new Promise((resolve) => modelServer.close(resolve))
  }
})

test('provider test classifies authentication failures without echoing credentials', async () => {
  const apiKey = 'sk-provider-secret-value'
  const headerSecret = 'custom-header-secret-value'
  const { token } = issueTestSession({ email: 'model-route-auth-failure@example.com' })
  const modelServer = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: {
        code: apiKey,
        message: `invalid credentials: ${apiKey}; ${headerSecret}`,
      },
    }))
  })
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve))

  try {
    const savedResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        key: 'auth-failure-provider',
        label: 'Auth failure provider',
        baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`,
        apiKey,
        headers: { 'X-Custom-Auth': headerSecret },
        models: ['auth-model'],
        defaultModel: 'auth-model',
        supportsTools: true,
      }),
    })
    assert.equal(savedResponse.status, 200)
    const provider = (await savedResponse.json()).provider

    const response = await fetch(`${baseUrl}/${provider.id}/test`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ modelName: 'auth-model' }),
    })
    assert.equal(response.status, 502)
    const text = await response.text()
    assert.equal(text.includes(apiKey), false)
    assert.equal(text.includes(headerSecret), false)
    const data = JSON.parse(text)
    const reachable = data.steps.find((step) => step.name === 'reachable')
    const completion = data.steps.find((step) => step.name === 'completion')
    assert.equal(reachable.errorCode, 'PROVIDER_AUTH_FAILED')
    assert.equal(completion.errorCode, 'PROVIDER_AUTH_FAILED')
    assert.match(completion.error, /API Key/)
    assert.deepEqual(data.capabilities, {
      chat: false,
      tools: false,
      agent: false,
      mode: 'unavailable',
    })
  } finally {
    await new Promise((resolve) => modelServer.close(resolve))
  }
})

test('provider test requires an explicit model from the provider catalog', async () => {
  const { token } = issueTestSession({ email: 'model-route-test-target@example.com' })
  const savedResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      key: 'test-target-provider',
      label: 'Test target provider',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: ['catalog-a', 'catalog-b'],
      defaultModel: 'catalog-a',
    }),
  })
  assert.equal(savedResponse.status, 200)
  const provider = (await savedResponse.json()).provider

  for (const [body, code] of [
    [{}, 'MODEL_PROVIDER_MODEL_REQUIRED'],
    [{ modelName: ['catalog-a'] }, 'MODEL_PROVIDER_MODEL_INVALID'],
    [{ modelName: 'not-in-catalog' }, 'MODEL_PROVIDER_MODEL_INVALID'],
  ]) {
    const response = await fetch(`${baseUrl}/${provider.id}/test`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 400)
    assert.deepEqual((await response.json()).error, {
      code,
      message: code === 'MODEL_PROVIDER_MODEL_REQUIRED'
        ? '请选择要测试的模型'
        : '测试模型必须属于当前 Provider 的模型列表',
      field: 'modelName',
    })
  }
})

test('model provider routes return structured validation and method errors', async () => {
  const { token } = issueTestSession({ email: 'model-route-errors@example.com' })
  const invalid = await fetch(baseUrl, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ key: '../bad', baseUrl: 'file:///tmp/model', apiKey: 'x', models: ['m'] }),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'INVALID_PROVIDER')

  const unsupported = await fetch(baseUrl, { method: 'PUT', headers: headers(token), body: '{}' })
  assert.equal(unsupported.status, 405)
  assert.equal((await unsupported.json()).error.code, 'METHOD_NOT_ALLOWED')
})

test('model provider save and discovery reject unsafe Base URLs before contacting them', async () => {
  const { token } = issueTestSession({ email: 'model-route-unsafe-url@example.com' })
  const unsafe = [
    ['https://user:secret@models.example.com/v1', 'MODEL_PROVIDER_BASE_URL_CREDENTIALS'],
    ['https://models.example.com/v1?token=secret', 'MODEL_PROVIDER_BASE_URL_QUERY'],
    ['https://models.example.com/v1#credentials', 'MODEL_PROVIDER_BASE_URL_FRAGMENT'],
  ]
  for (const [index, [candidate, code]] of unsafe.entries()) {
    const saved = await fetch(baseUrl, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ key: `unsafe-${index}`, baseUrl: candidate, models: ['m'] }),
    })
    assert.equal(saved.status, 400)
    const saveError = (await saved.json()).error
    assert.equal(saveError.code, code)
    assert.equal(saveError.field, 'baseUrl')

    const discovered = await fetch(`${baseUrl}/discover`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ baseUrl: candidate }),
    })
    assert.equal(discovered.status, 400)
    const discoveryError = (await discovered.json()).error
    assert.equal(discoveryError.code, code)
    assert.equal(discoveryError.field, 'baseUrl')
  }
})
