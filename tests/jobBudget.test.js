import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachJobBudget,
  createJobBudget,
  getJobBudget,
  recordRecoveredModelResult,
  releaseJobBudget,
  resolveJobBudgetDefaults,
  runWithModelBudget,
} from '../server/utils/jobBudget.js'

test('shared budgets are isolated by origin, user, and id', () => {
  const sharedId = `scoped-budget-${Date.now()}`
  const aliceJob = { id: sharedId, userId: 'budget-alice', origin: 'job' }
  const bobJob = { id: sharedId, userId: 'budget-bob', origin: 'job' }
  const aliceTurn = { id: sharedId, userId: 'budget-alice', origin: 'chat' }
  let aliceBudget
  let bobBudget
  let turnBudget

  try {
    aliceBudget = attachJobBudget(aliceJob, { initialModelCalls: 1 })
    bobBudget = attachJobBudget(bobJob, { initialModelCalls: 7 })
    turnBudget = attachJobBudget(aliceTurn, { initialModelCalls: 11 })

    assert.notEqual(aliceBudget, bobBudget)
    assert.notEqual(aliceBudget, turnBudget)
    assert.equal(getJobBudget(aliceJob)?.snapshot().modelCalls, 1)
    assert.equal(getJobBudget(bobJob)?.snapshot().modelCalls, 7)
    assert.equal(getJobBudget(aliceTurn)?.snapshot().modelCalls, 11)

    assert.equal(releaseJobBudget(aliceJob, aliceBudget), true)
    assert.equal(getJobBudget(aliceJob), null)
    assert.equal(getJobBudget(bobJob), bobBudget)
    assert.equal(getJobBudget(aliceTurn), turnBudget)
  } finally {
    releaseJobBudget(aliceJob, aliceBudget)
    releaseJobBudget(bobJob, bobBudget)
    releaseJobBudget(aliceTurn, turnBudget)
  }
})

test('a stale cleanup cannot delete a newer budget in the same scope', () => {
  const job = { id: `budget-generation-${Date.now()}`, userId: 'budget-owner', origin: 'job' }
  const first = attachJobBudget(job, { initialModelCalls: 1 })
  assert.equal(releaseJobBudget(job, first), true)
  const second = attachJobBudget(job, { initialModelCalls: 2 })
  try {
    assert.notEqual(second, first)
    assert.equal(releaseJobBudget(job, first), false)
    assert.equal(getJobBudget(job), second)
    assert.equal(second.snapshot().modelCalls, 2)
  } finally {
    releaseJobBudget(job, second)
  }
})

test('default workload guardrails allow long tasks without a 100-call cutoff', () => {
  assert.deepEqual(resolveJobBudgetDefaults({}), {
    maxTotalCalls: 2000,
    maxWallMs: 6 * 60 * 60 * 1000,
    maxModelCalls: 2000,
    maxModelTokens: 0,
  })
})

test('retired dollar gates are rejected instead of silently changing BYOK execution', () => {
  for (const maxCostUsd of [0, 0.01, 100]) {
    assert.throws(
      () => createJobBudget({ maxCostUsd }),
      (error) => error?.code === 'JOB_BUDGET_DOLLAR_GATE_RETIRED'
        && error?.statusCode === 400,
    )
  }
})

test('model token budget stops the job after real usage crosses the hard cap', () => {
  const budget = createJobBudget({
    maxModelCalls: 10,
    maxModelTokens: 100,
  })

  assert.equal(budget.consumeModelCall().ok, true)
  assert.equal(budget.trackModelUsage({ promptTokens: 40, completionTokens: 50 }, 0.1).ok, true)
  const exceeded = budget.trackModelUsage({ promptTokens: 8, completionTokens: 3 }, 0.01)
  assert.equal(exceeded.ok, false)
  assert.match(exceeded.reason, /model token budget exceeded/)
  assert.equal(exceeded.budgetLimitType, 'model_tokens')
  assert.equal(budget.consumeModelCall().ok, false, 'no further model call may start')
})

test('cached prompt tokens are not charged repeatedly against the model token budget', () => {
  const budget = createJobBudget({
    maxModelCalls: 10,
    maxModelTokens: 100,
  })

  assert.equal(budget.consumeModelCall().ok, true)
  const status = budget.trackModelUsage({
    promptTokens: 90,
    completionTokens: 20,
    cacheHitTokens: 80,
    cacheMissTokens: 10,
  }, 0.01)

  assert.equal(status.ok, true)
  assert.equal(budget.snapshot().modelTokens, 30)
})

test('Provider cost estimates remain telemetry and never stop BYOK model calls', async () => {
  const budget = createJobBudget({
    maxModelCalls: 10,
    maxModelTokens: 10_000,
  })

  assert.equal(budget.trackModelUsage({ promptTokens: 10, completionTokens: 10 }, 0.04).ok, true)
  assert.equal(budget.trackModelUsage({ promptTokens: 10, completionTokens: 10 }, 0.02).ok, true)
  assert.equal(budget.snapshot().costUsd, 0.06)
  assert.equal(budget.snapshot().maxCostUsd, 0)
  assert.equal(budget.trackModelUsage(
    { promptTokens: 10, completionTokens: 10 },
    null,
  ).ok, true)
  assert.equal(budget.snapshot().costEvidenceComplete, false)
  const response = await runWithModelBudget(budget, async () => ({
    content: 'authoritative response with unknown cost',
    usage: { promptTokens: 10, completionTokens: 10 },
  }))
  assert.equal(response.content, 'authoritative response with unknown cost')
})

test('legacy model history without a cost evidence marker remains unknown after restore', () => {
  const legacySnapshot = {
    modelCalls: 2,
    modelTokens: 120,
    costUsd: 0,
  }
  const restoredWithoutLimit = createJobBudget({
    initialModelCalls: legacySnapshot.modelCalls,
    initialModelTokens: legacySnapshot.modelTokens,
    initialCostUsd: legacySnapshot.costUsd,
  })
  assert.deepEqual(
    {
      costUsd: restoredWithoutLimit.snapshot().costUsd,
      costEvidenceComplete: restoredWithoutLimit.snapshot().costEvidenceComplete,
    },
    { costUsd: null, costEvidenceComplete: false },
  )

  const restoredWithLimit = createJobBudget({
    initialModelCalls: legacySnapshot.modelCalls,
    initialModelTokens: legacySnapshot.modelTokens,
    initialCostUsd: legacySnapshot.costUsd,
  })
  assert.equal(restoredWithLimit.consumeModelCall().ok, true)
  assert.equal(restoredWithLimit.snapshot().modelCalls, legacySnapshot.modelCalls + 1)
  assert.equal(restoredWithLimit.snapshot().maxCostUsd, 0)
})

test('checkpoint restore preserves explicit measured zero and rejects contradictory evidence', () => {
  const measuredZero = createJobBudget({
    initialModelCalls: 1,
    initialModelTokens: 10,
    initialCostUsd: 0,
    initialCostEvidenceComplete: true,
  })
  assert.equal(measuredZero.consumeModelCall().ok, true)
  assert.equal(measuredZero.snapshot().costUsd, 0)
  assert.equal(measuredZero.snapshot().costEvidenceComplete, true)

  const contradictory = createJobBudget({
    initialModelCalls: 1,
    initialModelTokens: 10,
    initialCostUsd: null,
    initialCostEvidenceComplete: true,
  })
  assert.equal(contradictory.consumeModelCall().ok, true)
  assert.equal(contradictory.snapshot().costUsd, null)
  assert.equal(contradictory.snapshot().costEvidenceComplete, false)
})

test('checkpoint restoration preserves all model budget counters and limits', () => {
  let clock = 1_000
  const first = createJobBudget({
    maxModelCalls: 3,
    maxModelTokens: 120,
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
    initialUsed: saved.used,
    initialElapsedMs: saved.elapsed,
    initialModelMs: saved.modelMs,
    initialModelCalls: saved.modelCalls,
    initialModelTokens: saved.modelTokens,
    initialCostUsd: saved.costUsd,
    initialCostEvidenceComplete: saved.costEvidenceComplete,
    now: () => clock,
  })
  assert.deepEqual(restored.snapshot(), saved)
  assert.equal(restored.trackModelUsage({ promptTokens: 20, completionTokens: 21 }, 0.01).ok, false)
})

test('real provider requests are counted individually and rejected attempts do not inflate usage', async () => {
  const budget = createJobBudget({
    maxModelCalls: 1,
    maxModelTokens: 100,
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
      costEvidenceComplete: true,
      maxCostUsd: 0,
    },
  )
})

test('an explicit wrap-up may exceed call and token limits while Provider cost remains available', async () => {
  const budget = createJobBudget({ maxModelCalls: 1, maxModelTokens: 10 })
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

test('Provider cost telemetry cannot block normal or wrap-up calls', async () => {
  const budget = createJobBudget({ maxModelCalls: 10, maxModelTokens: 100 })
  let providerCalls = 0

  const first = await runWithModelBudget(budget, async () => {
    providerCalls += 1
    return {
      content: 'authoritative response at the old threshold',
      usage: { promptTokens: 6, completionTokens: 4 },
      costUsd: 0.01,
    }
  })

  const wrapUp = await runWithModelBudget(budget, async () => {
    providerCalls += 1
    return {
      content: 'wrap-up still reaches the user configured Provider',
      usage: { promptTokens: 3, completionTokens: 2 },
      costUsd: 0.02,
    }
  }, { allowOverBudget: true })

  assert.equal(first.content, 'authoritative response at the old threshold')
  assert.equal(wrapUp.content, 'wrap-up still reaches the user configured Provider')
  assert.equal(providerCalls, 2)
  assert.equal(budget.snapshot().modelCalls, 2)
  assert.equal(budget.snapshot().costUsd, 0.03)
  assert.equal(budget.snapshot().maxCostUsd, 0)
})

test('a recovered response is fully accounted and retained when it crosses a budget limit', () => {
  const budget = createJobBudget({
    maxModelCalls: 10,
    maxModelTokens: 20,
  })
  const response = {
    content: 'authoritative recovered response',
    toolCalls: [],
    usage: { promptTokens: 30, cacheHitTokens: 5, completionTokens: 4 },
    costUsd: 0.03,
  }

  assert.throws(
    () => recordRecoveredModelResult(budget, response),
    (error) => error?.code === 'MODEL_BUDGET_EXCEEDED'
      && error?.partialModelResult === response,
  )
  assert.equal(budget.snapshot().modelCalls, 1)
  assert.equal(budget.snapshot().modelTokens, 29)
  assert.equal(budget.snapshot().costUsd, 0.03)
})
