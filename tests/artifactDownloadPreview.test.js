import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-artifact-download-'))
const artifactDir = path.join(tempDir, 'artifacts')
process.env.APP_DATA_DIR = tempDir
process.env.ARTIFACT_DIR = artifactDir

const { createAppServer } = await import('../server/appServer.js')
const { closeDb } = await import('../server/db.js')
const { appendJobArtifact, createJob } = await import('../server/services/jobStore.js')
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

test.after(() => {
  closeDb()
  fs.rmSync(tempDir, { recursive: true, force: true })
})
