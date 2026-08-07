import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-model-provider-routes-'))
process.env.APP_DATA_DIR = dir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/api/model/providers`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function headers(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

test('model provider routes require authentication', async () => {
  const response = await fetch(baseUrl)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED')
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

test('model provider discovery reads a local OpenAI-compatible catalog without an API key', async () => {
  let receivedAuthorization = null
  const modelServer = http.createServer((req, res) => {
    receivedAuthorization = req.headers.authorization || null
    if (req.url !== '/v1/models') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'qwen3:8b' }, { id: 'deepseek-r1:7b' }] }))
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
    assert.equal(receivedAuthorization, null)
  } finally {
    await new Promise((resolve) => modelServer.close(resolve))
  }
})

test('provider test calls the selected provider chat endpoint even when it is disabled', async () => {
  let receivedAuthorization = null
  let receivedBody = null
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
      receivedBody = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }))
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
        models: ['qwen3:8b'],
        defaultModel: 'qwen3:8b',
        enabled: false,
        isDefault: false,
      }),
    })
    assert.equal(selectedResponse.status, 200)
    const selected = (await selectedResponse.json()).provider

    const testResponse = await fetch(`${baseUrl}/${selected.id}/test`, {
      method: 'POST',
      headers: headers(token),
    })
    assert.equal(testResponse.status, 200)
    const data = await testResponse.json()
    assert.equal(data.ok, true)
    assert.equal(data.endpoint.model, 'qwen3:8b')
    assert.equal(data.reply, 'pong')
    assert.equal(receivedAuthorization, null)
    assert.equal(receivedBody.model, 'qwen3:8b')
    assert.equal(receivedBody.messages[0].content, 'Reply with only: pong')
    assert.equal(receivedBody.max_tokens, 512)
  } finally {
    await new Promise((resolve) => modelServer.close(resolve))
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
