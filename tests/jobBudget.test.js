import test from 'node:test'
import assert from 'node:assert/strict'
import { createJobBudget } from '../server/utils/jobBudget.js'

test('model token budget stops the job after real usage crosses the hard cap', () => {
  const budget = createJobBudget({
    maxModelCalls: 10,
    maxModelTokens: 100,
    maxCostUsd: 10,
  })

  assert.equal(budget.consumeModelCall().ok, true)
  assert.equal(budget.trackModelUsage({ promptTokens: 40, completionTokens: 50 }, 0.1).ok, true)
  const exceeded = budget.trackModelUsage({ promptTokens: 8, completionTokens: 3 }, 0.01)
  assert.equal(exceeded.ok, false)
  assert.match(exceeded.reason, /model token budget exceeded/)
  assert.equal(budget.consumeModelCall().ok, false, 'no further model call may start')
})

test('model dollar budget stops the job after reported provider cost crosses the cap', () => {
  const budget = createJobBudget({
    maxModelCalls: 10,
    maxModelTokens: 10_000,
    maxCostUsd: 0.05,
  })

  assert.equal(budget.trackModelUsage({ promptTokens: 10, completionTokens: 10 }, 0.04).ok, true)
  const exceeded = budget.trackModelUsage({ promptTokens: 10, completionTokens: 10 }, 0.02)
  assert.equal(exceeded.ok, false)
  assert.match(exceeded.reason, /model cost budget exceeded/)
  assert.equal(budget.snapshot().costUsd, 0.06)
})

test('checkpoint restoration preserves all model budget counters and limits', () => {
  const first = createJobBudget({
    maxModelCalls: 3,
    maxModelTokens: 120,
    maxCostUsd: 0.25,
  })
  first.consumeModelCall()
  first.trackModelUsage({ promptTokens: 50, completionTokens: 30 }, 0.1)
  const saved = first.snapshot()

  const restored = createJobBudget({
    maxModelCalls: saved.maxModelCalls,
    maxModelTokens: saved.maxModelTokens,
    maxCostUsd: saved.maxCostUsd,
    initialModelCalls: saved.modelCalls,
    initialModelTokens: saved.modelTokens,
    initialCostUsd: saved.costUsd,
  })
  assert.deepEqual(
    restored.snapshot(),
    { ...restored.snapshot(), modelCalls: 1, modelTokens: 80, costUsd: 0.1 },
  )
  assert.equal(restored.trackModelUsage({ promptTokens: 20, completionTokens: 21 }, 0.01).ok, false)
})
