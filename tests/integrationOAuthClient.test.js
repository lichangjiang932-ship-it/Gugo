import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  getIntegrationOAuthStatusApi,
  listIntegrationOAuthProvidersApi,
  startIntegrationOAuthApi,
} from '../src/lib/integrationsClient.js'
import { TOKEN_KEY } from '../src/lib/accountClient.js'

test('OAuth client calls authenticated provider, start, and status endpoints', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/access' })
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.window = dom.window
  dom.window.localStorage.setItem(TOKEN_KEY, 'oauth-client-token')
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true, providers: [], session: { id: 'oauth-1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    await listIntegrationOAuthProvidersApi()
    await startIntegrationOAuthApi({ provider: 'github', integrationId: 'int-1' })
    await getIntegrationOAuthStatusApi('oauth/a b')
    assert.equal(requests[0].url, '/api/integrations/oauth/providers')
    assert.equal(requests[0].init.headers.Authorization, 'Bearer oauth-client-token')
    assert.equal(requests[1].url, '/api/integrations/oauth/start')
    assert.equal(requests[1].init.method, 'POST')
    assert.deepEqual(JSON.parse(requests[1].init.body), {
      provider: 'github',
      integrationId: 'int-1',
    })
    assert.equal(requests[2].url, '/api/integrations/oauth/sessions/oauth%2Fa%20b')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
    dom.window.close()
  }
})
