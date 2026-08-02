import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import {
  allowParkedBridgeMessageApi,
  listParkedBridgeMessagesApi,
  rejectParkedBridgeMessageApi,
} from '../src/lib/integrationsClient.js'
import { TOKEN_KEY } from '../src/lib/accountClient.js'

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('陌生消息客户端调用认证后的查询、允许和拒绝路由', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/access' })
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.window = dom.window
  dom.window.localStorage.setItem(TOKEN_KEY, 'test-token')
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    return jsonResponse({ ok: true, messages: [] })
  }

  try {
    await listParkedBridgeMessagesApi({ status: 'failed', limit: 12 })
    await allowParkedBridgeMessageApi('parked/a b')
    await rejectParkedBridgeMessageApi('parked/a b')

    assert.equal(requests[0].url, '/api/bridge/parked?status=failed&limit=12')
    assert.equal(requests[0].init.headers.Authorization, 'Bearer test-token')
    assert.equal(requests[1].url, '/api/bridge/parked/parked%2Fa%20b/allow')
    assert.equal(requests[1].init.method, 'POST')
    assert.equal(requests[1].init.headers.Authorization, 'Bearer test-token')
    assert.equal(requests[2].url, '/api/bridge/parked/parked%2Fa%20b/reject')
    assert.equal(requests[2].init.method, 'POST')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    dom.window.close()
  }
})
