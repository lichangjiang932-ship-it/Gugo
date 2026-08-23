import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-capability-routes-'))
const previousDataDir = process.env.APP_DATA_DIR
process.env.APP_DATA_DIR = tempDir

const { handleCapabilityInventoryRequest } = await import('../server/routes/capabilityInventoryRoutes.js')
const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

test.after(() => {
  closeDb()
  if (previousDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = previousDataDir
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function invoke({ method = 'GET', url = '/api/capabilities/effective', token, listCapabilities } = {}) {
  let body = ''
  const response = {
    statusCode: 0,
    headers: {},
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      this.headers = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
      )
    },
    end(chunk = '') { body += String(chunk) },
  }
  const request = {
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }
  handleCapabilityInventoryRequest(request, response, { listCapabilities })
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: JSON.parse(body),
  }
}

test('effective capability route enforces auth, method, and empty query input', () => {
  const unauthorized = invoke({ listCapabilities: () => [] })
  assert.equal(unauthorized.statusCode, 401)
  assert.equal(unauthorized.body.error.code, 'UNAUTHORIZED')

  const { token } = issueTestSession({ email: 'capability-route-guards@example.com' })
  const wrongMethod = invoke({ method: 'POST', token, listCapabilities: () => [] })
  assert.equal(wrongMethod.statusCode, 405)
  assert.equal(wrongMethod.body.error.code, 'METHOD_NOT_ALLOWED')
  assert.equal(wrongMethod.headers.allow, 'GET')

  const invalidQuery = invoke({ url: '/api/capabilities/effective?userId=other', token, listCapabilities: () => [] })
  assert.equal(invalidQuery.statusCode, 400)
  assert.equal(invalidQuery.body.error.code, 'INVALID_QUERY')

  for (const response of [unauthorized, wrongMethod, invalidQuery]) {
    assert.equal(response.headers['cache-control'], 'private, no-store')
  }
})

test('effective capability route returns the authenticated tenant snapshot', () => {
  const { token, userId } = issueTestSession({ email: 'capability-route-success@example.com' })
  let receivedScope
  const response = invoke({
    token,
    listCapabilities: (scope) => {
      receivedScope = scope
      return [{ key: 'skill:writer' }]
    },
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(receivedScope, { userId })
  assert.equal(response.body.ok, true)
  assert.equal(response.body.schemaVersion, 1)
  assert.deepEqual(response.body.capabilities, [{ key: 'skill:writer' }])
  assert.equal(response.headers['cache-control'], 'private, no-store')
})

test('effective capability route hides inventory failures', () => {
  const { token } = issueTestSession({ email: 'capability-route-error@example.com' })
  const response = invoke({
    token,
    listCapabilities: () => { throw new Error('secret implementation detail') },
  })

  assert.equal(response.statusCode, 500)
  assert.equal(response.body.error.code, 'CAPABILITY_INVENTORY_FAILED')
  assert.doesNotMatch(JSON.stringify(response.body), /secret implementation detail/u)
  assert.equal(response.headers['cache-control'], 'private, no-store')
})

test('real app route serves the effective inventory without duplicate keys or secret fields', async () => {
  const { token } = issueTestSession({ email: 'capability-route-integration@example.com' })
  const server = createAppServer({
    getEnv: () => ({ APP_DATA_DIR: tempDir, GUGO_LOAD_DOTENV: '0' }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/capabilities/effective`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.schemaVersion, 1)
    assert.equal(Array.isArray(body.capabilities), true)
    const keys = body.capabilities.map((entry) => entry.key)
    assert.deepEqual(keys, [...new Set(keys)].sort())
    for (const entry of body.capabilities) {
      for (const forbidden of ['args', 'command', 'env', 'headers', 'url', 'userId']) {
        assert.equal(Object.hasOwn(entry, forbidden), false)
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
