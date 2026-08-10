import assert from 'node:assert/strict'
import test from 'node:test'
import WebSocket from 'ws'
import { _browserInternals } from '../server/adapters/browserAutomation.js'
import { userCancellationError } from '../server/utils/toolCancellation.js'

const { CdpClient, abortableDelay } = _browserInternals

test('browser delays stop promptly on explicit user cancellation', async () => {
  const controller = new AbortController()
  const waiting = abortableDelay(10_000, controller.signal)
  controller.abort(userCancellationError('TURN_CANCEL_REQUESTED'))
  await assert.rejects(waiting, (error) => error?.code === 'TURN_CANCEL_REQUESTED')
})

test('aborting a CDP request rejects it and removes the pending command', async () => {
  const client = new CdpClient('ws://browser.test')
  client.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  }
  const controller = new AbortController()
  const request = client.request(
    'Runtime.evaluate',
    { expression: 'while (true) {}' },
    null,
    10_000,
    controller.signal,
  )
  assert.equal(client.pending.size, 1)

  controller.abort(userCancellationError('TURN_CANCEL_REQUESTED'))
  await assert.rejects(request, (error) => error?.code === 'TURN_CANCEL_REQUESTED')
  assert.equal(client.pending.size, 0)
})
