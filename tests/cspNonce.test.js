import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAppServer } from '../server/appServer.js'
import { securityHeaders } from '../server/middleware.js'

// CI 阶段顺序 Lint → Test → Build，集成测试运行时 dist/index.html 可能还不存在。
// 使用隔离的临时静态目录，断言 nonce 注入语义而非 vite 真实产物。
function createStaticFixture() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-csp-'))
  const distIndex = path.join(staticDir, 'index.html')
  fs.writeFileSync(
    distIndex,
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>',
  )
  fs.writeFileSync(
    path.join(staticDir, 'mobile.html'),
    '<!doctype html><html><body><script src="/mobile.js"></script></body></html>',
  )
  fs.writeFileSync(path.join(staticDir, 'mobile.js'), 'document.body.dataset.ready = "1"')
  return {
    staticDir,
    cleanup() {
      fs.rmSync(staticDir, { recursive: true, force: true })
    },
  }
}

function getDirective(csp, name) {
  return csp
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith(`${name} `))
}

test('securityHeaders creates a per-response CSP nonce without script unsafe-inline', () => {
  const req = { headers: {}, connection: {} }
  const createRes = () => {
    const headers = new Map()
    return {
      headers,
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value)
      },
    }
  }
  const res = createRes()

  let nextCalled = false
  securityHeaders(req, res, () => {
    nextCalled = true
  })

  const nonce = res.locals?.cspNonce
  const csp = res.headers.get('content-security-policy')
  const scriptSrc = getDirective(csp, 'script-src')
  const secondRes = createRes()
  securityHeaders(req, secondRes, () => {})

  assert.equal(nextCalled, true)
  assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/)
  assert.notEqual(secondRes.locals?.cspNonce, nonce)
  assert.ok(scriptSrc.includes(`'nonce-${nonce}'`))
  assert.ok(scriptSrc.includes("'strict-dynamic'"))
  assert.ok(!scriptSrc.includes("'unsafe-inline'"))
})

test('connect-src never allows a bare scheme source', () => {
  const createRes = () => {
    const headers = new Map()
    return {
      headers,
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value)
      },
    }
  }

  const previousEndpoints = process.env.ALLOWED_MODEL_ENDPOINTS
  const previousPureLocal = process.env.GUGO_PURE_LOCAL_MODE
  delete process.env.GUGO_PURE_LOCAL_MODE
  try {
    const allowed = createRes()
    securityHeaders({ headers: {}, connection: {} }, allowed, () => {})
    const connectSrc = getDirective(allowed.headers.get('content-security-policy'), 'connect-src')
    const sources = connectSrc.split(/\s+/u).slice(1)
    assert.ok(sources.includes("'self'"), connectSrc)
    for (const source of sources) {
      assert.doesNotMatch(source, /^(?:ws|wss|https?):$/u, connectSrc)
    }

    process.env.ALLOWED_MODEL_ENDPOINTS = 'https://models.example/v1,ws://models.example'
    const extra = createRes()
    securityHeaders({ headers: {}, connection: {} }, extra, () => {})
    const extraConnect = getDirective(extra.headers.get('content-security-policy'), 'connect-src')
    // An operator-supplied entry stays an exact source; it is never widened into
    // a scheme source such as a bare `ws:`.
    assert.ok(extraConnect.includes('https://models.example/v1'), extraConnect)
    assert.ok(extraConnect.includes('ws://models.example'), extraConnect)
  } finally {
    if (previousEndpoints === undefined) delete process.env.ALLOWED_MODEL_ENDPOINTS
    else process.env.ALLOWED_MODEL_ENDPOINTS = previousEndpoints
    if (previousPureLocal === undefined) delete process.env.GUGO_PURE_LOCAL_MODE
    else process.env.GUGO_PURE_LOCAL_MODE = previousPureLocal
  }
})

test('static index response injects CSP nonce into every script tag', async () => {
  const fixture = createStaticFixture()
  const server = createAppServer({ getEnv: () => ({}), staticDir: fixture.staticDir })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`)
    const html = await res.text()
    const csp = res.headers.get('content-security-policy')
    const scriptSrc = getDirective(csp, 'script-src')
    const nonce = scriptSrc.match(/'nonce-([^']+)'/)?.[1]
    const scriptTags = html.match(/<script\b[^>]*>/g) || []

    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store, must-revalidate')
    assert.ok(nonce)
    assert.ok(scriptTags.length > 0)
    for (const tag of scriptTags) {
      assert.ok(tag.includes(`nonce="${nonce}"`), tag)
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fixture.cleanup()
  }
})

test('static mobile HTML receives a nonce and is never cached', async () => {
  const fixture = createStaticFixture()
  const server = createAppServer({ getEnv: () => ({}), staticDir: fixture.staticDir })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mobile.html`)
    const html = await res.text()
    const nonce = res.headers.get('content-security-policy')?.match(/'nonce-([^']+)'/)?.[1]
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store, must-revalidate')
    assert.ok(nonce)
    assert.ok(html.includes(`<script nonce="${nonce}" src="/mobile.js">`))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fixture.cleanup()
  }
})
