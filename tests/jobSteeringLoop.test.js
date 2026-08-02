import assert from 'node:assert/strict'
import test from 'node:test'

import { runToolsLoop } from '../server/services/jobTools.js'

test('steering is injected verbatim at an iteration boundary and acknowledged', async () => {
  const seen = []
  const acknowledged = []
  const result = await runToolsLoop({
    job: { id: 'job-steer-loop', userId: 'user-steer-loop', title: 'steer' },
    step: { id: 'step-steer-loop', kind: 'execute' },
    messages: [{ role: 'user', content: 'original direction' }],
    runModel: async ({ messages }) => {
      seen.push(...messages)
      return { content: 'redirected', toolCalls: [] }
    },
    claimSteering: async () => ({
      leaseId: 'lease-1',
      messages: [{ content: '改成 CSV，不要 PDF。' }],
    }),
    acknowledgeSteering: async (leaseId) => acknowledged.push(leaseId),
    maxIters: 1,
  })
  assert.equal(result.text, 'redirected')
  assert.ok(seen.some((message) => message.role === 'user' && message.content === '改成 CSV，不要 PDF。'))
  assert.deepEqual(acknowledged, ['lease-1'])
})

test('steering lease is released when the model request fails', async () => {
  const released = []
  await assert.rejects(() => runToolsLoop({
    job: { id: 'job-steer-fail', userId: 'user-steer-loop', title: 'steer fail' },
    step: { id: 'step-steer-fail', kind: 'execute' },
    messages: [{ role: 'user', content: 'original' }],
    runModel: async () => { throw new Error('upstream unavailable') },
    claimSteering: async () => ({ leaseId: 'lease-fail', messages: [{ content: 'keep me' }] }),
    releaseSteering: async (leaseId) => released.push(leaseId),
    maxIters: 1,
  }), /upstream unavailable/)
  assert.deepEqual(released, ['lease-fail'])
})
