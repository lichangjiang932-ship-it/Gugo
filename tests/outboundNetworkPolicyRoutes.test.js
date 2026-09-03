import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-network-policy-routes-'))
const dataDir = path.join(tempDir, 'data')
const previousDataDir = process.env.APP_DATA_DIR
const previousPureLocal = process.env.GUGO_PURE_LOCAL_MODE
process.env.APP_DATA_DIR = dataDir
delete process.env.GUGO_PURE_LOCAL_MODE

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { activateTestCompactionArchivePort } = await import('./helpers/testCompactionArchivePort.js')

let localOwnerId = ''
const compactionArchiveController = activateTestCompactionArchivePort({ env: { APP_DATA_DIR: dataDir } })
const server = createAppServer({
  getEnv: () => ({
    APP_DATA_DIR: dataDir,
    AUTH_MODE: 'local',
    GUGO_LOAD_DOTENV: '0',
    LOCAL_USER_ID: localOwnerId,
  }),
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  compactionArchiveController.release()
  closeDb()
  if (previousDataDir === undefined) delete process.env.APP_DATA_DIR
  else process.env.APP_DATA_DIR = previousDataDir
  if (previousPureLocal === undefined) delete process.env.GUGO_PURE_LOCAL_MODE
  else process.env.GUGO_PURE_LOCAL_MODE = previousPureLocal
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('network policy API is local-owner authoritative and round-trips persisted pure-local state', async () => {
  const owner = issueTestSession({ email: 'network-policy-owner@example.test' })
  localOwnerId = owner.userId
  const headers = {
    Authorization: `Bearer ${owner.token}`,
    'Content-Type': 'application/json',
  }

  const initialResponse = await fetch(`${origin}/api/system/network-policy`, { headers })
  assert.equal(initialResponse.status, 200)
  assert.equal(initialResponse.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual((await initialResponse.json()).policy, {
    mode: 'standard',
    pureLocal: false,
    locked: false,
    source: 'default',
    blockedErrorCode: 'OUTBOUND_PURE_LOCAL_DENIED',
  })

  const enableResponse = await fetch(`${origin}/api/system/network-policy`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ pureLocal: true }),
  })
  assert.equal(enableResponse.status, 200)
  assert.equal((await enableResponse.json()).policy.pureLocal, true)
  assert.equal(process.env.GUGO_PURE_LOCAL_MODE, '1')
  const configPath = path.join(dataDir, 'runtime.json')
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).env.GUGO_PURE_LOCAL_MODE, '1')

  const rereadResponse = await fetch(`${origin}/api/system/network-policy`, { headers })
  const reread = (await rereadResponse.json()).policy
  assert.equal(reread.mode, 'pure-local')
  assert.equal(reread.pureLocal, true)
  assert.equal(reread.source, 'user_config')

  const disableResponse = await fetch(`${origin}/api/system/network-policy`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ pureLocal: false }),
  })
  assert.equal(disableResponse.status, 200)
  assert.equal((await disableResponse.json()).policy.pureLocal, false)
  assert.equal(process.env.GUGO_PURE_LOCAL_MODE, '0')

  const outsider = issueTestSession({ email: 'network-policy-outsider@example.test' })
  const forbidden = await fetch(`${origin}/api/system/network-policy`, {
    headers: { Authorization: `Bearer ${outsider.token}` },
  })
  assert.equal(forbidden.status, 403)
  assert.equal((await forbidden.json()).error.code, 'LOCAL_OWNER_ONLY')
})

test('network policy API requires authentication and validates boolean updates', async () => {
  const unauthorized = await fetch(`${origin}/api/system/network-policy`)
  assert.equal(unauthorized.status, 401)
  assert.equal((await unauthorized.json()).error.code, 'UNAUTHORIZED')

  const owner = issueTestSession({ email: 'network-policy-validation@example.test' })
  localOwnerId = owner.userId
  const invalid = await fetch(`${origin}/api/system/network-policy`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${owner.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pureLocal: 'yes' }),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'INVALID_OUTBOUND_NETWORK_POLICY')
})
