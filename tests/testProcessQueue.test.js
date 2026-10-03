import assert from 'node:assert/strict'
import test from 'node:test'
import { runTestProcessQueue } from '../scripts/testProcessQueue.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('process queue runs every test once, bounded by the configured concurrency', async () => {
  let active = 0
  let maximum = 0
  const seen = []
  const results = await runTestProcessQueue([1, 2, 3, 4], {
    concurrency: 2,
    async run(item) {
      active += 1
      maximum = Math.max(maximum, active)
      seen.push(item)
      await delay(item === 1 ? 15 : 5)
      active -= 1
      return item * 10
    },
  })
  assert.equal(maximum, 2)
  assert.deepEqual(seen, [1, 2, 3, 4])
  assert.deepEqual(results, [10, 20, 30, 40])
  assert.equal(active, 0)
})

test('exclusive transforms and heavy UI tests never overlap another process', async () => {
  const active = new Set()
  const seen = []
  await runTestProcessQueue(['a', 'b', 'heavy', 'native', 'c', 'd'], {
    concurrency: 2,
    isExclusive: (item) => ['heavy', 'native'].includes(item),
    async run(item) {
      if (['heavy', 'native'].includes(item)) assert.equal(active.size, 0)
      assert.equal(active.has('heavy') || active.has('native'), false)
      active.add(item)
      seen.push(item)
      await delay(3)
      active.delete(item)
    },
  })
  assert.deepEqual(seen, ['a', 'b', 'heavy', 'native', 'c', 'd'])
})

test('serial mode and empty selections preserve deterministic execution', async () => {
  let active = false
  const run = async (item) => {
    assert.equal(active, false)
    active = true
    await delay(1)
    active = false
    return item
  }
  assert.deepEqual(await runTestProcessQueue([1, 2], { concurrency: 1, run }), [1, 2])
  assert.deepEqual(await runTestProcessQueue([], { concurrency: 2, run }), [])
})

test('unexpected runner failures drain active work before rejecting and stop new dispatch', async () => {
  let settled = false
  const seen = []
  await assert.rejects(runTestProcessQueue([1, 2, 3], {
    concurrency: 2,
    async run(item) {
      seen.push(item)
      if (item === 1) throw new Error('runner failure')
      await delay(10)
      settled = true
    },
  }), /runner failure/)
  assert.equal(settled, true)
  assert.deepEqual(seen, [1, 2])
})

test('invalid concurrency fails before dispatch', async () => {
  for (const concurrency of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(runTestProcessQueue([1], { concurrency, run: () => assert.fail('unexpected dispatch') }), /positive integer/)
  }
})
