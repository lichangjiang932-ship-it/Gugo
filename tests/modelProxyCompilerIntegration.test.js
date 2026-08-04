import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-model-proxy-compiler-'))

let mockRequests = 0
const mockModel = http.createServer((req, res) => {
  mockRequests += 1
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }))
  })
})
await new Promise((resolve) => mockModel.listen(0, '127.0.0.1', resolve))
const mockPort = mockModel.address().port

process.env.MODEL_BASE_URL = `http://127.0.0.1:${mockPort}/v1`
process.env.MODEL_NAME = 'gpt-test'
process.env.MODEL_API_KEY = 'sk-test'
process.env.MODEL_PROVIDERS = ''

const { createAppServer } = await import('../server/appServer.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { createAgent, updateAgent } = await import('../server/services/agentStore.js')
const { clearPromptCompilerCache } = await import('../server/services/promptCompiler.js')

async function postModelTest({ baseUrl, token, body }) {
  const response = await fetch(`${baseUrl}/api/model/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  return response.json()
}

test('testMode model request returns compiler fingerprints and isolates soul changes', async () => {
  clearPromptCompilerCache()
  const { token, userId } = issueTestSession()
  const agent = createAgent({
    userId,
    name: 'Compiler Agent',
    soulMd: 'Soul v1',
    identityMd: 'Identity v1',
    isDefault: true,
  })

  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  try {
    const first = await postModelTest({ baseUrl, token, body: { agentId: agent.id } })
    assert.deepEqual(Object.keys(first.compilerFingerprints).sort(), ['identity', 'ishiki', 'sessions', 'skills'])

    const second = await postModelTest({ baseUrl, token, body: { agentId: agent.id } })
    assert.equal(second.compilerFingerprints.identity, first.compilerFingerprints.identity)
    assert.equal(second.compilerFingerprints.ishiki, first.compilerFingerprints.ishiki)

    updateAgent({ userId, id: agent.id, patch: { soulMd: 'Soul v2' } })
    const third = await postModelTest({ baseUrl, token, body: { agentId: agent.id } })
    assert.equal(third.compilerFingerprints.identity, first.compilerFingerprints.identity)
    assert.notEqual(third.compilerFingerprints.ishiki, first.compilerFingerprints.ishiki)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('model test rejects anonymous requests before contacting the upstream model', async () => {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const before = mockRequests
  try {
    const response = await fetch(`${baseUrl}/api/model/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 401)
    assert.equal(mockRequests, before)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('model test rate limits authenticated callers', async () => {
  const previous = process.env.MODEL_TEST_RATE_MAX
  process.env.MODEL_TEST_RATE_MAX = '2'
  const { token } = issueTestSession()
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${baseUrl}/api/model/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      })
      assert.equal(response.status, 200)
    }
    const blocked = await fetch(`${baseUrl}/api/model/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    })
    assert.equal(blocked.status, 429)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (previous == null) delete process.env.MODEL_TEST_RATE_MAX
    else process.env.MODEL_TEST_RATE_MAX = previous
  }
})

test.after(async () => {
  await new Promise((resolve) => mockModel.close(resolve))
  try { fs.rmSync(process.env.APP_DATA_DIR, { recursive: true, force: true }) } catch { /* best effort */ }
})
