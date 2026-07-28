import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-browser-routes-'))
process.env.APP_DATA_DIR = dir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { upsertIntegration } = await import('../server/services/integrationsStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/api/browser/state`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('browser state keeps GET compatibility and exposes POST tool result', async () => {
  const { token } = issueTestSession({ email: 'browser-state@example.com' })
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  const getResponse = await fetch(baseUrl, { headers })
  assert.equal(getResponse.status, 200)
  assert.deepEqual((await getResponse.json()).state, { connected: false })

  const postResponse = await fetch(baseUrl, { method: 'POST', headers, body: '{}' })
  assert.equal(postResponse.status, 200)
  assert.deepEqual((await postResponse.json()).result, { connected: false })
})

test('browser state is blocked when Browser is disabled in Access', async () => {
  const { token, userId } = issueTestSession({ email: 'browser-disabled@example.com' })
  upsertIntegration({ userId, provider: 'browser', enabled: false })
  const response = await fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' })
  assert.equal(response.status, 403)
  assert.match((await response.json()).error, /disabled/i)
})

test('browser open cannot bypass a managed app connection', async () => {
  const { token } = issueTestSession({ email: 'browser-managed-app@example.com' })
  const response = await fetch(baseUrl.replace('/state', '/open'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: 'https://mail.google.com/' }),
  })
  assert.equal(response.status, 409)
  assert.match((await response.json()).error, /not connected/i)
})
