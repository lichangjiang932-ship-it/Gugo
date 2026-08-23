import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'

import {
  drainHttpServer,
  installHttpServerDrain,
  isHttpServerDraining,
} from '../server/core/httpServerDrain.js'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

test('HTTP drain ends SSE and WebSocket connections before resolving', async () => {
  let sseClosed = false
  const server = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  const controller = installHttpServerDrain(server, { webSocketServer: wss, forceAfterMs: 500 })
  server.on('request', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
    res.write(': ready\n\n')
    req.once('close', () => { sseClosed = true })
  })
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request))
  })
  server.once('close', () => wss.close())

  const port = await listen(server)
  const request = http.get(`http://127.0.0.1:${port}/events`)
  const response = await once(request, 'response').then(([value]) => value)
  await once(response, 'data')
  response.resume()
  const client = new WebSocket(`ws://127.0.0.1:${port}/realtime`)
  await once(client, 'open')
  const clientClosed = once(client, 'close')

  const result = await drainHttpServer(server)
  await clientClosed

  assert.equal(result.forced, false)
  assert.equal(isHttpServerDraining(server), true)
  assert.equal(sseClosed, true)
  assert.equal(client.readyState, WebSocket.CLOSED)
  assert.equal(controller.sockets.size, 0)
})

test('HTTP drain force-closes a connection that ignores graceful completion', async () => {
  const server = http.createServer()
  const controller = installHttpServerDrain(server, { forceAfterMs: 20 })
  server.on('request', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.write('still working')
  })

  const port = await listen(server)
  const request = http.get(`http://127.0.0.1:${port}/slow`)
  const response = await once(request, 'response').then(([value]) => value)
  await once(response, 'data')
  response.resume()

  const firstDrain = drainHttpServer(server)
  const secondDrain = drainHttpServer(server)
  assert.strictEqual(secondDrain, firstDrain)
  const result = await firstDrain

  assert.equal(result.forced, true)
  assert.equal(controller.sockets.size, 0)
})
