import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import net from 'node:net'
import * as guard from '../scripts/file-delivery-verification/offlineHttpGuard.mjs'

test('the production offline transport plugin rejects WebSocket subscription/approval upgrades before any consumer', async context => {
  assert.equal(typeof guard.offlineVerificationTransportPlugin, 'function')
  let handler
  const server = http.createServer((req, res) => handler(req, res, () => res.end('read-only')))
  const plugin = guard.offlineVerificationTransportPlugin()
  plugin.configureServer({ httpServer: server, middlewares: { use(value) { handler = value } } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise(resolve => server.close(resolve)))
  // RFC 6455's example nonce, assembled here so the fixture's wire bytes still
  // exercise the upgrade path without persisting a token-shaped literal.
  const websocketNonce = Buffer.from('the sample nonce').toString('base64')
  for (const path of ['/api/turns/ws', '/api/approvals/ws', '/api/health']) {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1')
      let text = ''
      socket.on('error', reject)
      socket.on('data', value => { text += value })
      socket.on('close', () => resolve(text))
      socket.on('connect', () => socket.write('GET '+path+' HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '+websocketNonce+'\r\n\r\n'))
    })
    assert.equal(response.startsWith('HTTP/1.1 403'), true)
  }
  const reply = await fetch('http://127.0.0.1:'+server.address().port+'/api/health').then(r => r.text())
  assert.equal(reply, 'read-only')
})
