import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-audit-routes-'))
process.env.APP_DATA_DIR = tempDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { writeToolAudit } = await import('../server/utils/audit.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('audit query is authenticated, user isolated, filtered, and secret safe', async () => {
  const alice = issueTestSession({ email: 'audit-alice@example.com' })
  const bob = issueTestSession({ email: 'audit-bob@example.com' })
  const createdAt = Date.now()
  writeToolAudit({
    userId: alice.userId,
    origin: 'chat',
    toolName: 'bash_exec',
    callId: 'alice-call',
    stage: 'denied',
    args: {
      command: 'deploy',
      apiKey: 'sk-alice-secret',
      nested: { authorization: 'Bearer alice-token', cookie: 'session=alice' },
    },
    result: { error: 'x'.repeat(700), token: 'result-token' },
    status: 'denied',
    createdAt,
  })
  writeToolAudit({
    userId: bob.userId,
    origin: 'chat',
    toolName: 'bash_exec',
    callId: 'bob-call',
    stage: 'denied',
    args: { password: 'bob-secret' },
    status: 'denied',
    createdAt,
  })

  const unauthenticated = await fetch(`${origin}/api/audit`)
  assert.equal(unauthenticated.status, 401)

  const response = await fetch(
    `${origin}/api/audit?tool=bash_exec&stage=denied&from=${createdAt - 1}&to=${createdAt + 1}&limit=20`,
    { headers: { Authorization: `Bearer ${alice.token}` } },
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.entries.length, 1)
  assert.equal(body.entries[0].callId, 'alice-call')
  assert.equal(body.entries[0].args.apiKey, '[REDACTED]')
  assert.equal(body.entries[0].args.nested.authorization, '[REDACTED]')
  assert.equal(body.entries[0].args.nested.cookie, '[REDACTED]')
  assert.ok(body.entries[0].resultPreview.length <= 500)
  assert.doesNotMatch(JSON.stringify(body), /sk-alice-secret|alice-token|result-token|bob-secret/u)
})

test('audit query rejects invalid filters and unsupported methods', async () => {
  const session = issueTestSession({ email: 'audit-validation@example.com' })
  const headers = { Authorization: `Bearer ${session.token}` }
  const invalid = await fetch(`${origin}/api/audit?stage=unknown`, { headers })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'INVALID_AUDIT_FILTER')
  const method = await fetch(`${origin}/api/audit`, { method: 'POST', headers })
  assert.equal(method.status, 405)
})
