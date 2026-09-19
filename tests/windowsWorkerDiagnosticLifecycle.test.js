import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { observeDiagnosticWorker } from '../scripts/diagnostics/windows-worker-lifecycle.js'

test('diagnostic cleanup waits for close, not a spawn error or exit alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = new EventEmitter()
  child.on('error', () => {})
  const observer = observeDiagnosticWorker(child, { now: () => 100 })
  let settled = false
  const pending = observer.waitForClose(5_000).then((value) => { settled = true; return value })
  child.emit('error', new Error('sensitive raw host error'))
  child.emit('exit', 1)
  await Promise.resolve()
  assert.equal(settled, false)
  t.mock.timers.tick(5_000)
  assert.equal(await pending, false)
  assert.equal(observer.snapshot().closedMs, null)
  assert.doesNotMatch(JSON.stringify(observer.snapshot()), /sensitive|error/u)
})

test('diagnostic close is observed before or after waiting and clears its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const child = new EventEmitter()
  let clock = 100
  const observer = observeDiagnosticWorker(child, { now: () => clock })
  child.emit('spawn')
  clock = 150
  child.emit('exit', 0)
  child.emit('close', 0)
  assert.equal(await observer.waitForClose(5_000), true)
  t.mock.timers.tick(5_000)
  assert.equal(await observer.waitForClose(5_000), true)
  assert.deepEqual(observer.snapshot(), { spawnedMs: 0, payloadWriteAcknowledgedMs: null, exitedMs: 50, closedMs: 50 })
})

test('diagnostic payload acknowledgement preserves write result and original callback', async () => {
  const child = new EventEmitter()
  let sent
  child.stdin = { write(chunk, callback) { sent = chunk; callback(null); return false } }
  const observer = observeDiagnosticWorker(child, { now: () => 0 })
  let acknowledged = 0
  assert.equal(child.stdin.write('private-payload', (error) => { assert.equal(error, null); acknowledged += 1 }), false)
  assert.equal(sent, 'private-payload')
  assert.equal(acknowledged, 1)
  assert.equal(observer.snapshot().payloadWriteAcknowledgedMs, 0)
  assert.doesNotMatch(JSON.stringify(observer.snapshot()), /private-payload/u)
  child.emit('close', 0)
  assert.equal(await observer.waitForClose(), true)
})
