import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-mobile-security-'))

const { handleMobileRequest } = await import('../server/routes/mobileRoutes.js')
const { getDb, closeDb } = await import('../server/db.js')

function request({ key = 'invalid-mobile-key', ip = '198.51.100.9', forwardedFor = '203.0.113.1' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify({ key }))])
  req.method = 'POST'
  req.url = '/api/mobile/handshake'
  req.headers = {
    'content-type': 'application/json',
    'x-forwarded-for': forwardedFor,
  }
  req.socket = { remoteAddress: ip }
  return req
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader(name, value) { this.headers[name.toLowerCase()] = String(value) },
    writeHead(status, headers = {}) {
      this.statusCode = status
      for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value
    },
    end(chunk = '') { if (chunk) this.chunks.push(Buffer.from(String(chunk))) },
  }
}

test('mobile handshake ignores forged XFF, locks repeated failures, and audits denials', async () => {
  const previousRate = process.env.MOBILE_HANDSHAKE_RATE_MAX
  const previousTrust = process.env.TRUST_PROXY
  process.env.MOBILE_HANDSHAKE_RATE_MAX = '2'
  delete process.env.TRUST_PROXY
  const ip = '198.51.100.88'
  try {
    for (let i = 0; i < 2; i += 1) {
      const res = response()
      await handleMobileRequest(request({ ip, forwardedFor: `203.0.113.${i + 10}` }), res)
      assert.equal(res.statusCode, 401)
    }
    const blocked = response()
    await handleMobileRequest(request({ ip, forwardedFor: '192.0.2.200' }), blocked)
    assert.equal(blocked.statusCode, 429)
    assert.ok(Number(blocked.headers['retry-after']) > 0)

    const rows = getDb().prepare(
      "SELECT origin, tool_name, status FROM tool_audit WHERE origin = 'mobile' ORDER BY id"
    ).all()
    assert.equal(rows.length, 3)
    assert.ok(rows.every((row) => row.tool_name === 'mobile_handshake' && row.status === 'denied'))
  } finally {
    if (previousRate == null) delete process.env.MOBILE_HANDSHAKE_RATE_MAX
    else process.env.MOBILE_HANDSHAKE_RATE_MAX = previousRate
    if (previousTrust == null) delete process.env.TRUST_PROXY
    else process.env.TRUST_PROXY = previousTrust
  }
})

test('mobile page stores the bearer token only in sessionStorage', () => {
  const html = fs.readFileSync(new URL('../public/mobile.html', import.meta.url), 'utf8')
  const script = fs.readFileSync(new URL('../public/mobile.js', import.meta.url), 'utf8')
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /<script src="\/mobile\.js"><\/script>/)
  assert.match(script, /sessionStorage\.setItem/)
  assert.doesNotMatch(script, /localStorage\.setItem/)
})

test.after(() => {
  closeDb()
  fs.rmSync(process.env.APP_DATA_DIR, { recursive: true, force: true })
})
