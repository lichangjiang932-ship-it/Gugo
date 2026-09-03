import assert from 'node:assert/strict'
import test from 'node:test'

import { createJobRuntimeLoopHost } from '../server/services/jobRuntimeLoopHost.js'

test('job runtime loop host tracks active ticks and coalesces shutdown', async () => {
  let releaseTick
  const host = createJobRuntimeLoopHost({
    runTick: () => new Promise((resolve) => { releaseTick = resolve }),
  })

  const tick = host.runOneTick()
  assert.equal(host.activeTicks.size, 1)

  const firstShutdown = host.shutdown()
  const secondShutdown = host.shutdown()
  assert.strictEqual(secondShutdown, firstShutdown)
  assert.equal(host.shutdownRequested, true)
  assert.equal(await host.runOneTick(), false)

  releaseTick(true)
  assert.equal(await tick, true)
  await firstShutdown
  assert.equal(host.activeTicks.size, 0)
  assert.equal(host.start(), false)
})

test('job runtime loop host drains until no work remains', async () => {
  const outcomes = [true, true, false]
  const host = createJobRuntimeLoopHost({
    runTick: async () => outcomes.shift(),
  })

  await host.drain()
  assert.deepEqual(outcomes, [])
  assert.equal(host.activeTicks.size, 0)
})

test('job runtime loop host preserves the bounded drain failure', async () => {
  const host = createJobRuntimeLoopHost({ runTick: async () => true })

  await assert.rejects(
    host.drain({ maxTicks: 2 }),
    /job runtime drain exceeded max ticks/u,
  )
  assert.equal(host.activeTicks.size, 0)
})
