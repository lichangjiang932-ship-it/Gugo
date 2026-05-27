import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAppServer } from '../server/appServer.js'
import { securityHeaders } from '../server/middleware.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const distIndex = path.join(repoRoot, 'dist', 'index.html')
// CI 阶段顺序 Lint → Test → Build，集成测试运行时 dist/index.html 可能还不存在。
// 用一个最小占位 HTML 兜底，断言 nonce 注入语义而非 vite 真实产物。
function ensureDistIndex() {
  if (fs.existsSync(distIndex)) return () => {}
  fs.mkdirSync(path.dirname(distIndex), { recursive: true })
  fs.writeFileSync(
    distIndex,
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>',
  )
  return () => {
    try { fs.unlinkSync(distIndex) } catch { /* ignore */ }
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

test('static index response injects CSP nonce into every script tag', async () => {
  const cleanup = ensureDistIndex()
  const server = createAppServer({ getEnv: () => ({}) })
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
    cleanup()
  }
})
