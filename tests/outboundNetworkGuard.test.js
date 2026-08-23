import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import {
  assertSafeOutboundUrl,
  fetchSafeOutbound,
  maskOutboundUrl,
} from '../server/utils/outboundNetworkGuard.js'

function lookupResult(address, family = address.includes(':') ? 6 : 4) {
  return [{ address, family }]
}

async function withLoopbackServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(server.address().port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('outbound diagnostics mask URL credentials, query strings, and fragments', () => {
  const masked = maskOutboundUrl('https://alice:password@example.com/v1/models?api_key=secret#token')
  assert.equal(masked, 'https://example.com/v1/models')
  assert.doesNotMatch(masked, /alice|password|api_key|secret|token/)
})

test('local outbound policy permits model-network ranges but never metadata endpoints', async () => {
  for (const url of [
    'http://127.0.0.1:11434/v1',
    'http://10.0.0.2:1234/v1',
    'http://172.16.0.2:1234/v1',
    'http://192.168.1.2:1234/v1',
    'http://100.64.0.2:1234/v1',
    'http://[fd12:3456::2]:1234/v1',
  ]) {
    await assert.doesNotReject(assertSafeOutboundUrl(url, { allowLocal: true }))
  }

  for (const url of [
    'http://169.254.169.254/latest/meta-data',
    'http://100.100.100.200/latest/meta-data',
    'http://[fd00:ec2::254]/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1',
  ]) {
    await assert.rejects(
      assertSafeOutboundUrl(url, {
        allowLocal: true,
        lookup: async () => lookupResult('93.184.216.34'),
      }),
      (error) => String(error?.code || '').startsWith('OUTBOUND_'),
    )
  }
})

test('DNS answers are rejected before fetch and URL userinfo is forbidden', async () => {
  for (const address of [
    '169.254.169.254',
    '100.100.100.200',
    'fd00:ec2::254',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '::ffff:6464:64c8',
  ]) {
    let fetchCalls = 0
    await assert.rejects(
      fetchSafeOutbound('https://models.example/v1/models', {}, {
        allowLocal: true,
        lookup: async () => lookupResult(address),
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response('{}')
        },
      }),
      (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
    )
    assert.equal(fetchCalls, 0)
  }

  await assert.rejects(
    assertSafeOutboundUrl('http://[::ffff:7f00:1]/'),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )

  await assert.rejects(
    assertSafeOutboundUrl('https://user:secret@models.example/v1'),
    (error) => error?.code === 'OUTBOUND_CREDENTIALS_DENIED',
  )
})

test('approved DNS address is pinned for the connection and remains usable for streamed bodies', async () => {
  await withLoopbackServer((req, res) => {
    assert.equal(req.headers.host?.startsWith('model.local:'), true)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('first-')
    setTimeout(() => res.end('second'), 20)
  }, async (port) => {
    let lookupCalls = 0
    const response = await fetchSafeOutbound(`http://model.local:${port}/stream`, {}, {
      allowLocal: true,
      lookup: async (hostname) => {
        lookupCalls += 1
        assert.equal(hostname, 'model.local')
        return lookupResult('127.0.0.1')
      },
    })
    assert.equal(await response.text(), 'first-second')
    assert.equal(lookupCalls, 1)
  })
})

test('same-origin redirects are revalidated and DNS rebinding is denied before a second fetch', async () => {
  let lookupCalls = 0
  let fetchCalls = 0
  await assert.rejects(
    fetchSafeOutbound('https://models.example/v1', {}, {
      lookup: async () => {
        lookupCalls += 1
        return lookupCalls === 1
          ? lookupResult('93.184.216.34')
          : lookupResult('169.254.169.254')
      },
      dispatcherFactory: () => ({ close: async () => {} }),
      fetchImpl: async () => {
        fetchCalls += 1
        return new Response(null, { status: 302, headers: { location: '/internal' } })
      },
    }),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
  assert.equal(lookupCalls, 2)
  assert.equal(fetchCalls, 1)
})

test('cross-origin redirects and HTTPS downgrades are rejected explicitly', async () => {
  const options = {
    lookup: async () => lookupResult('93.184.216.34'),
    dispatcherFactory: () => ({ close: async () => {} }),
  }
  await assert.rejects(
    fetchSafeOutbound('https://models.example/v1', {}, {
      ...options,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'https://other.example/v1' },
      }),
    }),
    (error) => error?.code === 'OUTBOUND_REDIRECT_CROSS_ORIGIN',
  )
  await assert.rejects(
    fetchSafeOutbound('https://models.example/v1', {}, {
      ...options,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'http://models.example/v1' },
      }),
    }),
    (error) => error?.code === 'OUTBOUND_REDIRECT_DOWNGRADE',
  )
})
