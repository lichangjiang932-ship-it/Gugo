import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { serveStatic } from '../server/appServerHttpSurface.js'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-static-surface-'))
const staticDir = path.join(tempDir, 'dist')
const siblingDir = path.join(tempDir, 'dist-backup')
fs.mkdirSync(staticDir)
fs.mkdirSync(siblingDir)
fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>app</title><script src="./app.js"></script>', 'utf8')
fs.writeFileSync(path.join(staticDir, 'app.js'), 'export const ready = true', 'utf8')
const fontBytes = fs.readFileSync(new URL('../node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2', import.meta.url))
fs.mkdirSync(path.join(staticDir, 'assets'))
fs.writeFileSync(path.join(staticDir, 'assets', 'ui-font.woff2'), fontBytes)
fs.writeFileSync(path.join(siblingDir, 'secret.html'), '<!doctype html><title>sibling secret</title>', 'utf8')
fs.writeFileSync(path.join(tempDir, 'outside.txt'), 'outside the root', 'utf8')

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function request(url) {
  const captured = { statusCode: 0, body: '', headers: {} }
  const res = {
    locals: { cspNonce: 'test-nonce' },
    writeHead(statusCode, headers) {
      captured.statusCode = statusCode
      captured.headers = headers || {}
    },
    end(body) {
      captured.bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''))
      captured.body = captured.bytes.toString('utf8')
    },
  }
  serveStatic({ url }, res, staticDir)
  return captured
}

test('static assets inside the root are served', () => {
  const index = request('/')
  assert.equal(index.statusCode, 200)
  assert.match(index.body, /<title>app<\/title>/u)
  assert.match(index.body, /nonce="test-nonce"/u)

  const asset = request('/app.js')
  assert.equal(asset.statusCode, 200)
  assert.equal(asset.body, 'export const ready = true')
})

test('WOFF2 static assets retain their exact bytes and font MIME type', () => {
  const response = request('/assets/ui-font.woff2?v=5.3.1')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Content-Type'], 'font/woff2')
  assert.deepEqual(response.bytes, fontBytes)
  assert.equal(response.headers['Cache-Control'], 'public, max-age=3600')
})

test('a missing WOFF2 asset is a 404, never the SPA index document', () => {
  const response = request('/assets/missing-font.woff2')
  assert.equal(response.statusCode, 404)
  assert.equal(response.headers['Content-Type'], 'text/plain; charset=utf-8')
  assert.equal(response.body, 'Not Found')
  assert.doesNotMatch(response.body, /<!doctype|<script/iu)
})

test('a sibling directory sharing the root prefix is not reachable', () => {
  // `path.normalize` plus a plain `startsWith` used to accept
  // `<root>-backup/secret.html`, because `dist-backup` starts with `dist`.
  for (const url of [
    '/..%2fdist-backup%2fsecret.html',
    '/%2e%2e%2fdist-backup%2fsecret.html',
    '/..%2foutside.txt',
  ]) {
    const response = request(url)
    assert.equal(response.statusCode, 403, url)
    assert.equal(response.body, 'Forbidden', url)
  }

  // The URL parser collapses a literal `/../` before the handler sees it, so
  // these resolve inside the root and only reach the index fallback.
  for (const url of ['/../dist-backup/secret.html', '/../outside.txt']) {
    const response = request(url)
    assert.doesNotMatch(response.body, /sibling secret|outside the root/u, url)
  }
})

test('a malformed percent escape is a 400 instead of an unhandled throw', () => {
  const response = request('/%zz')
  assert.equal(response.statusCode, 400)
  assert.equal(response.body, 'Bad Request')
})

test('an unknown path falls back to the index document', () => {
  const response = request('/deep/unknown/route')
  assert.equal(response.statusCode, 200)
  assert.match(response.body, /<title>app<\/title>/u)
})
