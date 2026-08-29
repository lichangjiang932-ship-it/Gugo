import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchConnectorJson, readBoundedResponseText } from '../server/services/connectorHttp.js'
import { assertSafeOutboundUrl, resolvePublicHost } from '../server/utils/outboundNetworkGuard.js'

test('connector HTTP rejects declared and streamed responses above the byte limit', async () => {
  await assert.rejects(
    readBoundedResponseText(new Response('12345', { headers: { 'content-length': '5' } }), 4),
    (error) => error.code === 'connector_response_too_large' && error.statusCode === 502,
  )
  await assert.rejects(
    fetchConnectorJson('https://example.com', {}, {
      maxResponseBytes: 4,
      fetchImpl: async () => new Response('你好'),
    }),
    (error) => error.code === 'connector_response_too_large',
  )
})

test('connector HTTP enforces timeout and respects upstream cancellation', async () => {
  const hangingFetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })
  await assert.rejects(
    fetchConnectorJson('https://example.com', {}, { timeoutMs: 5, fetchImpl: hangingFetch }),
    (error) => error.code === 'connector_request_timeout' && error.retryable === true,
  )

  const controller = new AbortController()
  const request = fetchConnectorJson('https://example.com', { signal: controller.signal }, { timeoutMs: 1000, fetchImpl: hangingFetch })
  controller.abort()
  await assert.rejects(request, (error) => error.code === 'connector_request_aborted' && error.retryable === false)
})

test('connector HTTP parses JSON and preserves non-JSON error bodies as raw text', async () => {
  const json = await fetchConnectorJson('https://example.com/json', {}, { fetchImpl: async () => new Response('{"ok":true}') })
  const raw = await fetchConnectorJson('https://example.com/raw', {}, { fetchImpl: async () => new Response('upstream unavailable', { status: 503 }) })
  assert.deepEqual(json.data, { ok: true })
  assert.deepEqual(raw.data, { raw: 'upstream unavailable' })
  assert.equal(raw.response.status, 503)
})

test('connector outbound guard rejects private IPs and DNS answers and pins public targets', async () => {
  await assert.rejects(assertSafeOutboundUrl('https://127.0.0.1/rest/api/3'), /private|loopback/i)
  await assert.rejects(
    resolvePublicHost('jira.example', { lookup: async () => [{ address: '169.254.169.254', family: 4 }] }),
    /private/i,
  )
  const result = await resolvePublicHost('jira.example', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  })
  assert.equal(result.lockedIp, '93.184.216.34')
})
