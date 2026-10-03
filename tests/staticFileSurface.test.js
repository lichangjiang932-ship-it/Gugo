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
    end(body) { captured.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '') },
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
