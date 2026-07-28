import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-browser-app-routes-'))
process.env.APP_DB_PATH = path.join(dir, 'app.db')

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('generic integrations endpoint cannot forge a Browser app connection', async () => {
  const { token } = issueTestSession({ email: 'browser-app-route@example.com' })
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const created = await fetch(`${baseUrl}/api/integrations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ provider: 'web_gmail', enabled: true }),
  })
  assert.equal(created.status, 400)
  assert.match((await created.json()).error, /connectors\/apps\/connect/)

  const listed = await fetch(`${baseUrl}/api/integrations?kind=browser_app`, { headers })
  assert.equal(listed.status, 200)
  assert.deepEqual((await listed.json()).integrations, [])
})
