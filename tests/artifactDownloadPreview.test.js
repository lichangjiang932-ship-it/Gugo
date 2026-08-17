import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-artifact-download-'))
const artifactDir = path.join(tempDir, 'artifacts')
process.env.APP_DATA_DIR = tempDir
process.env.ARTIFACT_DIR = artifactDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { appendJobArtifact, createJob } = await import('../server/services/jobStore.js')
const {
  beginHtmlArtifactAssetInstall,
  finishHtmlArtifactAssetInstall,
  stageHtmlArtifactAssets,
} = await import('../server/services/htmlArtifactAssets.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

fs.mkdirSync(artifactDir, { recursive: true })

function registerArtifact({ filename, body, userId, index }) {
  const jobId = `preview-job-${index}`
  const url = `/api/artifacts/${encodeURIComponent(filename)}`
  fs.writeFileSync(path.join(artifactDir, filename), body)
  createJob({ id: jobId, userId, title: filename, prompt: filename, status: 'completed' })
  appendJobArtifact({
    id: `preview-artifact-${index}`,
    jobId,
    userId,
    type: path.extname(filename).slice(1),
    title: filename,
    url,
    filename,
  })
  return url
}

test('artifact preview responses are inline, range-aware, Unicode-safe, and sandboxed', async () => {
  const { token, userId } = issueTestSession()
  const pdfBody = Buffer.from('%PDF-1.7\nGugo preview fixture\n%%EOF')
  const pdfUrl = registerArtifact({ filename: '季度报告.pdf', body: pdfBody, userId, index: 1 })
  const htmlUrl = registerArtifact({ filename: 'interactive.html', body: '<script>document.body.textContent="ready"</script>', userId, index: 2 })
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { Authorization: `Bearer ${token}` }

  try {
    const preview = await fetch(`${origin}${pdfUrl}?preview=1`, { headers })
    assert.equal(preview.status, 200)
    assert.equal(preview.headers.get('content-type'), 'application/pdf')
    assert.match(preview.headers.get('content-disposition') || '', /^inline;/)
    assert.match(preview.headers.get('content-disposition') || '', /filename\*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A\.pdf/)
    assert.equal(preview.headers.get('x-frame-options'), 'SAMEORIGIN')
    assert.equal(preview.headers.get('accept-ranges'), 'bytes')
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), pdfBody)

    const range = await fetch(`${origin}${pdfUrl}?preview=1`, {
      headers: { ...headers, Range: 'bytes=0-3' },
    })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), `bytes 0-3/${pdfBody.length}`)
    assert.equal(Buffer.from(await range.arrayBuffer()).toString('ascii'), '%PDF')

    const download = await fetch(`${origin}${pdfUrl}`, { method: 'HEAD', headers })
    assert.match(download.headers.get('content-disposition') || '', /^attachment;/)

    const html = await fetch(`${origin}${htmlUrl}?preview=1`, { method: 'HEAD', headers })
    const htmlCsp = html.headers.get('content-security-policy') || ''
    assert.match(htmlCsp, /^sandbox allow-scripts;/)
    assert.doesNotMatch(htmlCsp, /allow-(?:same-origin|forms)/)
    assert.match(htmlCsp, /connect-src 'none'/)
    assert.match(htmlCsp, /form-action 'none'/)
    assert.match(htmlCsp, /img-src data: blob:/)
    assert.match(htmlCsp, /media-src data: blob:/)
    assert.match(htmlCsp, /font-src data:/)
    assert.doesNotMatch(htmlCsp, /https?:/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('artifact previews return explicit MIME types for newer media formats', async () => {
  const { token, userId } = issueTestSession()
  const cases = [
    ['sample.avif', 'image/avif'],
    ['sample.bmp', 'image/bmp'],
    ['sample.opus', 'audio/ogg'],
    ['sample.ogv', 'video/ogg'],
  ]
  const urls = cases.map(([filename], index) => registerArtifact({
    filename,
    body: Buffer.from(`fixture-${filename}`),
    userId,
    index: index + 10,
  }))
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`

  try {
    for (let index = 0; index < cases.length; index += 1) {
      const response = await fetch(`${origin}${urls[index]}?preview=1`, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), cases[index][1], cases[index][0])
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('HTML media assets are owner-scoped, range-aware, and downloads become standalone', async () => {
  const owner = issueTestSession()
  const outsider = issueTestSession()
  const index = 30
  const artifactId = `preview-artifact-${index}`
  const filename = 'media-gallery.html'
  const htmlBody = '<!doctype html><html><body><img src="gugo-asset://portrait"><main>Gallery</main></body></html>'
  const url = registerArtifact({ filename, body: htmlBody, userId: owner.userId, index })
  const mediaDirectory = path.join(tempDir, 'media')
  const portraitPath = path.join(mediaDirectory, 'portrait.jpg')
  const portrait = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#4f46e5' },
  }).jpeg().toBuffer()
  fs.mkdirSync(mediaDirectory, { recursive: true })
  fs.writeFileSync(portraitPath, portrait)
  finishHtmlArtifactAssetInstall(beginHtmlArtifactAssetInstall(await stageHtmlArtifactAssets({
    artifactDirectory: artifactDir,
    artifactId,
    parentFilename: filename,
    requiredAssetIds: ['portrait'],
    sources: [{ id: 'portrait', sourcePath: portraitPath }],
  })))

  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const assetUrl = `${origin}${url}/assets/portrait`
  try {
    const unauthorized = await fetch(assetUrl)
    assert.equal(unauthorized.status, 401)

    const hiddenFromOutsider = await fetch(assetUrl, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    })
    assert.equal(hiddenFromOutsider.status, 404)

    const asset = await fetch(assetUrl, {
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(asset.status, 200)
    assert.equal(asset.headers.get('content-type'), 'image/jpeg')
    assert.match(asset.headers.get('content-disposition') || '', /^inline;/)
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), portrait)

    const range = await fetch(assetUrl, {
      headers: { Authorization: `Bearer ${owner.token}`, Range: 'bytes=0-2' },
    })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), `bytes 0-2/${portrait.length}`)
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), portrait.subarray(0, 3))

    const head = await fetch(assetUrl, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(head.status, 200)
    assert.equal(Number(head.headers.get('content-length')), portrait.length)

    const preview = await fetch(`${origin}${url}?preview=1`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(await preview.text(), htmlBody)

    const download = await fetch(`${origin}${url}`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    const standalone = await download.text()
    assert.match(standalone, /data:image\/jpeg;base64,/)
    assert.doesNotMatch(standalone, /gugo-asset:\/\//)
    assert.match(standalone, /http-equiv="Content-Security-Policy"/i)
    assert.match(standalone, /connect-src 'none'/)
    assert.match(standalone, /form-action 'none'/)
    assert.ok(
      standalone.indexOf('Content-Security-Policy') < standalone.indexOf('<html>'),
      'offline CSP must precede document markup',
    )

    const missing = await fetch(`${origin}${url}/assets/missing`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(missing.status, 404)
    const post = await fetch(assetUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}` },
    })
    assert.equal(post.status, 405)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('oversized offline HTML downloads return a stable 413 while managed preview remains available', async () => {
  const owner = issueTestSession()
  const index = 31
  const artifactId = `preview-artifact-${index}`
  const filename = 'large-media-gallery.html'
  const repeated = Array.from({ length: 100 }, () => '<img src="gugo-asset://media">').join('')
  const htmlBody = `<!doctype html><html><body>${repeated}<main>Large gallery</main></body></html>`
  const url = registerArtifact({ filename, body: htmlBody, userId: owner.userId, index })
  const mediaDirectory = path.join(tempDir, 'large-media')
  const mediaPath = path.join(mediaDirectory, 'media.png')
  fs.mkdirSync(mediaDirectory, { recursive: true })
  const mediaBytes = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: '#5a5a5a' },
  }).png({ compressionLevel: 0 }).toBuffer()
  fs.writeFileSync(mediaPath, mediaBytes)
  finishHtmlArtifactAssetInstall(beginHtmlArtifactAssetInstall(await stageHtmlArtifactAssets({
    artifactDirectory: artifactDir,
    artifactId,
    parentFilename: filename,
    requiredAssetIds: ['media'],
    sources: [{ id: 'media', sourcePath: mediaPath }],
  })))

  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { Authorization: `Bearer ${owner.token}` }
  try {
    const preview = await fetch(`${origin}${url}?preview=1`, { headers })
    assert.equal(preview.status, 200)
    assert.equal(await preview.text(), htmlBody)

    const download = await fetch(`${origin}${url}`, { headers })
    assert.equal(download.status, 413)
    assert.equal(download.headers.get('x-gugo-error-code'), 'HTML_ASSET_OFFLINE_TOO_LARGE')
    assert.match(download.headers.get('content-type') || '', /^application\/json/)
    const body = await download.json()
    assert.equal(body.error.code, 'HTML_ASSET_OFFLINE_TOO_LARGE')
    assert.equal(body.error.previewAvailable, true)
    assert.match(body.error.message, /managed preview/i)

    const head = await fetch(`${origin}${url}`, { method: 'HEAD', headers })
    assert.equal(head.status, 413)
    assert.equal(head.headers.get('x-gugo-error-code'), 'HTML_ASSET_OFFLINE_TOO_LARGE')
    assert.equal(await head.text(), '')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})
