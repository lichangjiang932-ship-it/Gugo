import assert from 'node:assert/strict'
import test from 'node:test'
import { browserOutputKey, observeBrowserOutput, readBrowserOutput } from '../src/lib/browserOutputTiming.js'
test('browser clocks are separate, monotonic, scoped and idempotent', () => {
  const message = { id: 'm', role: 'assistant', content: 'PRIVATE', meta: { modelTiming: { startedAt: 1000 } } }
  const key = browserOutputKey('owner1', 'session1', message)
  assert.doesNotMatch(key, /PRIVATE/)
  observeBrowserOutput(key, 'start', 10)
  observeBrowserOutput(key, 'start', 20)
  observeBrowserOutput(key, 'paint', 40)
  observeBrowserOutput(key, 'paint', 90)
  assert.equal(readBrowserOutput(key).paintOpportunityMs, 30)
  assert.equal(readBrowserOutput(browserOutputKey('owner2', 'session1', message)), null)
  assert.equal(browserOutputKey('owner1', 'session1', { ...message, meta: {} }), null)
})
