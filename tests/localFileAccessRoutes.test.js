import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-local-file-routes-'))
const allowedDir = path.join(tempDir, 'allowed')
fs.mkdirSync(allowedDir)
fs.writeFileSync(path.join(allowedDir, 'route.txt'), 'route access', 'utf8')
fs.writeFileSync(path.join(allowedDir, 'preview.html'), '<!doctype html><title>verified preview</title><h1>ready</h1>', 'utf8')
fs.writeFileSync(path.join(allowedDir, 'preview.pdf'), Buffer.from('%PDF-1.7\nverified preview', 'ascii'))
process.env.APP_DATA_DIR = tempDir
const previousFsEnabled = process.env.WORKSPACE_FS_ENABLED
process.env.WORKSPACE_FS_ENABLED = '1'
const previousGitEnabled = process.env.WORKSPACE_GIT_ENABLED
process.env.WORKSPACE_GIT_ENABLED = '1'

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { getSessionSnapshot, upsertMessage, upsertSession } = await import('../server/services/sessionStore.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const server = createAppServer({ getEnv: () => ({}) })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

test.after(async () => {
  await new Promise((resolve) => server.close(resolve))
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
  if (previousGitEnabled === undefined) delete process.env.WORKSPACE_GIT_ENABLED
  else process.env.WORKSPACE_GIT_ENABLED = previousGitEnabled
  if (previousFsEnabled === undefined) delete process.env.WORKSPACE_FS_ENABLED
  else process.env.WORKSPACE_FS_ENABLED = previousFsEnabled
})

function headers(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

test('local file access routes require authentication', async () => {
  const response = await fetch(`${origin}/api/local-files`)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED')

  const { token } = issueTestSession({ email: 'local-route-query-auth@example.com' })
  const queryTokenResponse = await fetch(`${origin}/api/local-files?token=${encodeURIComponent(token)}`)
  assert.equal(queryTokenResponse.status, 401)
})

test('authorized path can be used by file tools and remains user-scoped', async () => {
  const alice = issueTestSession({ email: 'local-route-alice@example.com' })
  const bob = issueTestSession({ email: 'local-route-bob@example.com' })
  setApprovalMode({ userId: alice.userId, mode: 'normal' })
  setApprovalMode({ userId: bob.userId, mode: 'normal' })
  const grantResponse = await fetch(`${origin}/api/local-files/grants`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ path: allowedDir, accessMode: 'read_write' }),
  })
  assert.equal(grantResponse.status, 200)
  const grantBody = await grantResponse.json()
  assert.equal(grantBody.grants.length, 1)

  const readResponse = await fetch(`${origin}/api/tools/fs/read`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ path: path.join(allowedDir, 'route.txt') }),
  })
  assert.equal(readResponse.status, 200)
  assert.equal((await readResponse.json()).content, 'route access')

  const bobRead = await fetch(`${origin}/api/tools/fs/read`, {
    method: 'POST',
    headers: headers(bob.token),
    body: JSON.stringify({ path: path.join(allowedDir, 'route.txt') }),
  })
  assert.equal(bobRead.status, 403)
  const bobReadBody = await bobRead.json()
  assert.equal(bobReadBody.code, 'PATH_NOT_AUTHORIZED')
  assert.equal(bobReadBody.requiredAccessMode, 'read_only')
  assert.equal(bobReadBody.path, fs.realpathSync(path.join(allowedDir, 'route.txt')))
  assert.equal(bobReadBody.suggestGrantPath, fs.realpathSync(allowedDir))

  const bobPatch = await fetch(`${origin}/api/tools/code/apply-patch`, {
    method: 'POST',
    headers: headers(bob.token),
    body: JSON.stringify({
      patch: `*** Begin Patch\n*** Update File: ${path.join(allowedDir, 'route.txt')}\n@@\n-route access\n+patched route\n*** End Patch`,
      dry_run: true,
    }),
  })
  assert.equal(bobPatch.status, 403)
  const bobPatchBody = await bobPatch.json()
  assert.equal(bobPatchBody.code, 'PATH_NOT_AUTHORIZED')
  assert.equal(bobPatchBody.requiredAccessMode, 'read_write')
  assert.equal(bobPatchBody.path, fs.realpathSync(path.join(allowedDir, 'route.txt')))
  assert.equal(bobPatchBody.suggestGrantPath, fs.realpathSync(allowedDir))

  const bobGitStatus = await fetch(`${origin}/api/tools/git/status`, {
    method: 'POST',
    headers: headers(bob.token),
    body: JSON.stringify({ cwd: allowedDir }),
  })
  assert.equal(bobGitStatus.status, 403)
  const bobGitBody = await bobGitStatus.json()
  assert.equal(bobGitBody.code, 'PATH_NOT_AUTHORIZED')
  assert.equal(bobGitBody.requiredAccessMode, 'read_only')
  assert.equal(bobGitBody.path, fs.realpathSync(allowedDir))
  assert.equal(bobGitBody.suggestGrantPath, fs.realpathSync(allowedDir))

  const removed = await fetch(`${origin}/api/local-files/grants/${grantBody.grants[0].id}`, {
    method: 'DELETE',
    headers: headers(alice.token),
  })
  assert.equal(removed.status, 200)
  assert.deepEqual((await removed.json()).grants, [])
})

test('all-files route enforces confirmation and method errors are structured', async () => {
  const { token } = issueTestSession({ email: 'local-route-confirm@example.com' })
  const denied = await fetch(`${origin}/api/local-files/all-access`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(denied.status, 400)
  assert.equal((await denied.json()).error.code, 'CONFIRMATION_REQUIRED')

  const enabled = await fetch(`${origin}/api/local-files/all-access`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ enabled: true, confirmation: 'ALLOW_ALL_LOCAL_FILES' }),
  })
  assert.equal(enabled.status, 200)
  assert.equal((await enabled.json()).allFilesEnabled, true)

  const unsupported = await fetch(`${origin}/api/local-files`, {
    method: 'PUT',
    headers: headers(token),
    body: '{}',
  })
  assert.equal(unsupported.status, 405)
  assert.equal((await unsupported.json()).error.code, 'METHOD_NOT_ALLOWED')
})

test('verified turn receipts stream the real file and remain user-scoped', async () => {
  const alice = issueTestSession({ email: 'local-route-receipt-alice@example.com' })
  const bob = issueTestSession({ email: 'local-route-receipt-bob@example.com' })
  setApprovalMode({ userId: alice.userId, mode: 'normal' })
  setApprovalMode({ userId: bob.userId, mode: 'normal' })
  const grantResponse = await fetch(`${origin}/api/local-files/grants`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ path: allowedDir, accessMode: 'read_only' }),
  })
  assert.equal(grantResponse.status, 200)

  const turnId = 'verified-file-route-turn'
  const sessionId = 'verified-file-route-session'
  const fileId = 'verified-file-receipt'
  const htmlFileId = 'verified-html-receipt'
  const pdfFileId = 'verified-pdf-receipt'
  const filePath = fs.realpathSync(path.join(allowedDir, 'route.txt'))
  const htmlPath = fs.realpathSync(path.join(allowedDir, 'preview.html'))
  const pdfPath = fs.realpathSync(path.join(allowedDir, 'preview.pdf'))
  upsertSession({ id: sessionId, userId: alice.userId, title: 'verified file route' })
  upsertMessage({
    id: `${turnId}:assistant`,
    userId: alice.userId,
    sessionId,
    role: 'assistant',
    content: `已更新 ${filePath}`,
    modelContext: {
      version: 1,
      turnId,
      verifiedLocalFiles: [
        { id: fileId, path: filePath, filename: 'route.txt', size: 12 },
        { id: htmlFileId, path: htmlPath, filename: 'preview.html', size: fs.statSync(htmlPath).size },
        { id: pdfFileId, path: pdfPath, filename: 'preview.pdf', size: fs.statSync(pdfPath).size },
      ],
    },
  })

  const url = `${origin}/api/local-files/verified/${fileId}?turnId=${turnId}`
  const response = await fetch(url, { headers: headers(alice.token) })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/plain/)
  assert.match(response.headers.get('content-disposition'), /^attachment;/)
  assert.equal(await response.text(), 'route access')

  const browserLinkResponse = await fetch(`${url}&token=${encodeURIComponent(alice.token)}`)
  assert.equal(browserLinkResponse.status, 200)
  assert.equal(await browserLinkResponse.text(), 'route access')

  const htmlPreviewUrl = `${origin}/api/local-files/verified/${htmlFileId}?turnId=${turnId}&preview=1&token=${encodeURIComponent(alice.token)}`
  const htmlPreview = await fetch(htmlPreviewUrl)
  assert.equal(htmlPreview.status, 200)
  assert.match(htmlPreview.headers.get('content-type'), /^text\/html/)
  assert.match(htmlPreview.headers.get('content-disposition'), /^inline;/)
  assert.equal(htmlPreview.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.match(htmlPreview.headers.get('content-security-policy') || '', /^sandbox allow-scripts;/)
  assert.doesNotMatch(htmlPreview.headers.get('content-security-policy') || '', /allow-(?:same-origin|forms)/)
  assert.match(await htmlPreview.text(), /verified preview/)

  const htmlHead = await fetch(htmlPreviewUrl, { method: 'HEAD' })
  assert.equal(htmlHead.status, 200)
  assert.equal(htmlHead.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.match(htmlHead.headers.get('content-disposition'), /^inline;/)
  assert.equal(await htmlHead.text(), '')

  const pdfPreviewUrl = `${origin}/api/local-files/verified/${pdfFileId}?turnId=${turnId}&preview=1&token=${encodeURIComponent(alice.token)}`
  const pdfRange = await fetch(pdfPreviewUrl, { headers: { Range: 'bytes=0-3' } })
  assert.equal(pdfRange.status, 206)
  assert.equal(pdfRange.headers.get('accept-ranges'), 'bytes')
  assert.equal(pdfRange.headers.get('content-range'), `bytes 0-3/${fs.statSync(pdfPath).size}`)
  assert.equal(pdfRange.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.equal(Buffer.from(await pdfRange.arrayBuffer()).toString('ascii'), '%PDF')

  const invalidRange = await fetch(pdfPreviewUrl, { headers: { Range: 'bytes=999-1000' } })
  assert.equal(invalidRange.status, 416)
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${fs.statSync(pdfPath).size}`)

  const noTokenResponse = await fetch(url)
  assert.equal(noTokenResponse.status, 401)
  assert.equal((await noTokenResponse.json()).error.code, 'UNAUTHORIZED')

  const missing = await fetch(`${origin}/api/local-files/verified/missing?turnId=${turnId}`, {
    headers: headers(alice.token),
  })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'VERIFIED_FILE_NOT_FOUND')

  const crossUser = await fetch(url, { headers: headers(bob.token) })
  assert.equal(crossUser.status, 404)
  assert.equal((await crossUser.json()).error.code, 'VERIFIED_FILE_NOT_FOUND')

  const crossUserBrowserLink = await fetch(`${url}&token=${encodeURIComponent(bob.token)}`)
  assert.equal(crossUserBrowserLink.status, 404)
  assert.equal((await crossUserBrowserLink.json()).error.code, 'VERIFIED_FILE_NOT_FOUND')
})

test('legacy bounded read evidence upgrades to a live current-file link without rewriting history', async () => {
  const alice = issueTestSession({ email: 'local-route-legacy-live@example.com' })
  setApprovalMode({ userId: alice.userId, mode: 'normal' })
  const grantResponse = await fetch(`${origin}/api/local-files/grants`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ path: allowedDir, accessMode: 'read_only' }),
  })
  assert.equal(grantResponse.status, 200)

  const turnId = 'legacy-live-file-turn'
  const sessionId = 'legacy-live-file-session'
  const filePath = path.join(allowedDir, 'legacy-live.html')
  const original = '<!doctype html><title>Original snapshot</title>'
  const current = '<!doctype html><title>Current original file</title>'
  fs.writeFileSync(filePath, original, 'utf8')
  const totalLines = 10
  upsertSession({ id: sessionId, userId: alice.userId, title: 'legacy live file' })
  upsertMessage({
    id: `${turnId}:assistant`,
    userId: alice.userId,
    sessionId,
    role: 'assistant',
    content: '已交付：`legacy-live.html`。',
    modelContext: {
      version: 1,
      turnId,
      toolTrace: [{
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'legacy-write',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: filePath, content: original }) },
        }],
      }, {
        role: 'tool',
        tool_call_id: 'legacy-write',
        name: 'write_file',
        content: JSON.stringify({ ok: true, path: filePath }),
      }, {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'legacy-read',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: filePath, offset: 6, limit: 1 }) },
        }],
      }, {
        role: 'tool',
        tool_call_id: 'legacy-read',
        name: 'read_file',
        content: JSON.stringify({
          ok: true,
          path: filePath,
          content: original,
          offset: 6,
          returnedLines: 1,
          totalLines,
        }),
      }],
    },
  })

  fs.writeFileSync(filePath, current, 'utf8')
  const snapshot = getSessionSnapshot({ userId: alice.userId, sessionId })
  const [receipt] = snapshot.messages[0].modelContext.verifiedLocalFiles
  assert.equal(receipt.path, fs.realpathSync(filePath))
  assert.equal(receipt.filename, 'legacy-live.html')

  const response = await fetch(
    `${origin}/api/local-files/verified/${encodeURIComponent(receipt.id)}?turnId=${turnId}&preview=1`,
    { headers: headers(alice.token) },
  )
  assert.equal(response.status, 200)
  assert.equal(await response.text(), current)

  const stored = getSessionSnapshot({ userId: alice.userId, sessionId }).messages[0]
  assert.equal(Object.hasOwn(stored.modelContext, 'verifiedLocalFiles'), true)
})
