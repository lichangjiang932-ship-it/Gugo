import assert from 'node:assert/strict'
import test from 'node:test'

import { createJobBudget, runWithModelBudget } from '../server/utils/jobBudget.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function response(content = 'response') {
  return { content, usage: { promptTokens: 5, completionTokens: 2 }, costUsd: 0.125 }
}

function restoreBudget(saved, now) {
  return createJobBudget({
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
    now,
  })
}

test('parallel model requests subtract their shared wait once and retain the wall-clock limit', async () => {
  let clock = 0
  const budget = createJobBudget({ maxWallMs: 500, now: () => clock })
  const firstGate = deferred()
  const secondGate = deferred()
  const first = runWithModelBudget(budget, () => firstGate.promise)
  const second = runWithModelBudget(budget, () => secondGate.promise)

  clock = 1_000
  assert.equal(budget.snapshot().modelMs, 1_000)
  assert.equal(budget.consume(0).elapsed, 0, 'in-flight model waits do not consume work time')
  firstGate.resolve(response('first'))
  secondGate.resolve(response('second'))
  assert.deepEqual(await Promise.all([first, second]), [response('first'), response('second')])

  clock = 2_001
  const saved = budget.snapshot()
  assert.equal(saved.modelMs, 1_000)
  assert.equal(saved.elapsed, 1_001)
  assert.equal(saved.modelCalls, 2)
  assert.equal(saved.modelTokens, 14)
  assert.equal(saved.costUsd, 0.25)
  const exceeded = budget.consume(1)
  assert.equal(exceeded.ok, false)
  assert.match(exceeded.reason, /wall-clock budget exceeded/)
})

test('staggered waits merge transitively regardless of completion order and preserve gaps', async () => {
  let clock = 0
  const budget = createJobBudget({ now: () => clock })
  const gates = [deferred(), deferred(), deferred()]
  clock = 10
  const first = runWithModelBudget(budget, () => gates[0].promise)
  clock = 30
  const second = runWithModelBudget(budget, () => gates[1].promise)
  clock = 50
  const third = runWithModelBudget(budget, () => gates[2].promise)
  clock = 70
  gates[1].resolve(response())
  await second
  assert.equal(budget.snapshot().modelMs, 60)
  clock = 100
  gates[0].resolve(response())
  await first
  assert.equal(budget.snapshot().modelMs, 90)
  clock = 130
  gates[2].resolve(response())
  await third
  assert.equal(budget.snapshot().modelMs, 120)

  clock = 160
  await runWithModelBudget(budget, async () => {
    clock = 200
    return response()
  })
  clock = 250
  assert.equal(budget.snapshot().modelMs, 160)
  assert.equal(budget.snapshot().elapsed, 90)
  assert.equal(budget.snapshot().modelCalls, 4)
  assert.equal(budget.snapshot().modelTokens, 28)
  assert.equal(budget.snapshot().costUsd, 0.5)
})

test('serial model waits preserve work time, usage, and explicit over-budget wrap-up', async () => {
  let clock = 0
  const budget = createJobBudget({ maxModelCalls: 1, maxModelTokens: 7, now: () => clock })
  clock = 10
  await runWithModelBudget(budget, async () => {
    clock = 50
    return response('work')
  })
  clock = 60
  await assert.rejects(
    runWithModelBudget(budget, () => assert.fail('rejected calls must not reach the Provider')),
    (error) => error.code === 'MODEL_BUDGET_EXCEEDED',
  )
  assert.equal(budget.snapshot().modelMs, 40)
  assert.equal(budget.snapshot().elapsed, 20)
  const result = await runWithModelBudget(budget, async () => {
    clock = 90
    return response('wrap-up')
  }, { allowOverBudget: true })
  clock = 100
  assert.equal(result.content, 'wrap-up')
  assert.equal(budget.snapshot().modelMs, 70)
  assert.equal(budget.snapshot().elapsed, 30)
  assert.equal(budget.snapshot().modelCalls, 2)
  assert.equal(budget.snapshot().modelTokens, 14)
  assert.equal(budget.snapshot().costUsd, 0.25)
})

test('model wait cleanup is idempotent and never closes another active request', () => {
  let clock = 0
  const budget = createJobBudget({ now: () => clock })
  clock = 20
  const endFirst = budget.beginModelWait()
  clock = 40
  const endSecond = budget.beginModelWait()
  clock = 70
  endSecond()
  endSecond()
  assert.equal(budget.snapshot().modelMs, 50)
  clock = 90
  endFirst()
  endFirst()
  clock = 100
  assert.equal(budget.snapshot().modelMs, 70)
  assert.equal(budget.snapshot().elapsed, 30)
})

test('synchronous failure and cancellation close their waits without changing another request', async () => {
  let clock = 0
  const budget = createJobBudget({ maxWallMs: 15, now: () => clock })
  const successfulGate = deferred()
  clock = 10
  const successful = runWithModelBudget(budget, () => successfulGate.promise)
  const failure = new Error('Provider failed synchronously')
  clock = 20
  await assert.rejects(runWithModelBudget(budget, () => {
    clock = 30
    throw failure
  }), (error) => error === failure)

  const controller = new AbortController()
  const abortError = Object.assign(new Error('Provider cancelled'), { name: 'AbortError' })
  clock = 40
  const aborted = runWithModelBudget(budget, () => new Promise((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
  }))
  const abortObserved = assert.rejects(aborted, (error) => error === abortError)
  clock = 60
  controller.abort(abortError)
  await abortObserved
  assert.equal(budget.snapshot().modelMs, 50)
  assert.equal(budget.snapshot().elapsed, 10)

  clock = 80
  successfulGate.resolve(response())
  await successful
  clock = 90
  assert.equal(budget.snapshot().modelMs, 70)
  assert.equal(budget.snapshot().elapsed, 20)
  assert.equal(budget.snapshot().modelCalls, 3)
  assert.equal(budget.snapshot().modelTokens, 7)
  assert.equal(budget.snapshot().costUsd, 0.125)
  assert.equal(budget.consume(1).ok, false, 'failed/aborted requests must not leave a live wait')
})

test('in-flight snapshots restore the wait union without reviving old active requests', async () => {
  let clock = 1_000
  const budget = createJobBudget({ now: () => clock })
  budget.consume(2)
  const gates = [deferred(), deferred()]
  clock = 1_050
  const first = runWithModelBudget(budget, () => gates[0].promise)
  clock = 1_150
  const second = runWithModelBudget(budget, () => gates[1].promise)
  clock = 1_200
  const saved = budget.snapshot()
  assert.equal(saved.modelMs, 150)
  assert.equal(saved.elapsed, 50)

  let restoredClock = 10_000
  const restored = restoreBudget(saved, () => restoredClock)
  assert.deepEqual(restored.snapshot(), saved)
  restoredClock = 10_100
  assert.equal(restored.snapshot().modelMs, 150)
  assert.equal(restored.snapshot().elapsed, 150, 'old requests must not keep the new clock paused')
  await runWithModelBudget(restored, async () => {
    restoredClock = 10_250
    return response('new process')
  })
  assert.equal(restored.snapshot().modelMs, 300)
  assert.equal(restored.snapshot().elapsed, 150)
  assert.equal(restored.snapshot().modelCalls, 3)
  assert.equal(restored.snapshot().modelTokens, 7)
  assert.equal(restored.snapshot().costUsd, 0.125)

  gates[0].resolve(response())
  gates[1].resolve(response())
  await Promise.all([first, second])
  assert.equal(budget.snapshot().modelMs, 150, 'completion must not recount waits already in snapshots')
  assert.equal(restored.snapshot().modelMs, 300, 'old cleanup cannot change a restored budget')
})

test('custom budgets without a paired clock retain duration accounting on success and failure', async () => {
  let clock = 100
  const durations = []
  const usages = []
  let calls = 0
  const budget = {
    consumeModelCall() { calls += 1; return { ok: true } },
    trackModelMs: (duration) => durations.push(duration),
    trackModelUsage: (usage, costUsd) => usages.push({ usage, costUsd }),
  }
  const result = await runWithModelBudget(budget, () => {
    clock += 55
    return response()
  }, { now: () => clock })
  const failure = new Error('legacy budget failure')
  await assert.rejects(runWithModelBudget(budget, () => {
    clock += 15
    throw failure
  }, { now: () => clock }), (error) => error === failure)
  assert.deepEqual(result, response())
  assert.deepEqual(durations, [55, 15])
  assert.deepEqual(usages, [{ usage: response().usage, costUsd: 0.125 }])
  assert.equal(calls, 2)
})
