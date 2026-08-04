import test from 'node:test'
import assert from 'node:assert/strict'
import { createJobBudget, runWithModelBudget } from '../server/utils/jobBudget.js'

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
  let clock = 1_000
  const first = createJobBudget({
    maxModelCalls: 3,
    maxModelTokens: 120,
    maxCostUsd: 0.25,
    now: () => clock,
  })
  first.consumeModelCall()
  first.trackModelUsage({ promptTokens: 50, completionTokens: 30 }, 0.1)
  clock += 100
  first.trackModelMs(40)
  const saved = first.snapshot()

  clock = 5_000
  const restored = createJobBudget({
    maxTotalCalls: saved.maxTotalCalls,
    maxWallMs: saved.maxWallMs,
    maxModelCalls: saved.maxModelCalls,
    maxModelTokens: saved.maxModelTokens,
    maxCostUsd: saved.maxCostUsd,
    initialUsed: saved.used,
    initialElapsedMs: saved.elapsed,
    initialModelMs: saved.modelMs,
    initialModelCalls: saved.modelCalls,
    initialModelTokens: saved.modelTokens,
    initialCostUsd: saved.costUsd,
    now: () => clock,
  })
  assert.deepEqual(restored.snapshot(), saved)
  assert.equal(restored.trackModelUsage({ promptTokens: 20, completionTokens: 21 }, 0.01).ok, false)
})

test('real provider requests are counted individually and rejected attempts do not inflate usage', async () => {
  const budget = createJobBudget({
    maxModelCalls: 1,
    maxModelTokens: 100,
    maxCostUsd: 1,
  })
  let providerCalls = 0
  const result = await runWithModelBudget(budget, async () => {
    providerCalls += 1
    return {
      content: 'first',
      usage: { promptTokens: 20, completionTokens: 10 },
      costUsd: 0.02,
    }
  })
  assert.equal(result.content, 'first')
  await assert.rejects(
    runWithModelBudget(budget, async () => {
      providerCalls += 1
      return { content: 'must not run' }
    }),
    (error) => error.code === 'MODEL_BUDGET_EXCEEDED',
  )
  assert.equal(providerCalls, 1)
  assert.deepEqual(
    { ...budget.snapshot(), elapsed: 0, modelMs: 0 },
    {
      used: 0,
      maxTotalCalls: budget.snapshot().maxTotalCalls,
      elapsed: 0,
      maxWallMs: budget.snapshot().maxWallMs,
      modelMs: 0,
      modelCalls: 1,
      maxModelCalls: 1,
      modelTokens: 30,
      maxModelTokens: 100,
      costUsd: 0.02,
      maxCostUsd: 1,
    },
  )
})

test('an explicit wrap-up request is still measured after the hard cap', async () => {
  const budget = createJobBudget({ maxModelCalls: 1, maxModelTokens: 10, maxCostUsd: 0.01 })
  await runWithModelBudget(budget, async () => ({
    content: 'work',
    usage: { promptTokens: 6, completionTokens: 4 },
    costUsd: 0.01,
  }))
  const wrapUp = await runWithModelBudget(budget, async () => ({
    content: 'summary',
    usage: { promptTokens: 3, completionTokens: 2 },
    costUsd: 0.005,
  }), { allowOverBudget: true })
  assert.equal(wrapUp.content, 'summary')
  assert.equal(budget.snapshot().modelCalls, 2)
  assert.equal(budget.snapshot().modelTokens, 15)
  assert.equal(budget.snapshot().costUsd, 0.015)
})
