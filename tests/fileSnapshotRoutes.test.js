import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-snapshot-routes-'))

const ENV_KEYS = ['APP_DATA_DIR', 'GUGO_LOAD_DOTENV', 'AUTH_MODE', 'SERVER_HOST']
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
process.env.APP_DATA_DIR = path.join(tempDir, 'data')
process.env.GUGO_LOAD_DOTENV = '0'
process.env.AUTH_MODE = 'local'
process.env.SERVER_HOST = '127.0.0.1'

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { finalizeFileSnapshot, recordFileSnapshot } = await import('../server/services/fileSnapshotStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => process.env })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function headers(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

test('snapshot endpoints require authentication', async () => {
  const list = await fetch(`${origin}/api/snapshots?sessionId=s&turnId=t`)
  assert.equal(list.status, 401)
  const rewind = await fetch(`${origin}/api/snapshots/rewind`, { method: 'POST' })
  assert.equal(rewind.status, 401)
})

test('list and rewind return owner-scoped results', async () => {
  const { token, userId } = issueTestSession({ email: 'snap-route@example.com' })
  const filePath = path.join(tempDir, 'route-file.txt')
  fs.writeFileSync(filePath, 'before', 'utf8')
  const snapshot = recordFileSnapshot({
    userId,
    sessionId: 'route-session',
    turnId: 'route-turn',
    toolCallId: 'route-call-1',
    toolName: 'edit_file',
    filePath,
    beforeContent: 'before',
  })

  const list = await fetch(`${origin}/api/snapshots?sessionId=route-session&turnId=route-turn`, {
    headers: headers(token),
  })
  assert.equal(list.status, 200)
  const listed = await list.json()
  assert.equal(listed.snapshots.length, 1)
  assert.equal(listed.snapshots[0].toolCallId, 'route-call-1')

  fs.writeFileSync(filePath, 'after', 'utf8')
  finalizeFileSnapshot({
    userId,
    id: snapshot.id,
    afterExists: true,
    afterSha256: createHash('sha256').update('after').digest('hex'),
    afterBytes: Buffer.byteLength('after'),
  })
  const rewind = await fetch(`${origin}/api/snapshots/rewind`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ sessionId: 'route-session', turnId: 'route-turn', toolCallId: 'route-call-1' }),
  })
  assert.equal(rewind.status, 200)
  const result = await rewind.json()
  assert.equal(result.found, true)
  assert.equal(result.count, 1)
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'before')
})

test('rewind route returns 409 and preserves a later user edit', async () => {
  const { token, userId } = issueTestSession({ email: 'snap-route-conflict@example.com' })
  const filePath = path.join(tempDir, 'route-conflict.txt')
  fs.writeFileSync(filePath, 'before', 'utf8')
  const snapshot = recordFileSnapshot({
    userId,
    sessionId: 'route-conflict-session',
    turnId: 'route-conflict-turn',
    toolCallId: 'route-conflict-call',
    toolName: 'edit_file',
    filePath,
    beforeContent: 'before',
  })
  fs.writeFileSync(filePath, 'tool-output', 'utf8')
  finalizeFileSnapshot({
    userId,
    id: snapshot.id,
    afterExists: true,
    afterSha256: createHash('sha256').update('tool-output').digest('hex'),
    afterBytes: Buffer.byteLength('tool-output'),
  })
  fs.writeFileSync(filePath, 'user-output', 'utf8')

  const response = await fetch(`${origin}/api/snapshots/rewind`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      sessionId: 'route-conflict-session',
      turnId: 'route-conflict-turn',
      toolCallId: 'route-conflict-call',
    }),
  })
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.error.code, 'FILE_SNAPSHOT_CONFLICT')
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'user-output')
})
