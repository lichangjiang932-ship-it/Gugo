import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'

import { fetchRemoteMarkdownImage, MAX_REMOTE_MARKDOWN_IMAGE_BYTES } from '../server/services/remoteMarkdownImage.js'
import { htmlPreviewRemoteImageOrigins } from '../server/services/htmlPreviewRemoteImagePolicy.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-remote-image-tests-'))
process.env.APP_DATA_DIR = root
process.env.APP_DB_PATH = path.join(root, 'app.db')
process.env.GUGO_LOAD_DOTENV = '0'
delete process.env.GUGO_PURE_LOCAL_MODE
const { handleMediaRequest } = await import('../server/routes/mediaRoutes.js')
const { handleRuntimeConfigRequest } = await import('../server/routes/runtimeConfigRoutes.js')
const { securityHeaders } = await import('../server/middleware.js')
const { issueTestSession } = await import('./helpers/testAuth.js')
const { closeDb } = await import('../server/db.js')
const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer()
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
const response = (body = png, type = 'image/png', headers = {}) => new Response(body, {
  headers: { 'Content-Type': type, ...headers },
})

test.after(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }) })
test.beforeEach(() => { delete process.env.GUGO_PURE_LOCAL_MODE })

test('remote images use the pinned public guard and never forward viewer credentials', async () => {
  const requests = []
  const image = await fetchRemoteMarkdownImage('https://public.example.test/image.png', {
    lookup: publicLookup,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return response() },
  })
  assert.equal(image.mimeType, 'image/png')
  assert.deepEqual(image.buffer, png)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.redirect, 'manual')
  assert.equal(requests[0].init.credentials, 'omit')
  assert.deepEqual(Object.keys(requests[0].init.headers), ['Accept'])
  assert.ok(requests[0].init.dispatcher)
})

test('pure-local rejects remote images before DNS and configured preview origins cannot bypass it', async () => {
  let attempts = 0
  await assert.rejects(fetchRemoteMarkdownImage('https://public.example.test/image.png', {
    env: { GUGO_PURE_LOCAL_MODE: '1' },
    lookup: async () => { attempts += 1; return publicLookup() },
    fetchImpl: async () => { attempts += 1; return response() },
  }), (error) => error?.code === 'OUTBOUND_PURE_LOCAL_DENIED')
  assert.equal(attempts, 0)
  assert.deepEqual(htmlPreviewRemoteImageOrigins({
    GUGO_PURE_LOCAL_MODE: '1', HTML_PREVIEW_REMOTE_IMAGE_ORIGINS: 'https://images.example.test',
  }), [])
})

test('the image proxy denies private targets, credentials, and public-to-private redirects', async () => {
  let requests = 0
  const options = { lookup: publicLookup, fetchImpl: async () => { requests += 1; return response() } }
  for (const url of ['http://127.0.0.1/a.png', 'http://169.254.169.254/a.png', 'https://user:secret@public.example.test/a.png']) {
    await assert.rejects(fetchRemoteMarkdownImage(url, options), (error) => error?.code?.startsWith('OUTBOUND_'))
  }
  assert.equal(requests, 0)
  await assert.rejects(fetchRemoteMarkdownImage('https://public.example.test/a.png', {
    lookup: publicLookup,
    fetchImpl: async () => {
      requests += 1
      return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private.png' } })
    },
  }), (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED')
  assert.equal(requests, 1)
})

test('image responses are bounded and decoded rather than trusting MIME alone', async () => {
  const options = (fetchImpl) => ({ lookup: publicLookup, fetchImpl })
  for (const type of ['text/html', 'image/svg+xml']) {
    await assert.rejects(fetchRemoteMarkdownImage('https://public.example.test/image', options(async () => response('<svg/>', type))),
      (error) => error?.code === 'REMOTE_IMAGE_TYPE_UNSUPPORTED')
  }
  await assert.rejects(fetchRemoteMarkdownImage('https://public.example.test/image', options(async () => response('<html/>'))),
    (error) => error?.code === 'REMOTE_IMAGE_INVALID')
  await assert.rejects(fetchRemoteMarkdownImage('https://public.example.test/image', options(async () => response(png, 'image/png', {
    'Content-Length': String(MAX_REMOTE_MARKDOWN_IMAGE_BYTES + 1),
  }))), (error) => error?.code === 'REMOTE_IMAGE_TOO_LARGE')
  let cancelled = false
  const oversized = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_REMOTE_MARKDOWN_IMAGE_BYTES + 1)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(fetchRemoteMarkdownImage('https://public.example.test/image', options(async () => response(oversized))),
    (error) => error?.code === 'REMOTE_IMAGE_TOO_LARGE')
  assert.equal(cancelled, true)
})

test('an actual policy API change immediately gates new image requests and page CSP without client env state', async (context) => {
  const owner = issueTestSession({ email: 'image-audit-owner@example.test' })
  const env = { APP_DATA_DIR: root, LOCAL_USER_ID: owner.userId, AUTH_MODE: 'local', GUGO_LOAD_DOTENV: '0' }
  let imageRequests = 0
  const server = http.createServer((req, res) => securityHeaders(req, res, () => {
    const task = req.url.startsWith('/api/system/network-policy')
      ? handleRuntimeConfigRequest(req, res, { cwd: root, env })
      : handleMediaRequest(req, res, {
          env,
          fetchImage: (url, options) => fetchRemoteMarkdownImage(url, {
            ...options, lookup: publicLookup,
            fetchImpl: async () => { imageRequests += 1; return response() },
          }),
        })
    Promise.resolve(task).catch((error) => res.destroy(error))
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }
  const imageBody = JSON.stringify({ url: 'https://public.example.test/private-title.png' })
  assert.equal((await fetch(`${origin}/api/media/remote-image`, { method: 'POST', body: imageBody })).status, 401)
  assert.equal(imageRequests, 0)
  const online = await fetch(`${origin}/api/media/remote-image`, { method: 'POST', headers, body: imageBody })
  assert.equal(online.status, 200)
  assert.equal(online.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(Buffer.from(await online.arrayBuffer()), png)
  assert.equal(imageRequests, 1)
  const switched = await fetch(`${origin}/api/system/network-policy`, {
    method: 'PATCH', headers, body: JSON.stringify({ pureLocal: true }),
  })
  assert.equal(switched.status, 200)
  assert.equal((await switched.json()).policy.pureLocal, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8')).env.GUGO_PURE_LOCAL_MODE, '1')
  const blocked = await fetch(`${origin}/api/media/remote-image`, { method: 'POST', headers, body: imageBody })
  assert.equal(blocked.status, 403)
  assert.equal((await blocked.json()).error.code, 'OUTBOUND_PURE_LOCAL_DENIED')
  assert.equal(imageRequests, 1)
  const csp = blocked.headers.get('content-security-policy')
  assert.match(csp, /img-src 'self' data: blob:;/)
  assert.match(csp, /connect-src 'self';/)
  assert.doesNotMatch(csp, /https:|wss:/)
})
