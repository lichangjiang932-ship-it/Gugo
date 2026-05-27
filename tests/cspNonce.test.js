import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppServer } from '../server/appServer.js'
import { securityHeaders } from '../server/middleware.js'

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
  }
})
