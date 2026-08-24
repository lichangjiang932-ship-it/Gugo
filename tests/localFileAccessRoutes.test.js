import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-local-file-routes-'))
const allowedDir = path.join(tempDir, 'allowed')
fs.mkdirSync(allowedDir)
fs.writeFileSync(path.join(allowedDir, 'route.txt'), 'route access', 'utf8')
const previewAssetsDir = path.join(allowedDir, 'assets')
fs.mkdirSync(previewAssetsDir)
const burstPreviewImages = Array.from({ length: 43 }, (_, index) => `burst-${String(index + 1).padStart(2, '0')}.jpg`)
for (const filename of burstPreviewImages) {
  fs.writeFileSync(path.join(allowedDir, filename), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
}
fs.writeFileSync(path.join(allowedDir, 'preview.html'), [
  '<!doctype html><title>verified preview</title>',
  '<link rel="stylesheet" href="./assets/site.css">',
  '<script type="module" src="./assets/app.mjs"></script>',
  '<script>const gallery=[{src:"./dynamic-gallery.png",name:"missing-caption-only.png"}]</script>',
  `<script>const burstGallery=${JSON.stringify(burstPreviewImages.map((src) => ({ src })))};</script>`,
  '<h1>ready</h1><img src="./background.jpg"><iframe src="./child.html"></iframe>',
].join(''), 'utf8')
fs.writeFileSync(path.join(allowedDir, 'child.html'), '<!doctype html><title>nested child</title><img src="./background.jpg">', 'utf8')
fs.writeFileSync(path.join(previewAssetsDir, 'site.css'), '@font-face{font-family:Preview;src:url(./preview.woff2)}body{background:url(../background.jpg)}', 'utf8')
fs.writeFileSync(path.join(previewAssetsDir, 'app.mjs'), 'document.documentElement.dataset.previewReady="yes"', 'utf8')
fs.writeFileSync(path.join(previewAssetsDir, 'preview.woff2'), Buffer.from('wOF2preview-font', 'ascii'))
fs.writeFileSync(path.join(allowedDir, 'background.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
fs.writeFileSync(path.join(allowedDir, 'dynamic-gallery.png'), Buffer.from('dynamic-image-bytes', 'utf8'))
const retainedAssetsDir = path.join(allowedDir, 'retained-assets')
fs.mkdirSync(retainedAssetsDir)
fs.writeFileSync(path.join(retainedAssetsDir, 'available.css'), [
  'body{background-image:url(./damaged-image.png)}',
  '.missing{background-image:url(./missing-from-css.png)}',
].join(''), 'utf8')
fs.writeFileSync(path.join(retainedAssetsDir, 'damaged-image.png'), Buffer.from('not-a-decodable-png', 'utf8'))
fs.writeFileSync(path.join(retainedAssetsDir, 'overflow-present.png'), Buffer.from('must-stay-outside-the-bounded-graph', 'utf8'))
fs.writeFileSync(path.join(allowedDir, 'retained-incomplete.html'), [
  '<link rel="stylesheet" href="./retained-assets/available.css">',
  '<div>retained incomplete preview',
  '<img src="./retained-assets/missing-image.png">',
  '<img src="./outside-link/outside-secret.txt">',
  '<img src="https://remote.invalid/tracker.png">',
].join(''), 'utf8')
fs.writeFileSync(path.join(allowedDir, 'retained-reference-limit.html'), [
  '<div>bounded retained preview',
  ...Array.from({ length: 2_005 }, (_, index) => `<img src="https://invalid-${index}.example/image.png">`),
  '<img src="./retained-assets/overflow-present.png">',
].join(''), 'utf8')
fs.writeFileSync(path.join(allowedDir, 'same-directory-secret.txt'), 'must remain private', 'utf8')
fs.writeFileSync(path.join(tempDir, 'outside-secret.txt'), 'must not be exposed', 'utf8')
let outsideLinkCreated = false
try {
  fs.symlinkSync(tempDir, path.join(allowedDir, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir')
  outsideLinkCreated = true
} catch {
  // Some Windows hosts disable symlink/junction creation. The realpath guard
  // remains covered wherever the platform permits creating the fixture.
}
fs.writeFileSync(path.join(allowedDir, 'preview.pdf'), Buffer.from('%PDF-1.7\nverified preview', 'ascii'))
process.env.APP_DATA_DIR = tempDir
const previousFsEnabled = process.env.WORKSPACE_FS_ENABLED
process.env.WORKSPACE_FS_ENABLED = '1'
const previousGitEnabled = process.env.WORKSPACE_GIT_ENABLED
process.env.WORKSPACE_GIT_ENABLED = '1'

const { createAppServer } = await import('../server/appServer.js')
const { handleLocalFileAccessRequest } = await import('../server/routes/localFileAccessRoutes.js')
const { closeDb, getDb } = await import('../server/db.js')
const { setApprovalMode } = await import('../server/services/approvalSettingsStore.js')
const { getSessionSnapshot, upsertMessage, upsertSession } = await import('../server/services/sessionStore.js')
const { getLocalHtmlPreviewResource } = await import('../server/services/localHtmlPreviewService.js')
const { localFileMimeType } = await import('../server/services/verifiedLocalFileService.js')
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

async function withNativePickerRoute(nativeDirectoryPicker, callback) {
  const routeServer = createServer((req, res) => {
    void handleLocalFileAccessRequest(req, res, {
      env: { SystemRoot: 'C:\\Windows' },
      nativeDirectoryPicker,
    })
  })
  await new Promise((resolve) => routeServer.listen(0, '127.0.0.1', resolve))
  try {
    await callback(`http://127.0.0.1:${routeServer.address().port}`)
  } finally {
    await new Promise((resolve) => routeServer.close(resolve))
  }
}

async function withEnvironment(overrides, callback) {
  const previous = new Map()
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key])
    if (value == null) delete process.env[key]
    else process.env[key] = String(value)
  }
  try {
    return await callback()
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('local file access routes require authentication', async () => {
  const response = await fetch(`${origin}/api/local-files`)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED')

  const { token } = issueTestSession({ email: 'local-route-query-auth@example.com' })
  const queryTokenResponse = await fetch(`${origin}/api/local-files?token=${encodeURIComponent(token)}`)
  assert.equal(queryTokenResponse.status, 401)
})

test('native directory picker route requires auth and preserves selected, canceled, and unsupported states', async () => {
  const calls = []
  const alice = issueTestSession({ email: 'native-directory-picker-route@example.com' })
  await withNativePickerRoute(async (input, options) => {
    calls.push({ input, options })
    if (input.defaultPath.endsWith('selected')) {
      return { supported: true, canceled: false, path: 'C:\\Workspace\\selected' }
    }
    if (input.defaultPath.endsWith('cancel')) {
      return { supported: true, canceled: true, path: '' }
    }
    return { supported: false, canceled: false, path: '' }
  }, async (pickerOrigin) => {
    const unauthorized = await fetch(`${pickerOrigin}/api/local-files/select-directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultPath: 'C:\\Workspace\\selected' }),
    })
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).error.code, 'UNAUTHORIZED')
    assert.equal(calls.length, 0)

    for (const expected of [
      { defaultPath: 'C:\\Workspace\\selected', supported: true, canceled: false, path: 'C:\\Workspace\\selected' },
      { defaultPath: 'C:\\Workspace\\cancel', supported: true, canceled: true, path: '' },
      { defaultPath: 'C:\\Workspace\\unsupported', supported: false, canceled: false, path: '' },
    ]) {
      const response = await fetch(`${pickerOrigin}/api/local-files/select-directory`, {
        method: 'POST',
        headers: headers(alice.token),
        body: JSON.stringify({ defaultPath: expected.defaultPath }),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), {
        ok: true,
        supported: expected.supported,
        canceled: expected.canceled,
        path: expected.path,
      })
    }
  })

  assert.deepEqual(calls.map(({ input }) => input), [
    { defaultPath: 'C:\\Workspace\\selected' },
    { defaultPath: 'C:\\Workspace\\cancel' },
    { defaultPath: 'C:\\Workspace\\unsupported' },
  ])
  assert.equal(calls.every(({ options }) => options.env.SystemRoot === 'C:\\Windows'), true)
})

test('managed project route creates only a canonical, authorized default workspace path', async () => {
  const alice = issueTestSession({ email: 'local-route-managed-project@example.com' })
  setApprovalMode({ userId: alice.userId, mode: 'normal' })
  const response = await fetch(`${origin}/api/local-files/projects`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ name: '..\\..\\CON:* Route project' }),
  })
  assert.equal(response.status, 201)
  const body = await response.json()
  assert.deepEqual(Object.keys(body.project), ['path'])
  assert.equal(path.isAbsolute(body.project.path), true)
  assert.equal(body.project.path, fs.realpathSync(body.project.path))
  assert.equal(fs.statSync(body.project.path).isDirectory(), true)
  const relative = path.relative(fs.realpathSync(tempDir), body.project.path)
  assert.equal(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), false)
  assert.doesNotMatch(path.basename(body.project.path), /[<>:"/\\|?*]/)
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM local_file_grants WHERE user_id = ?').get(alice.userId).count,
    1,
  )
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM workspace_trust WHERE user_id = ?').get(alice.userId).count,
    1,
  )

  const invalid = await fetch(`${origin}/api/local-files/projects`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ name: '   ' }),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'PROJECT_NAME_REQUIRED')
})

test('directory and workspace trust routes preserve session scope without database persistence', async () => {
  const alice = issueTestSession({ email: 'local-route-session-scope@example.com' })
  const bob = issueTestSession({ email: 'local-route-session-scope-other@example.com' })
  setApprovalMode({ userId: alice.userId, mode: 'normal' })
  setApprovalMode({ userId: bob.userId, mode: 'normal' })

  const grantResponse = await fetch(`${origin}/api/local-files/grants`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ path: allowedDir, accessMode: 'read_only', scope: 'session' }),
  })
  assert.equal(grantResponse.status, 200)
  const grantBody = await grantResponse.json()
  assert.equal(grantBody.grant.scope, 'session')
  assert.equal(grantBody.grants[0].scope, 'session')
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM local_file_grants WHERE user_id = ?').get(alice.userId).count,
    0,
  )

  const trustResponse = await fetch(`${origin}/api/local-files/workspace-trust`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({
      path: allowedDir,
      trusted: true,
      scope: 'session',
      confirmation: 'TRUST_WORKSPACE_CONFIG',
    }),
  })
  assert.equal(trustResponse.status, 200)
  const trustBody = await trustResponse.json()
  assert.equal(trustBody.trust.trustScope, 'session')
  assert.equal(trustBody.trustedWorkspaces[0].trustScope, 'session')
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM workspace_trust WHERE user_id = ?').get(alice.userId).count,
    0,
  )

  const bobStatus = await fetch(`${origin}/api/local-files`, { headers: headers(bob.token) })
  assert.equal(bobStatus.status, 200)
  assert.deepEqual((await bobStatus.json()).grants, [])

  const invalidScope = await fetch(`${origin}/api/local-files/grants`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ path: allowedDir, accessMode: 'read_only', scope: 'forever-ish' }),
  })
  assert.equal(invalidScope.status, 400)
  assert.equal((await invalidScope.json()).error.code, 'INVALID_GRANT_SCOPE')

  const untrust = await fetch(`${origin}/api/local-files/workspace-trust`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ path: allowedDir, trusted: false, scope: 'session' }),
  })
  assert.equal(untrust.status, 200)
  assert.equal((await untrust.json()).trust, true)

  const revoke = await fetch(`${origin}/api/local-files/grants/${encodeURIComponent(grantBody.grant.id)}`, {
    method: 'DELETE',
    headers: headers(alice.token),
  })
  assert.equal(revoke.status, 200)
  assert.deepEqual((await revoke.json()).grants, [])
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
  const grant = (await grantResponse.json()).grants[0]

  const turnId = 'verified-file-route-turn'
  const sessionId = 'verified-file-route-session'
  const fileId = 'verified-file-receipt'
  const retainedFileId = 'retained-file-receipt'
  const retainedHtmlFileId = 'retained-html-receipt'
  const retainedIncompleteHtmlFileId = 'retained-incomplete-html-receipt'
  const retainedReferenceLimitFileId = 'retained-reference-limit-receipt'
  const verifiedIncompleteHtmlFileId = 'verified-incomplete-html-receipt'
  const htmlFileId = 'verified-html-receipt'
  const pdfFileId = 'verified-pdf-receipt'
  const filePath = fs.realpathSync(path.join(allowedDir, 'route.txt'))
  const htmlPath = fs.realpathSync(path.join(allowedDir, 'preview.html'))
  const incompleteHtmlPath = fs.realpathSync(path.join(allowedDir, 'retained-incomplete.html'))
  const referenceLimitHtmlPath = fs.realpathSync(path.join(allowedDir, 'retained-reference-limit.html'))
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
        { id: verifiedIncompleteHtmlFileId, path: incompleteHtmlPath, filename: 'retained-incomplete.html', size: fs.statSync(incompleteHtmlPath).size },
        { id: pdfFileId, path: pdfPath, filename: 'preview.pdf', size: fs.statSync(pdfPath).size },
      ],
      retainedLocalFiles: [
        { id: retainedFileId, path: filePath, filename: 'route.txt', size: 12, retainedAt: Date.now() },
        { id: retainedHtmlFileId, path: htmlPath, filename: 'preview.html', size: fs.statSync(htmlPath).size, retainedAt: Date.now() },
        { id: retainedIncompleteHtmlFileId, path: incompleteHtmlPath, filename: 'retained-incomplete.html', size: fs.statSync(incompleteHtmlPath).size, retainedAt: Date.now() },
        { id: retainedReferenceLimitFileId, path: referenceLimitHtmlPath, filename: 'retained-reference-limit.html', size: fs.statSync(referenceLimitHtmlPath).size, retainedAt: Date.now() },
      ],
    },
  })

  const url = `${origin}/api/local-files/verified/${fileId}?turnId=${turnId}`
  const response = await fetch(url, { headers: headers(alice.token) })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/plain/)
  assert.match(response.headers.get('content-disposition'), /^attachment;/)
  assert.equal(await response.text(), 'route access')

  const retainedUrl = `${origin}/api/local-files/retained/${retainedFileId}?turnId=${turnId}`
  const retainedResponse = await fetch(retainedUrl, { headers: headers(alice.token) })
  assert.equal(retainedResponse.status, 200)
  assert.match(retainedResponse.headers.get('content-disposition'), /^attachment;/)
  assert.equal(await retainedResponse.text(), 'route access')

  const retainedBrowserLink = await fetch(`${retainedUrl}&token=${encodeURIComponent(alice.token)}`)
  assert.equal(retainedBrowserLink.status, 200)
  assert.equal(await retainedBrowserLink.text(), 'route access')

  const retainedTextPreview = await fetch(`${retainedUrl}&preview=1&token=${encodeURIComponent(alice.token)}`)
  assert.equal(retainedTextPreview.status, 200)
  assert.match(retainedTextPreview.headers.get('content-disposition'), /^inline;/)
  assert.equal(await retainedTextPreview.text(), 'route access')

  const retainedHtmlQueryTokenPreview = await fetch(
    `${origin}/api/local-files/retained/${retainedHtmlFileId}?turnId=${turnId}&preview=1&token=${encodeURIComponent(alice.token)}`,
  )
  assert.equal(retainedHtmlQueryTokenPreview.status, 400)
  assert.equal(
    (await retainedHtmlQueryTokenPreview.json()).error.code,
    'LOCAL_HTML_QUERY_TOKEN_PREVIEW_FORBIDDEN',
  )

  const browserLinkResponse = await fetch(`${url}&token=${encodeURIComponent(alice.token)}`)
  assert.equal(browserLinkResponse.status, 200)
  assert.equal(await browserLinkResponse.text(), 'route access')

  const htmlDownloadUrl = `${origin}/api/local-files/verified/${htmlFileId}?turnId=${turnId}&token=${encodeURIComponent(alice.token)}`
  const htmlDownload = await fetch(htmlDownloadUrl)
  assert.equal(htmlDownload.status, 200)
  assert.match(htmlDownload.headers.get('content-disposition'), /^attachment;/)
  assert.match(await htmlDownload.text(), /verified preview/)

  const htmlQueryTokenPreview = await fetch(
    `${origin}/api/local-files/verified/${htmlFileId}?turnId=${turnId}&preview=1&token=${encodeURIComponent(alice.token)}`,
  )
  assert.equal(htmlQueryTokenPreview.status, 400)
  assert.equal(
    (await htmlQueryTokenPreview.json()).error.code,
    'LOCAL_HTML_QUERY_TOKEN_PREVIEW_FORBIDDEN',
  )

  const htmlPreviewUrl = `${origin}/api/local-files/verified/${htmlFileId}?turnId=${turnId}&preview=1`
  const htmlPreview = await fetch(htmlPreviewUrl, { headers: headers(alice.token) })
  assert.equal(htmlPreview.status, 200)
  assert.match(htmlPreview.headers.get('content-type'), /^text\/html/)
  assert.match(htmlPreview.headers.get('content-disposition'), /^inline;/)
  assert.equal(htmlPreview.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.match(htmlPreview.headers.get('content-security-policy') || '', /^sandbox allow-scripts;/)
  assert.doesNotMatch(htmlPreview.headers.get('content-security-policy') || '', /allow-(?:same-origin|forms)/)
  assert.match(await htmlPreview.text(), /verified preview/)

  const htmlHead = await fetch(htmlPreviewUrl, { method: 'HEAD', headers: headers(alice.token) })
  assert.equal(htmlHead.status, 200)
  assert.equal(htmlHead.headers.get('x-frame-options'), 'SAMEORIGIN')
  assert.match(htmlHead.headers.get('content-disposition'), /^inline;/)
  assert.equal(await htmlHead.text(), '')

  const previewSessionResponse = await fetch(
    `${origin}/api/local-files/verified/${htmlFileId}/preview-session/?turnId=${turnId}`,
    { method: 'POST', headers: headers(alice.token) },
  )
  assert.equal(previewSessionResponse.status, 200)
  const previewSession = await previewSessionResponse.json()
  assert.match(previewSession.url, /^\/api\/local-files\/previews\/[^/]+\/preview\.html$/)
  assert.doesNotMatch(previewSession.url, new RegExp(alice.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const sessionHtmlUrl = new URL(previewSession.url, origin)
  const sessionHtml = await fetch(sessionHtmlUrl)
  assert.equal(sessionHtml.status, 200)
  assert.match(sessionHtml.headers.get('content-type'), /^text\/html/)
  assert.equal(sessionHtml.headers.get('access-control-allow-origin'), '*')
  assert.equal(sessionHtml.headers.get('cross-origin-resource-policy'), 'cross-origin')
  const sessionCsp = sessionHtml.headers.get('content-security-policy') || ''
  const ticketResourceSource = `${origin}${previewSession.url.slice(0, previewSession.url.lastIndexOf('/') + 1)}`
  assert.match(sessionCsp, /^sandbox;/)
  assert.doesNotMatch(sessionCsp, /allow-(?:scripts|forms|same-origin)/)
  assert.ok(sessionCsp.includes("connect-src 'none'"))
  assert.ok(sessionCsp.includes("script-src 'none'"))
  assert.doesNotMatch(sessionCsp, /(?:^|\s)(?:https?|wss?):(?=\s|;|$)/)
  assert.match(await sessionHtml.text(), /\.\/assets\/site\.css/)

  const retainedPreviewSessionResponse = await fetch(
    `${origin}/api/local-files/retained/${retainedHtmlFileId}/preview-session?turnId=${turnId}`,
    { method: 'POST', headers: headers(alice.token) },
  )
  assert.equal(retainedPreviewSessionResponse.status, 200)
  const retainedPreviewSession = await retainedPreviewSessionResponse.json()
  assert.match(retainedPreviewSession.url, /^\/api\/local-files\/previews\/[^/]+\/preview\.html$/)
  const retainedSessionHtml = await fetch(new URL(retainedPreviewSession.url, origin))
  assert.equal(retainedSessionHtml.status, 200)
  assert.match(await retainedSessionHtml.text(), /verified preview/)

  const strictIncompletePreview = await fetch(
    `${origin}/api/local-files/verified/${verifiedIncompleteHtmlFileId}/preview-session?turnId=${turnId}`,
    { method: 'POST', headers: headers(alice.token) },
  )
  assert.equal(strictIncompletePreview.status, 422)
  assert.equal((await strictIncompletePreview.json()).error.code, 'HTML_DELIVERY_DOCUMENT_INCOMPLETE')

  const tolerantPreviewResponse = await fetch(
    `${origin}/api/local-files/retained/${retainedIncompleteHtmlFileId}/preview-session?turnId=${turnId}`,
    { method: 'POST', headers: headers(alice.token) },
  )
  assert.equal(tolerantPreviewResponse.status, 200)
  const tolerantPreview = await tolerantPreviewResponse.json()
  const tolerantHtmlUrl = new URL(tolerantPreview.url, origin)
  const tolerantHtml = await fetch(tolerantHtmlUrl)
  assert.equal(tolerantHtml.status, 200)
  assert.match(await tolerantHtml.text(), /retained incomplete preview/)
  const tolerantCsp = tolerantHtml.headers.get('content-security-policy') || ''
  assert.match(tolerantCsp, /^sandbox;/)
  assert.doesNotMatch(tolerantCsp, /allow-(?:scripts|forms|same-origin)/)
  assert.ok(tolerantCsp.includes("connect-src 'none'"))
  assert.ok(tolerantCsp.includes("script-src 'none'"))
  assert.doesNotMatch(tolerantCsp, /(?:^|\s)(?:https?|wss?):(?=\s|;|$)/)

  const tolerantCss = await fetch(new URL('./retained-assets/available.css', tolerantHtmlUrl))
  assert.equal(tolerantCss.status, 200)
  assert.match(await tolerantCss.text(), /missing-from-css\.png/)
  const damagedImage = await fetch(new URL('./retained-assets/damaged-image.png', tolerantHtmlUrl))
  assert.equal(damagedImage.status, 200)
  assert.equal(Buffer.from(await damagedImage.arrayBuffer()).toString('utf8'), 'not-a-decodable-png')

  for (const resourceName of [
    './retained-assets/missing-image.png',
    './retained-assets/missing-from-css.png',
    './same-directory-secret.txt',
  ]) {
    const unavailable = await fetch(new URL(resourceName, tolerantHtmlUrl))
    assert.equal(unavailable.status, 403, resourceName)
    assert.equal((await unavailable.json()).error.code, 'LOCAL_HTML_PREVIEW_RESOURCE_NOT_DECLARED')
  }
  if (outsideLinkCreated) {
    const retainedSymlinkEscape = await fetch(new URL('./outside-link/outside-secret.txt', tolerantHtmlUrl))
    assert.equal(retainedSymlinkEscape.status, 403)
    assert.doesNotMatch(await retainedSymlinkEscape.text(), /must not be exposed/)
  }

  const boundedPreviewResponse = await fetch(
    `${origin}/api/local-files/retained/${retainedReferenceLimitFileId}/preview-session?turnId=${turnId}`,
    { method: 'POST', headers: headers(alice.token) },
  )
  assert.equal(boundedPreviewResponse.status, 200)
  const boundedPreview = await boundedPreviewResponse.json()
  const overflowResource = await fetch(new URL(
    './retained-assets/overflow-present.png',
    new URL(boundedPreview.url, origin),
  ))
  assert.equal(overflowResource.status, 403)
  assert.equal((await overflowResource.json()).error.code, 'LOCAL_HTML_PREVIEW_RESOURCE_NOT_DECLARED')

  const crossUserRetainedPreviewSession = await fetch(
    `${origin}/api/local-files/retained/${retainedHtmlFileId}/preview-session?turnId=${turnId}`,
    { method: 'POST', headers: headers(bob.token) },
  )
  assert.equal(crossUserRetainedPreviewSession.status, 404)
  assert.equal((await crossUserRetainedPreviewSession.json()).error.code, 'RETAINED_FILE_NOT_FOUND')

  const childFrame = await fetch(new URL('./child.html', sessionHtmlUrl))
  assert.equal(childFrame.status, 200)
  assert.match(childFrame.headers.get('content-type') || '', /^text\/html/)
  assert.equal(childFrame.headers.get('x-frame-options'), null)
  const childCsp = childFrame.headers.get('content-security-policy') || ''
  assert.match(childCsp, /^sandbox;/)
  assert.doesNotMatch(childCsp, /allow-(?:scripts|forms|same-origin)/)
  assert.doesNotMatch(childCsp, /frame-ancestors/)
  assert.ok(childCsp.includes(`img-src data: blob: ${ticketResourceSource}`))
  assert.match(await childFrame.text(), /nested child/)
  const childHead = await fetch(new URL('./child.html', sessionHtmlUrl), { method: 'HEAD' })
  assert.equal(childHead.status, 200)
  assert.equal(childHead.headers.get('x-frame-options'), null)
  assert.doesNotMatch(childHead.headers.get('content-security-policy') || '', /frame-ancestors/)
  const cachedChild = await fetch(new URL('./child.html', sessionHtmlUrl), {
    headers: { 'If-None-Match': childFrame.headers.get('etag') },
  })
  assert.equal(cachedChild.status, 304)
  assert.equal(cachedChild.headers.get('x-frame-options'), null)
  assert.doesNotMatch(cachedChild.headers.get('content-security-policy') || '', /frame-ancestors/)

  const relativeResources = [
    ['./assets/site.css', /^text\/css/, /background\.jpg/],
    ['./assets/app.mjs', /^text\/javascript/, /previewReady/],
    ['./assets/preview.woff2', /^font\/woff2/, null],
    ['./background.jpg', /^image\/jpeg/, null],
    ['./dynamic-gallery.png', /^image\/png/, null],
  ]
  for (const [relativeUrl, mime, content] of relativeResources) {
    const resource = await fetch(new URL(relativeUrl, sessionHtmlUrl))
    assert.equal(resource.status, 200, relativeUrl)
    assert.match(resource.headers.get('content-type') || '', mime, relativeUrl)
    if (content) assert.match(await resource.text(), content, relativeUrl)
    else assert.ok((await resource.arrayBuffer()).byteLength > 0, relativeUrl)
  }
  const burstResponses = await Promise.all(burstPreviewImages.map((filename) => (
    fetch(new URL(`./${filename}`, sessionHtmlUrl))
  )))
  assert.equal(burstResponses.length, 43)
  for (const response of burstResponses) {
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') || '', /^image\/jpeg/)
  }

  const undeclaredSibling = await fetch(new URL('./same-directory-secret.txt', sessionHtmlUrl))
  assert.equal(undeclaredSibling.status, 403)
  assert.equal((await undeclaredSibling.json()).error.code, 'LOCAL_HTML_PREVIEW_RESOURCE_NOT_DECLARED')

  // An encoded slash must not turn the ticket into an arbitrary directory
  // browser, even when the user has granted the HTML's parent directory.
  const traversalUrl = `${origin}/api/local-files/previews/${previewSession.ticket}/%2e%2e%2foutside-secret.txt`
  const traversal = await fetch(traversalUrl)
  assert.equal(traversal.status, 403)
  assert.equal((await traversal.json()).error.code, 'LOCAL_HTML_PREVIEW_PATH_OUTSIDE_ROOT')

  if (outsideLinkCreated) {
    const symlinkEscape = await fetch(new URL('./outside-link/outside-secret.txt', sessionHtmlUrl))
    assert.equal(symlinkEscape.status, 403)
    assert.doesNotMatch(await symlinkEscape.text(), /must not be exposed/)
  }

  let newestPreviewSession = previewSession
  for (let index = 0; index < 8; index += 1) {
    const nextResponse = await fetch(
      `${origin}/api/local-files/verified/${htmlFileId}/preview-session?turnId=${turnId}`,
      { method: 'POST', headers: headers(alice.token) },
    )
    assert.equal(nextResponse.status, 200)
    newestPreviewSession = await nextResponse.json()
  }
  const evictedOldest = await fetch(sessionHtmlUrl)
  assert.equal(evictedOldest.status, 404)
  assert.equal((await evictedOldest.json()).error.code, 'LOCAL_HTML_PREVIEW_EXPIRED')
  const retainedNewest = await fetch(new URL(newestPreviewSession.url, origin))
  assert.equal(retainedNewest.status, 200)

  const revocableResponse = await fetch(
    `${origin}/api/local-files/verified/${htmlFileId}/preview-session?turnId=${turnId}`,
    { method: 'POST', headers: headers(alice.token) },
  )
  assert.equal(revocableResponse.status, 200)
  const revocableSession = await revocableResponse.json()
  const revokeUrl = `${origin}/api/local-files/previews/${revocableSession.ticket}/`
  const anonymousRevoke = await fetch(revokeUrl, { method: 'DELETE' })
  assert.equal(anonymousRevoke.status, 401)
  const crossUserRevoke = await fetch(revokeUrl, { method: 'DELETE', headers: headers(bob.token) })
  assert.equal(crossUserRevoke.status, 204)
  assert.equal((await fetch(new URL(revocableSession.url, origin))).status, 200)
  const ownerRevoke = await fetch(revokeUrl, { method: 'DELETE', headers: headers(alice.token) })
  assert.equal(ownerRevoke.status, 204)
  const afterOwnerRevoke = await fetch(new URL(revocableSession.url, origin))
  assert.equal(afterOwnerRevoke.status, 404)
  assert.equal((await afterOwnerRevoke.json()).error.code, 'LOCAL_HTML_PREVIEW_EXPIRED')
  const repeatedRevoke = await fetch(revokeUrl, { method: 'DELETE', headers: headers(alice.token) })
  assert.equal(repeatedRevoke.status, 204)

  const crossUserPreviewSession = await fetch(
    `${origin}/api/local-files/verified/${htmlFileId}/preview-session?turnId=${turnId}`,
    { method: 'POST', headers: headers(bob.token) },
  )
  assert.equal(crossUserPreviewSession.status, 404)
  assert.equal((await crossUserPreviewSession.json()).error.code, 'VERIFIED_FILE_NOT_FOUND')

  assert.throws(
    () => getLocalHtmlPreviewResource({
      ticket: previewSession.ticket,
      resourcePath: 'preview.html',
      now: () => Date.now() + (3 * 60 * 60 * 1_000),
    }),
    (error) => error?.code === 'LOCAL_HTML_PREVIEW_EXPIRED',
  )

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

  const missingRetained = await fetch(`${origin}/api/local-files/retained/missing?turnId=${turnId}`, {
    headers: headers(alice.token),
  })
  assert.equal(missingRetained.status, 404)
  assert.equal((await missingRetained.json()).error.code, 'RETAINED_FILE_NOT_FOUND')

  const crossUser = await fetch(url, { headers: headers(bob.token) })
  assert.equal(crossUser.status, 404)
  assert.equal((await crossUser.json()).error.code, 'VERIFIED_FILE_NOT_FOUND')

  const crossUserRetained = await fetch(retainedUrl, { headers: headers(bob.token) })
  assert.equal(crossUserRetained.status, 404)
  assert.equal((await crossUserRetained.json()).error.code, 'RETAINED_FILE_NOT_FOUND')

  const crossUserBrowserLink = await fetch(`${url}&token=${encodeURIComponent(bob.token)}`)
  assert.equal(crossUserBrowserLink.status, 404)
  assert.equal((await crossUserBrowserLink.json()).error.code, 'VERIFIED_FILE_NOT_FOUND')

  const replacementSessionResponse = await fetch(
    `${origin}/api/local-files/verified/${htmlFileId}/preview-session?turnId=${turnId}`,
    { method: 'POST', headers: headers(alice.token) },
  )
  const replacementSession = await replacementSessionResponse.json()
  const revoked = await fetch(`${origin}/api/local-files/grants/${grant.id}`, {
    method: 'DELETE',
    headers: headers(alice.token),
  })
  assert.equal(revoked.status, 200)
  const revokedResource = await fetch(new URL(replacementSession.url, origin))
  assert.equal(revokedResource.status, 403)
  assert.equal((await revokedResource.json()).error.code, 'PATH_NOT_AUTHORIZED')
})

test('local preview MIME types cover common web sidecar assets', () => {
  assert.equal(localFileMimeType('font.otf'), 'font/otf')
  assert.equal(localFileMimeType('site.webmanifest'), 'application/manifest+json; charset=utf-8')
  assert.equal(localFileMimeType('bundle.js.map'), 'application/json; charset=utf-8')
  assert.equal(localFileMimeType('worker.cjs'), 'text/javascript; charset=utf-8')
})

test('local preview MIME types cover browser-native sidebar media and Office variants', () => {
  const expected = new Map([
    ['photo.apng', 'image/apng'],
    ['photo.jfif', 'image/jpeg'],
    ['sound.flac', 'audio/flac'],
    ['sound.m4b', 'audio/mp4'],
    ['sound.oga', 'audio/ogg'],
    ['sound.opus', 'audio/ogg'],
    ['movie.m4v', 'video/mp4'],
    ['movie.ogv', 'video/ogg'],
    ['sheet.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['sheet.xls', 'application/vnd.ms-excel'],
    ['sheet.xlsb', 'application/vnd.ms-excel.sheet.binary.macroEnabled.12'],
    ['sheet.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
    ['slides.pptm', 'application/vnd.ms-powerpoint.presentation.macroEnabled.12'],
  ])
  for (const [filename, mimeType] of expected) {
    assert.equal(localFileMimeType(filename), mimeType, filename)
  }
})

test('local HTML preview CSP uses only configured or explicitly trusted public origins', async () => {
  const alice = issueTestSession({ email: 'local-route-preview-origin@example.com' })
  setApprovalMode({ userId: alice.userId, mode: 'normal' })
  const grantResponse = await fetch(`${origin}/api/local-files/grants`, {
    method: 'POST',
    headers: headers(alice.token),
    body: JSON.stringify({ path: allowedDir, accessMode: 'read_only' }),
  })
  assert.equal(grantResponse.status, 200)
  const grant = (await grantResponse.json()).grants[0]

  const turnId = 'verified-preview-origin-turn'
  const sessionId = 'verified-preview-origin-session'
  const fileId = 'verified-preview-origin-html'
  const htmlPath = fs.realpathSync(path.join(allowedDir, 'preview.html'))
  upsertSession({ id: sessionId, userId: alice.userId, title: 'verified preview origin' })
  upsertMessage({
    id: `${turnId}:assistant`,
    userId: alice.userId,
    sessionId,
    role: 'assistant',
    content: '已完成网页预览来源验证。',
    modelContext: {
      version: 1,
      turnId,
      verifiedLocalFiles: [{
        id: fileId,
        path: htmlPath,
        filename: 'preview.html',
        size: fs.statSync(htmlPath).size,
      }],
    },
  })

  const previewSessionResponse = await fetch(
    `${origin}/api/local-files/verified/${fileId}/preview-session?turnId=${turnId}`,
    { method: 'POST', headers: headers(alice.token) },
  )
  assert.equal(previewSessionResponse.status, 200)
  const previewSession = await previewSessionResponse.json()
  const previewUrl = new URL(previewSession.url, origin)
  const capabilityPath = previewSession.url.slice(0, previewSession.url.lastIndexOf('/') + 1)

  const requestCsp = (environment, requestHeaders) => withEnvironment(environment, async () => {
    const response = await fetch(previewUrl, { headers: requestHeaders })
    assert.equal(response.status, 200)
    return response.headers.get('content-security-policy') || ''
  })

  const directCsp = await requestCsp(
    { APP_PUBLIC_URL: null, TRUST_PROXY: null },
    {
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'forged.example',
    },
  )
  assert.ok(directCsp.includes(`${origin}${capabilityPath}`))
  assert.doesNotMatch(directCsp, /forged\.example/)

  const trustedProxyCsp = await requestCsp(
    { APP_PUBLIC_URL: null, TRUST_PROXY: 'true' },
    {
      Host: 'internal.example:5180',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'public.example',
    },
  )
  assert.ok(trustedProxyCsp.includes(`https://public.example${capabilityPath}`))
  assert.doesNotMatch(trustedProxyCsp, /internal\.example/)

  const configuredCsp = await requestCsp(
    { APP_PUBLIC_URL: 'https://configured.example/base/path', TRUST_PROXY: '1' },
    {
      Host: 'internal.example:5180',
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-Host': 'forwarded.example',
    },
  )
  assert.ok(configuredCsp.includes(`https://configured.example${capabilityPath}`))
  assert.doesNotMatch(configuredCsp, /(?:internal|forwarded)\.example/)

  const remoteImageCsp = await requestCsp(
    {
      APP_PUBLIC_URL: null,
      TRUST_PROXY: null,
      HTML_PREVIEW_REMOTE_IMAGE_ORIGINS: [
        'https://images.example.test',
        'http://insecure.example.test',
        'https://path.example.test/assets',
      ].join(','),
    },
    {},
  )
  const imgDirective = remoteImageCsp.split('; ').find((directive) => directive.startsWith('img-src ')) || ''
  assert.match(imgDirective, /https:\/\/images\.example\.test/)
  assert.doesNotMatch(remoteImageCsp, /insecure|path\.example/)
  for (const directive of ['connect-src', 'script-src', 'style-src', 'frame-src']) {
    const value = remoteImageCsp.split('; ').find((candidate) => candidate.startsWith(`${directive} `)) || ''
    assert.doesNotMatch(value, /images\.example\.test/, directive)
  }

  const revoked = await fetch(`${origin}/api/local-files/grants/${grant.id}`, {
    method: 'DELETE',
    headers: headers(alice.token),
  })
  assert.equal(revoked.status, 200)
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
