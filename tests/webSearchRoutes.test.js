import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-web-search-routes-'))
process.env.APP_DATA_DIR = dir
process.env.APP_DB_PATH = path.join(dir, 'app.db')

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/api/web-search`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

function auth(token, json = false) {
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}` }
}

test('provider catalog is public but saved configuration requires authentication', async () => {
  const providers = await (await fetch(`${baseUrl}/providers`)).json()
  assert.deepEqual(providers.providers.map((item) => item.id), ['tavily', 'brave', 'serper', 'bing', 'google_cse', 'custom'])
  assert.equal((await fetch(baseUrl)).status, 401)
  assert.equal((await fetch(baseUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
})

test('configuration routes are redacted and isolated by user', async () => {
  const alice = issueTestSession({ email: 'web-search-route-alice@example.com' })
  const bob = issueTestSession({ email: 'web-search-route-bob@example.com' })
  const savedResponse = await fetch(baseUrl, {
    method: 'PUT', headers: auth(alice.token, true),
    body: JSON.stringify({ provider: 'brave', enabled: true, apiKey: 'route-secret', config: {} }),
  })
  assert.equal(savedResponse.status, 200)
  const saved = (await savedResponse.json()).config
  assert.equal(saved.apiKeyPresent, true)
  assert.equal(JSON.stringify(saved).includes('route-secret'), false)

  const aliceConfig = (await (await fetch(baseUrl, { headers: auth(alice.token) })).json()).config
  const bobConfig = (await (await fetch(baseUrl, { headers: auth(bob.token) })).json()).config
  assert.equal(aliceConfig.provider, 'brave')
  assert.equal(bobConfig, null)

  const removed = await (await fetch(baseUrl, { method: 'DELETE', headers: auth(alice.token) })).json()
  assert.equal(removed.removed, true)
  assert.equal((await (await fetch(baseUrl, { headers: auth(alice.token) })).json()).config, null)
})

test('route validates custom templates without echoing secrets', async () => {
  const user = issueTestSession({ email: 'web-search-route-custom@example.com' })
  const response = await fetch(baseUrl, {
    method: 'PUT', headers: auth(user.token, true),
    body: JSON.stringify({
      provider: 'custom', enabled: true, apiKey: 'never-echo',
      config: { baseUrl: 'http://127.0.0.1/search', method: 'PATCH', headersTemplate: '{}' },
    }),
  })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.code, 'WEB_SEARCH_CONFIG_INVALID')
  assert.equal(JSON.stringify(body).includes('never-echo'), false)
})
