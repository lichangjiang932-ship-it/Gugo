import assert from 'node:assert/strict'
import test from 'node:test'
import { createScrollPinning, scrollEdges } from '../src/lib/scrollPinning.js'
test('upward intent releases the pin before scroll arrives and does not repin just because cooldown expires', () => {
  let time = 1000
  const pin = createScrollPinning(() => time)
  pin.observe({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })
  assert.equal(pin.shouldPin(), true)
  pin.input(-1); assert.equal(pin.shouldPin(), false)
  time += 500
  pin.observe({ scrollTop: 580, scrollHeight: 1000, clientHeight: 400 })
  assert.equal(pin.shouldPin(), false)
  pin.input(1); time += 151
  pin.observe({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })
  assert.equal(pin.shouldPin(), true)
})
test('jump explicitly restores pin; jump visibility and pin tolerance are distinct', () => {
  const pin = createScrollPinning(() => 1000)
  assert.equal(pin.observe({ scrollTop: 470, scrollHeight: 1000, clientHeight: 400 }).showJump, true)
  assert.equal(pin.observe({ scrollTop: 520, scrollHeight: 1000, clientHeight: 400 }).showJump, false)
  assert.equal(pin.shouldPin(), false)
  pin.jump(); assert.equal(pin.shouldPin(), true)
})
test('edge sensing clamps overscroll and never fades short content or reached boundaries', () => {
  assert.deepEqual(scrollEdges({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 }), { top: 0, bottom: 0 })
  assert.deepEqual(scrollEdges({ scrollTop: -4, scrollHeight: 1000, clientHeight: 400 }), { top: 0, bottom: 28 })
  assert.deepEqual(scrollEdges({ scrollTop: 598, scrollHeight: 1000, clientHeight: 400 }), { top: 28, bottom: 0 })
})
