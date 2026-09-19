import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { executeDesktopFileAction } from '../desktop/fileActions.js'
import { signDesktopFileMessage, verifyDesktopFileMessage } from '../server/utils/desktopFileProtocol.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-desktop-target-'))
const allowed = path.join(root, 'allowed')
const artifacts = path.join(root, 'artifacts')
const secret = 'c'.repeat(64)
const envPatch = {
  APP_DATA_DIR: path.join(root, 'data'), APP_DB_PATH: path.join(root, 'data', 'test.db'),
  ARTIFACT_DIR: artifacts, WORKSPACE_ROOT: path.join(root, 'unrelated-workspace'), WORKSPACE_FS_ENABLED: '1',
  WORKSPACE_SHARED_TRUSTED: '0', GUGO_DESKTOP_BRIDGE_SECRET: secret,
}
const oldEnv = Object.fromEntries(Object.keys(envPatch).map((key) => [key, process.env[key]]))
Object.assign(process.env, envPatch)
fs.mkdirSync(allowed)
fs.mkdirSync(artifacts)
const { closeDb } = await import('../server/db.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { grantLocalPath, revokeLocalPath } = await import('../server/services/localFileAccessService.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { upsertMessage, upsertSession } = await import('../server/services/sessionStore.js')
const { appendTurnArtifact } = await import('../server/services/turnArtifactStore.js')
const { appendJobArtifact, createJob } = await import('../server/services/jobStore.js')
const { handleLocalFileAccessRequest } = await import('../server/routes/localFileAccessRoutes.js')
const alice = issueTestSession()
const bob = issueTestSession()
setApprovalMode({ userId: alice.userId, mode: 'normal' })
setApprovalMode({ userId: bob.userId, mode: 'normal' })
const server = createServer((req, res) => void handleLocalFileAccessRequest(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function request(reference, action = 'open') {
  return signDesktopFileMessage({ nonce: randomBytes(16).toString('hex'), issuedAt: Date.now(), reference, action }, secret)
}

async function resolveTarget(body, token = alice.token) {
  return fetch(`${origin}/api/local-files/desktop-target`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

function receiptFixture(filename, transformPath = (value) => value) {
  const id = `target-${filename}`
  const fullPath = transformPath(path.join(allowed, filename))
  fs.writeFileSync(fullPath, 'private fixture content, must not appear in metadata')
  upsertSession({ id, userId: alice.userId, title: filename })
  upsertMessage({
    id: `${id}:assistant`, userId: alice.userId, sessionId: id, role: 'assistant', content: 'fixture',
    modelContext: { version: 1, turnId: id,
      verifiedLocalFiles: [{ id, path: fullPath, filename }],
      retainedLocalFiles: [{ id: `retained-${id}`, path: fullPath, filename, retainedAt: Date.now() }],
    },
  })
  return { fullPath, reference: { kind: 'verified', fileId: id, turnId: id, sessionId: id } }
}

test('desktop metadata requires both account identity and a fresh signed main-process request', async () => {
  const { reference } = receiptFixture('signed.txt')
  assert.equal((await resolveTarget(request(reference), '')).status, 401)
  for (const body of [
    { reference, action: 'open' },
    { ...request(reference), signature: '0'.repeat(64) },
    signDesktopFileMessage({ reference, action: 'open', nonce: 'd'.repeat(32), issuedAt: Date.now() - 30_000 }, secret),
  ]) {
    const response = await resolveTarget(body)
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'DESKTOP_FILE_SERVICE_UNTRUSTED')
  }
})

test('receipt owner and current read grants are checked on every desktop resolution', async () => {
  const { reference, fullPath } = receiptFixture('grant.txt')
  const grant = grantLocalPath({ userId: alice.userId, rootPath: allowed, accessMode: 'read_only' })
  const body = request(reference)
  const response = await resolveTarget(body)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const data = await response.json()
  const verified = verifyDesktopFileMessage(data, secret, { nonce: body.nonce })
  assert.equal(verified.target.fullPath, fs.realpathSync(fullPath))
  assert.deepEqual(Object.keys(verified.target).sort(), ['filename', 'fingerprint', 'fullPath'])
  assert.equal(JSON.stringify(data).includes('private fixture content'), false)
  assert.equal(JSON.stringify(data).includes(secret), false)
  assert.equal((await resolveTarget(request(reference), bob.token)).status, 404)
  const retained = { ...reference, kind: 'retained', fileId: `retained-${reference.fileId}` }
  assert.equal((await resolveTarget(request(retained))).status, 200)
  revokeLocalPath({ userId: alice.userId, id: grant.id })
  const denied = await resolveTarget(request(reference))
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).error.code, 'PATH_NOT_AUTHORIZED')
})

test('the real signed service and desktop verifier agree on path spelling and retain owner and revocation checks', async () => {
  const { reference, fullPath } = receiptFixture('bridge-casing.txt', (value) => process.platform === 'win32' ? value.toLowerCase() : value)
  const grant = grantLocalPath({ userId: alice.userId, rootPath: allowed, accessMode: 'read_only' })
  const opened = []
  const options = { applicationOrigin: origin, secret, shellImpl: { openPath: async (value) => { opened.push(value); return '' } } }
  const payload = { action: 'open', reference, authToken: alice.token }
  try {
    assert.equal((await executeDesktopFileAction(payload, options)).ok, true)
    assert.deepEqual(opened, [fs.realpathSync(fullPath)])
    await assert.rejects(executeDesktopFileAction({ ...payload, authToken: bob.token }, options), { code: 'VERIFIED_FILE_NOT_FOUND' })
    revokeLocalPath({ userId: alice.userId, id: grant.id })
    await assert.rejects(executeDesktopFileAction(payload, options), { code: 'PATH_NOT_AUTHORIZED' })
    assert.equal(opened.length, 1)
  } finally {
    revokeLocalPath({ userId: alice.userId, id: grant.id })
  }
})

test('desktop confirmation cannot reuse service permission revoked while the prompt was open', async () => {
  const { reference } = receiptFixture('bridge-confirm.html')
  const grant = grantLocalPath({ userId: alice.userId, rootPath: allowed, accessMode: 'read_only' })
  const opened = []
  const options = {
    applicationOrigin: origin, secret,
    shellImpl: { openPath: async (value) => { opened.push(value); return '' } },
    confirmOpen: async () => { revokeLocalPath({ userId: alice.userId, id: grant.id }); return true },
  }
  try {
    await assert.rejects(executeDesktopFileAction({ action: 'open', reference, authToken: alice.token }, options), { code: 'PATH_NOT_AUTHORIZED' })
    assert.deepEqual(opened, [])
  } finally {
    revokeLocalPath({ userId: alice.userId, id: grant.id })
  }
})

test('deleted files, forged paths and unsafe open types do not return native targets', async () => {
  const { reference, fullPath } = receiptFixture('deleted.txt')
  const grant = grantLocalPath({ userId: alice.userId, rootPath: allowed, accessMode: 'read_only' })
  fs.unlinkSync(fullPath)
  assert.equal((await resolveTarget(request(reference))).status, 404)
  const invalid = await resolveTarget(request({ kind: 'local', path: path.join(root, 'private.txt') }))
  assert.equal(invalid.status, 400)
  const unsafe = receiptFixture('script.cmd')
  const unsafeResponse = await resolveTarget(request(unsafe.reference))
  assert.equal(unsafeResponse.status, 403)
  assert.equal((await unsafeResponse.json()).error.code, 'DESKTOP_FILE_OPEN_UNSAFE')
  assert.equal((await resolveTarget(request(unsafe.reference, 'reveal'))).status, 200)
  revokeLocalPath({ userId: alice.userId, id: grant.id })
})

function managedArtifact(filename, owner, index) {
  const id = `managed-${index}`
  upsertSession({ id, userId: owner.userId, title: filename })
  appendTurnArtifact({ id, userId: owner.userId, sessionId: id, turnId: id, type: 'pdf', title: filename, filename, url: `/api/artifacts/${filename}` })
}

test('managed artifacts reuse persisted ownership, reject cross-owner collisions and path escapes', async () => {
  const filename = 'managed.pdf'
  fs.writeFileSync(path.join(artifacts, filename), '%PDF-fixture')
  managedArtifact(filename, alice, 'alice')
  const reference = { kind: 'artifact', filename }
  const allowedResponse = await resolveTarget(request(reference))
  assert.equal(allowedResponse.status, 200)
  assert.equal((await allowedResponse.json()).target.fullPath, fs.realpathSync(path.join(artifacts, filename)))
  assert.equal((await resolveTarget(request(reference), bob.token)).status, 404)
  createJob({ id: 'conflicting-job', userId: bob.userId, title: 'conflict', prompt: 'fixture', status: 'completed' })
  appendJobArtifact({ id: 'conflicting-job-artifact', jobId: 'conflicting-job', userId: bob.userId, type: 'pdf', title: filename, filename, url: `/api/artifacts/${filename}` })
  assert.equal((await resolveTarget(request(reference))).status, 404)
  assert.equal((await resolveTarget(request({ kind: 'artifact', filename: '../private.txt' }))).status, 400)
  fs.writeFileSync(path.join(artifacts, 'unregistered.pdf'), '%PDF-fixture')
  assert.equal((await resolveTarget(request({ kind: 'artifact', filename: 'unregistered.pdf' }))).status, 404)
})

test('desktop metadata rejects a managed junction that resolves outside the artifact root', async () => {
  const link = path.join(artifacts, 'escape.pdf')
  fs.symlinkSync(allowed, link, process.platform === 'win32' ? 'junction' : 'dir')
  managedArtifact('escape.pdf', alice, 'escape')
  const response = await resolveTarget(request({ kind: 'artifact', filename: 'escape.pdf' }, 'reveal'))
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'DESKTOP_FILE_PATH_INVALID')
})

test('network peers cannot resolve desktop file metadata even with a valid account token', async () => {
  let status
  let body
  const response = {
    setHeader() {},
    writeHead(value) { status = value },
    end(value) { body = JSON.parse(value) },
  }
  await handleLocalFileAccessRequest({
    method: 'POST', url: '/api/local-files/desktop-target',
    headers: { authorization: `Bearer ${alice.token}` }, socket: { remoteAddress: '192.0.2.10' },
  }, response)
  assert.equal(status, 403)
  assert.equal(body.error.code, 'LOCAL_ONLY')
})

test('unavailable bridge is 503 and unknown I/O failures are redacted 500 rather than permission denials', async () => {
  const { reference, fullPath } = receiptFixture('io-failure.txt')
  const grant = grantLocalPath({ userId: alice.userId, rootPath: allowed, accessMode: 'read_only' })
  const savedStat = fs.statSync
  try {
    delete process.env.GUGO_DESKTOP_BRIDGE_SECRET
    const unavailable = await resolveTarget(request(reference))
    assert.equal(unavailable.status, 503)
    assert.equal((await unavailable.json()).error.code, 'DESKTOP_FILE_BRIDGE_UNAVAILABLE')
    process.env.GUGO_DESKTOP_BRIDGE_SECRET = secret
    fs.statSync = (candidate, options) => {
      if (path.resolve(candidate) === path.resolve(fullPath) && options?.bigint === true) {
        throw Object.assign(new Error(`synthetic private detail: ${fullPath} ${secret}`), { code: 'EIO' })
      }
      return savedStat(candidate, options)
    }
    const failed = await resolveTarget(request(reference))
    assert.equal(failed.status, 500)
    const body = await failed.json()
    assert.equal(body.error.code, 'DESKTOP_FILE_RESOLVE_FAILED')
    assert.equal(body.error.message, 'DESKTOP_FILE_RESOLVE_FAILED')
    assert.equal(JSON.stringify(body).includes(fullPath), false)
    assert.equal(JSON.stringify(body).includes(secret), false)
  } finally {
    fs.statSync = savedStat
    process.env.GUGO_DESKTOP_BRIDGE_SECRET = secret
    revokeLocalPath({ userId: alice.userId, id: grant.id })
  }
})
