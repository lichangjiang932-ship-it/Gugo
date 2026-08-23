import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'

import { _browserInternals } from '../server/adapters/browserAutomation.js'
import { startBrowserOutboundProxy } from '../server/adapters/browserOutboundProxy.js'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve))
}

function requestThroughProxy(proxyUrl, targetUrl) {
  const proxy = new URL(proxyUrl)
  const target = new URL(targetUrl)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: proxy.hostname,
      port: proxy.port,
      method: 'GET',
      path: targetUrl,
      headers: { host: target.host },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

test('browser outbound proxy blocks loopback HTTP before the upstream receives a request', async () => {
  let upstreamHits = 0
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1
    res.end('private')
  })
  const port = await listen(upstream)
  const proxy = await startBrowserOutboundProxy()
  try {
    const response = await requestThroughProxy(proxy.url, `http://127.0.0.1:${port}/admin`)
    assert.equal(response.status, 403)
    assert.match(response.body, /OUTBOUND_ADDRESS_DENIED/)
    assert.equal(upstreamHits, 0)
  } finally {
    await proxy.close()
    await closeServer(upstream)
  }
})

test('browser outbound proxy pins the single approved DNS result used by the HTTP connection', async () => {
  let lookupCalls = 0
  let observedHost = ''
  const upstream = http.createServer((req, res) => {
    observedHost = req.headers.host || ''
    res.end('public-through-pinned-address')
  })
  const port = await listen(upstream)
  const proxy = await startBrowserOutboundProxy({
    allowLocal: true,
    lookup: async (hostname) => {
      lookupCalls += 1
      assert.equal(hostname, 'browser.test')
      return [{ address: '127.0.0.1', family: 4 }]
    },
  })
  try {
    const response = await requestThroughProxy(proxy.url, `http://browser.test:${port}/page`)
    assert.equal(response.status, 200)
    assert.equal(response.body, 'public-through-pinned-address')
    assert.equal(observedHost, `browser.test:${port}`)
    assert.equal(lookupCalls, 1)
  } finally {
    await proxy.close()
    await closeServer(upstream)
  }
})

test('browser outbound proxy rejects private CONNECT targets before opening the tunnel', async () => {
  let connections = 0
  const upstream = net.createServer((socket) => {
    connections += 1
    socket.end()
  })
  const port = await listen(upstream)
  const proxy = await startBrowserOutboundProxy()
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1')
      let received = ''
      socket.setEncoding('utf8')
      socket.once('connect', () => {
        socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
      })
      socket.on('data', (chunk) => { received += chunk })
      socket.once('end', () => resolve(received))
      socket.once('error', reject)
    })
    assert.match(response, /^HTTP\/1\.1 403 Forbidden/)
    assert.equal(connections, 0)
  } finally {
    await proxy.close()
    await closeServer(upstream)
  }
})

test('Chrome launch arguments force browser traffic through the guarded proxy', () => {
  const args = _browserInternals.browserLaunchArgs('C:\\profiles\\browser-user', {
    proxyUrl: 'http://127.0.0.1:54321',
  })
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:54321'))
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'))
  assert.ok(args.includes('--disable-quic'))
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'))
})
