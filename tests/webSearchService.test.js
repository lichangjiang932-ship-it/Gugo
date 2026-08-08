import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-web-search-service-'))
process.env.APP_DATA_DIR = dir
process.env.APP_DB_PATH = path.join(dir, 'app.db')
process.env.CREDENTIAL_KEY_PATH = path.join(dir, '.credentials.key')

const { closeDb, createUser, getDb } = await import('../server/db.js')
const { isCredentialEnvelope } = await import('../server/utils/credentialVault.js')
const { getWebSearchConfig } = await import('../server/services/webSearchConfigStore.js')
const {
  configureWebSearch,
  isWebSearchReady,
  searchWeb,
} = await import('../server/services/webSearchService.js')

const users = ['search-alice', 'search-bob', 'search-custom']
for (const id of users) createUser({ id, email: `${id}@example.com` })

test.after(() => {
  closeDb()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('web search configuration encrypts API keys and stays user-scoped', () => {
  const saved = configureWebSearch({
    userId: 'search-alice', provider: 'tavily', enabled: true, apiKey: 'tavily-secret', config: {},
  })
  assert.equal(saved.apiKeyPresent, true)
  assert.equal('secret' in saved, false)
  assert.equal(getWebSearchConfig({ userId: 'search-bob' }), null)

  const row = getDb().prepare('SELECT secret_json FROM web_search_configs WHERE user_id = ?').get('search-alice')
  assert.equal(isCredentialEnvelope(row.secret_json), true)
  assert.equal(row.secret_json.includes('tavily-secret'), false)
  assert.equal(isWebSearchReady({ userId: 'search-alice' }), true)
  assert.equal(isWebSearchReady({ userId: 'search-bob' }), false)

  configureWebSearch({ userId: 'search-alice', provider: 'tavily', enabled: false, config: {} })
  assert.equal(isWebSearchReady({ userId: 'search-alice' }), false)
  const switched = configureWebSearch({ userId: 'search-alice', provider: 'brave', enabled: true, config: {} })
  assert.equal(switched.apiKeyPresent, false, 'a key from another provider must not be reused')
})

test('all preset providers normalize title, URL, and snippet results', async () => {
  const cases = [
    ['tavily', {}, { results: [{ title: 'Tavily', url: 'https://example.com/t', content: 't snippet' }] }],
    ['brave', {}, { web: { results: [{ title: 'Brave', url: 'https://example.com/b', description: 'b snippet' }] } }],
    ['serper', {}, { organic: [{ title: 'Serper', link: 'https://example.com/s', snippet: 's snippet' }] }],
    ['bing', {}, { webPages: { value: [{ name: 'Bing', url: 'https://example.com/i', snippet: 'i snippet' }] } }],
    ['google_cse', { cx: 'test-cx' }, { items: [{ title: 'Google', link: 'https://example.com/g', snippet: 'g snippet' }] }],
  ]
  for (const [provider, config, responseData] of cases) {
    configureWebSearch({ userId: 'search-alice', provider, enabled: true, config, apiKey: `${provider}-key` })
    const result = await searchWeb({
      userId: 'search-alice', query: 'latest model', maxResults: 4,
      fetchImpl: async () => new Response(JSON.stringify(responseData), { headers: { 'Content-Type': 'application/json' } }),
    })
    assert.equal(result.provider, provider)
    assert.equal(result.results.length, 1)
    assert.deepEqual(Object.keys(result.results[0]), ['title', 'url', 'snippet'])
  }
})

test('custom REST templates substitute values and refuse redirects', async () => {
  configureWebSearch({
    userId: 'search-custom', provider: 'custom', enabled: true, apiKey: 'custom-secret',
    config: {
      baseUrl: 'https://search.example.com/v1/search', method: 'POST',
      headersTemplate: '{"Authorization":"Bearer {apiKey}"}',
      bodyTemplate: '{"term":"{query}","limit":"{maxResults}"}',
      resultPath: 'data.items', titlePath: 'heading', urlPath: 'href', snippetPath: 'summary',
    },
  })
  let receivedInit
  const result = await searchWeb({
    userId: 'search-custom', query: 'Gugo latest', maxResults: 2,
    fetchImpl: async (_url, init) => {
      receivedInit = init
      return new Response(JSON.stringify({ data: { items: [{ heading: 'Result', href: 'https://example.com/r', summary: 'Fresh' }] } }))
    },
  })
  assert.equal(receivedInit.redirect, 'error')
  assert.equal(receivedInit.headers.Authorization, 'Bearer custom-secret')
  assert.deepEqual(JSON.parse(receivedInit.body), { term: 'Gugo latest', limit: 2 })
  assert.equal(result.results[0].title, 'Result')

  let requests = 0
  await assert.rejects(searchWeb({
    userId: 'search-custom', query: 'redirect',
    fetchImpl: async (_url, init) => {
      requests += 1
      assert.equal(init.redirect, 'error')
      return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/private' } })
    },
  }), (error) => error.code === 'WEB_SEARCH_UPSTREAM_ERROR')
  assert.equal(requests, 1)
})

test('custom REST rejects loopback, private, and metadata targets before fetch', async () => {
  for (const baseUrl of ['http://127.0.0.1/search', 'http://10.0.0.8/search', 'http://169.254.169.254/latest/meta-data']) {
    configureWebSearch({
      userId: 'search-custom', provider: 'custom', enabled: true,
      config: { baseUrl, method: 'GET', queryParam: 'q', resultPath: 'results', titlePath: 'title', urlPath: 'url', snippetPath: 'snippet' },
    })
    let called = false
    await assert.rejects(
      searchWeb({ userId: 'search-custom', query: 'blocked', fetchImpl: async () => { called = true; return new Response('{}') } }),
      (error) => error.code === 'WEB_SEARCH_SSRF_BLOCKED',
    )
    assert.equal(called, false)
  }
})

test('unconfigured and disabled users receive explicit errors', async () => {
  await assert.rejects(searchWeb({ userId: 'search-bob', query: 'latest' }), (error) => error.code === 'WEB_SEARCH_NOT_CONFIGURED')
  configureWebSearch({ userId: 'search-bob', provider: 'brave', enabled: false, apiKey: 'key', config: {} })
  await assert.rejects(searchWeb({ userId: 'search-bob', query: 'latest' }), (error) => error.code === 'WEB_SEARCH_DISABLED')
})
