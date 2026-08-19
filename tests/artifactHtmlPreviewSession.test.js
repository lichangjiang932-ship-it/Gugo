import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-artifact-html-preview-'))
const artifactDir = path.join(tempDir, 'artifacts')
process.env.APP_DATA_DIR = tempDir
process.env.ARTIFACT_DIR = artifactDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { appendJobArtifact, createJob } = await import('../server/services/jobStore.js')
const {
  clearArtifactHtmlPreviewSessions,
  createArtifactHtmlPreviewSession,
  getArtifactHtmlPreviewDocument,
  isArtifactHtmlPreviewTicketActive,
} = await import('../server/services/artifactHtmlPreviewService.js')
const {
  beginHtmlArtifactAssetInstall,
  finishHtmlArtifactAssetInstall,
  getHtmlArtifactAsset,
  stageHtmlArtifactAssets,
} = await import('../server/services/htmlArtifactAssets.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

fs.mkdirSync(artifactDir, { recursive: true })
let artifactCounter = 0

function registerArtifact({ body, filename, type = 'html', userId }) {
  artifactCounter += 1
  const id = `html-preview-artifact-${artifactCounter}`
  const jobId = `html-preview-job-${artifactCounter}`
  fs.writeFileSync(path.join(artifactDir, filename), body)
  createJob({ id: jobId, userId, title: filename, prompt: filename, status: 'completed' })
  appendJobArtifact({
    id,
    jobId,
    userId,
    type,
    title: filename,
    filename,
    url: `/api/artifacts/${encodeURIComponent(filename)}`,
  })
  return { id, filename }
}

async function installGalleryAssets({ artifactId, filename }) {
  const sourceDirectory = path.join(tempDir, `asset-source-${artifactId}`)
  fs.mkdirSync(sourceDirectory, { recursive: true })
  const portrait = await sharp({
    create: { width: 3, height: 2, channels: 3, background: '#4f46e5' },
  }).png().toBuffer()
  const unused = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#ef4444' },
  }).png().toBuffer()
  const portraitPath = path.join(sourceDirectory, 'portrait.png')
  const unusedPath = path.join(sourceDirectory, 'unused.png')
  fs.writeFileSync(portraitPath, portrait)
  fs.writeFileSync(unusedPath, unused)
  const stage = await stageHtmlArtifactAssets({
    artifactDirectory: artifactDir,
    artifactId,
    parentFilename: filename,
    requiredAssetIds: ['portrait', 'unused'],
    sources: [
      { id: 'portrait', sourcePath: portraitPath },
      { id: 'unused', sourcePath: unusedPath },
    ],
  })
  finishHtmlArtifactAssetInstall(beginHtmlArtifactAssetInstall(stage))
  return {
    bytes: portrait,
    fullPath: getHtmlArtifactAsset({
      artifactDirectory: artifactDir,
      artifactId,
      assetId: 'portrait',
    }).fullPath,
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

test('managed HTML preview tickets are owner-issued, same-origin, read-only, and declaration-scoped', async () => {
  const owner = issueTestSession()
  const outsider = issueTestSession()
  const html = `<!doctype html><html><head><style>
    .hero { background-image: url("gugo-asset://portrait") }
  </style></head><body><main class="hero"><img src="gugo-asset://portrait">Gallery</main></body></html>`
  const artifact = registerArtifact({
    body: html,
    filename: 'managed gallery.html',
    userId: owner.userId,
  })
  const portrait = await installGalleryAssets({ artifactId: artifact.id, filename: artifact.filename })
  const server = createAppServer({ getEnv: () => ({}) })
  const origin = await listen(server)
  const sessionEndpoint = `${origin}/api/artifacts/${encodeURIComponent(artifact.id)}/preview-session`

  try {
    const unauthorized = await fetch(sessionEndpoint, { method: 'POST' })
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).error.code, 'UNAUTHORIZED')

    const hiddenFromOutsider = await fetch(sessionEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${outsider.token}` },
    })
    assert.equal(hiddenFromOutsider.status, 404)
    const filenameHiddenFromOutsider = await fetch(
      `${origin}/api/artifacts/${encodeURIComponent(artifact.filename)}/preview-session`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${outsider.token}` },
      },
    )
    assert.equal(filenameHiddenFromOutsider.status, 404)

    const created = await fetch(sessionEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(created.status, 201)
    assert.equal(created.headers.get('cache-control'), 'no-store')
    const payload = await created.json()
    assert.match(payload.url, /^\/api\/artifacts\/previews\/[A-Za-z0-9_-]{32}\/index\.html$/)

    const preview = await fetch(`${origin}${payload.url}`)
    assert.equal(preview.status, 200)
    assert.equal(preview.headers.get('cache-control'), 'no-store')
    assert.equal(preview.headers.get('x-frame-options'), 'SAMEORIGIN')
    assert.equal(preview.headers.get('referrer-policy'), 'no-referrer')
    const csp = preview.headers.get('content-security-policy') || ''
    assert.match(csp, /^sandbox allow-scripts;/)
    assert.match(csp, /frame-ancestors 'self'/)
    assert.match(csp, /img-src 'self' data: blob:/)
    assert.match(csp, /media-src 'self' data: blob:/)
    assert.match(csp, /connect-src 'none'/)
    assert.match(csp, /form-action 'none'/)
    assert.match(csp, /navigate-to 'none'/)
    assert.doesNotMatch(csp, /allow-(?:same-origin|forms|popups)/)
    const rewritten = await preview.text()
    assert.doesNotMatch(rewritten, /gugo-asset:\/\//)
    assert.equal((rewritten.match(/\.\/assets\/portrait/g) || []).length, 2)

    const guessedUrl = payload.url.replace(/[A-Za-z0-9_-]{32}(?=\/index\.html$)/, 'A'.repeat(32))
    assert.equal((await fetch(`${origin}${guessedUrl}`)).status, 404)

    const head = await fetch(`${origin}${payload.url}`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(rewritten))
    assert.equal(await head.text(), '')

    const assetUrl = `${origin}${payload.url.replace(/index\.html$/, 'assets/portrait')}`
    const asset = await fetch(assetUrl)
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('content-type'), 'image/png')
    assert.equal(asset.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), portrait.bytes)

    const assetHead = await fetch(assetUrl, { method: 'HEAD' })
    assert.equal(assetHead.status, 200)
    assert.equal(Number(assetHead.headers.get('content-length')), portrait.bytes.length)
    assert.equal(await assetHead.text(), '')

    const range = await fetch(assetUrl, { headers: { Range: 'bytes=0-2' } })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), `bytes 0-2/${portrait.bytes.length}`)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), portrait.bytes.subarray(0, 3))

    const unsatisfiable = await fetch(assetUrl, { headers: { Range: `bytes=${portrait.bytes.length}-` } })
    assert.equal(unsatisfiable.status, 416)
    assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${portrait.bytes.length}`)

    const undeclared = await fetch(assetUrl.replace('/portrait', '/unused'))
    assert.equal(undeclared.status, 404)
    const traversal = await fetch(assetUrl.replace('/portrait', '/%2e%2e%2fportrait'))
    assert.equal(traversal.status, 404)

    const writeAttempt = await fetch(`${origin}${payload.url}`, { method: 'POST' })
    assert.equal(writeAttempt.status, 405)
    assert.equal(writeAttempt.headers.get('allow'), 'GET, HEAD')
    const assetWriteAttempt = await fetch(assetUrl, { method: 'PUT' })
    assert.equal(assetWriteAttempt.status, 405)
    assert.equal(assetWriteAttempt.headers.get('allow'), 'GET, HEAD')

    fs.writeFileSync(portrait.fullPath, Buffer.alloc(portrait.bytes.length, 0x61))
    const replaced = await fetch(assetUrl)
    assert.equal(replaced.status, 409)
    assert.equal((await replaced.json()).error.code, 'ARTIFACT_HTML_PREVIEW_RESOURCE_CHANGED')

    const ticketRoot = payload.url.replace(/\/index\.html$/, '')
    const unauthorizedRevoke = await fetch(`${origin}${ticketRoot}`, { method: 'DELETE' })
    assert.equal(unauthorizedRevoke.status, 401)
    const outsiderRevoke = await fetch(`${origin}${ticketRoot}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${outsider.token}` },
    })
    assert.equal(outsiderRevoke.status, 404)
    assert.equal((await fetch(`${origin}${payload.url}`)).status, 200)

    const revoked = await fetch(`${origin}${ticketRoot}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(revoked.status, 204)
    assert.equal((await fetch(`${origin}${payload.url}`)).status, 404)
  } finally {
    await close(server)
  }
})

test('preview session selector supports managed filenames and rejects non-HTML artifacts', async () => {
  const owner = issueTestSession()
  const htmlArtifact = registerArtifact({
    body: '<!doctype html><html><body><main>Filename selector</main></body></html>',
    filename: 'filename-selector.html',
    userId: owner.userId,
  })
  const textArtifact = registerArtifact({
    body: 'plain text',
    filename: 'not-html.txt',
    type: 'txt',
    userId: owner.userId,
  })
  const server = createAppServer({ getEnv: () => ({}) })
  const origin = await listen(server)
  const headers = { Authorization: `Bearer ${owner.token}` }
  try {
    const byFilename = await fetch(
      `${origin}/api/artifacts/${encodeURIComponent(htmlArtifact.filename)}/preview-session`,
      { method: 'POST', headers },
    )
    assert.equal(byFilename.status, 201)
    const payload = await byFilename.json()
    assert.equal((await fetch(`${origin}${payload.url}`)).status, 200)

    const wrongType = await fetch(
      `${origin}/api/artifacts/${encodeURIComponent(textArtifact.id)}/preview-session`,
      { method: 'POST', headers },
    )
    assert.equal(wrongType.status, 400)
    assert.equal((await wrongType.json()).error.code, 'ARTIFACT_HTML_PREVIEW_TYPE_REQUIRED')
  } finally {
    await close(server)
  }
})

test('same managed filename claimed across users cannot authorize either artifact', async () => {
  const firstOwner = issueTestSession()
  const secondOwner = issueTestSession()
  const filename = 'cross-user-collision.html'
  const first = registerArtifact({
    body: '<!doctype html><html><body><main>First owner</main></body></html>',
    filename,
    userId: firstOwner.userId,
  })
  const second = registerArtifact({
    body: '<!doctype html><html><body><main>Second owner</main></body></html>',
    filename,
    userId: secondOwner.userId,
  })
  const server = createAppServer({ getEnv: () => ({}) })
  const origin = await listen(server)
  try {
    for (const [owner, selector] of [
      [firstOwner, first.id],
      [secondOwner, second.id],
      [firstOwner, filename],
      [secondOwner, filename],
    ]) {
      const response = await fetch(
        `${origin}/api/artifacts/${encodeURIComponent(selector)}/preview-session`,
        { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` } },
      )
      assert.equal(response.status, 404)
      assert.equal((await response.json()).error.code, 'ARTIFACT_HTML_PREVIEW_NOT_FOUND')
    }
  } finally {
    await close(server)
  }
})

test('preview tickets expire absolutely even when the artifact still exists', () => {
  const owner = issueTestSession()
  const artifact = registerArtifact({
    body: '<!doctype html><html><body><main>Expiring preview</main></body></html>',
    filename: 'expiring-preview.html',
    userId: owner.userId,
  })
  const session = createArtifactHtmlPreviewSession({
    userId: owner.userId,
    artifactSelector: artifact.id,
    now: () => 1_000,
  })
  assert.equal(isArtifactHtmlPreviewTicketActive(session.ticket, { now: () => 1_001 }), true)
  assert.match(getArtifactHtmlPreviewDocument({
    ticket: session.ticket,
    now: () => 1_002,
  }).body.toString('utf8'), /Expiring preview/)
  assert.throws(
    () => getArtifactHtmlPreviewDocument({ ticket: session.ticket, now: () => Number.MAX_SAFE_INTEGER }),
    (error) => error?.statusCode === 404 && error?.code === 'ARTIFACT_HTML_PREVIEW_EXPIRED',
  )
})

test.after(() => {
  clearArtifactHtmlPreviewSessions()
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})
