import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closeEvolutionOnlineGraderRuntime,
  createEvolutionOnlineGraderRuntime,
  setEvolutionOnlineGraderRuntimeForTesting,
  startEvolutionOnlineGraderRuntime,
} from '../server/services/evolutionOnlineGraderRuntime.js'

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('production online grader runtime recovers backlog and deduplicates repeated starts and enqueues', async () => {
  const first = { userId: 'owner', promotionId: 'promotion-1', outcomeId: 'outcome-1' }
  const second = { userId: 'owner', promotionId: 'promotion-1', outcomeId: 'outcome-2' }
  const completed = new Set()
  let releaseGrades
  const gradeGate = new Promise((resolve) => { releaseGrades = resolve })
  let resolveBothEntered
  const bothEntered = new Promise((resolve) => { resolveBothEntered = resolve })
  let backlogCalls = 0
  const calls = []
  const runtime = createEvolutionOnlineGraderRuntime({
    concurrency: 2,
    listBacklog: () => {
      backlogCalls += 1
      return completed.has(first.outcomeId) ? [] : [first]
    },
    runGrade: async (task) => {
      calls.push(task.outcomeId)
      if (calls.length === 2) resolveBothEntered()
      await gradeGate
      completed.add(task.outcomeId)
    },
    onError: (error) => { throw error },
  })

  await Promise.all([runtime.start(), runtime.start()])
  assert.equal(runtime.enqueue(first), true)
  assert.equal(runtime.enqueue(first), true)
  assert.equal(runtime.enqueue(second), true)
  assert.equal(runtime.enqueue(second), true)
  await bothEntered
  releaseGrades()
  await runtime.close()

  assert.deepEqual(calls.sort(), ['outcome-1', 'outcome-2'])
  assert.ok(backlogCalls >= 1)
  assert.equal(runtime.enqueue({ ...second, outcomeId: 'outcome-3' }), false)
  assert.deepEqual(runtime.state(), {
    started: true,
    accepting: false,
    closing: true,
    pending: 0,
    active: 0,
    needsBackfill: false,
    concurrency: 2,
    queueLimit: 256,
  })
})

test('production online grader runtime shutdown waits for active work and rejects new work', async () => {
  let release
  const active = new Promise((resolve) => { release = resolve })
  let entered = false
  const runtime = createEvolutionOnlineGraderRuntime({
    concurrency: 1,
    listBacklog: () => [],
    runGrade: async () => {
      entered = true
      await active
    },
    onError: (error) => { throw error },
  })
  await runtime.start()
  assert.equal(runtime.enqueue({
    userId: 'owner',
    promotionId: 'promotion-2',
    outcomeId: 'outcome-active',
  }), true)
  await nextTurn()
  assert.equal(entered, true)

  let closed = false
  const closing = runtime.close().then(() => { closed = true })
  assert.equal(runtime.enqueue({
    userId: 'owner',
    promotionId: 'promotion-2',
    outcomeId: 'outcome-rejected',
  }), false)
  await nextTurn()
  assert.equal(closed, false)

  release()
  await closing
  assert.equal(closed, true)
})

test('production online grader runtime aborts active model work and never starts pending work', async () => {
  let resolveEntered
  const entered = new Promise((resolve) => { resolveEntered = resolve })
  const calls = []
  const errors = []
  let observedSignal = null
  const runtime = createEvolutionOnlineGraderRuntime({
    concurrency: 1,
    listBacklog: () => [],
    runGrade: ({ outcomeId, signal }) => new Promise((resolve, reject) => {
      calls.push(outcomeId)
      observedSignal = signal
      resolveEntered()
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
    onError: (error) => { errors.push(error) },
  })
  await runtime.start()
  assert.equal(runtime.enqueue({
    userId: 'owner', promotionId: 'promotion-abort', outcomeId: 'outcome-active',
  }), true)
  assert.equal(runtime.enqueue({
    userId: 'owner', promotionId: 'promotion-abort', outcomeId: 'outcome-pending',
  }), true)
  await entered

  const lifecycleSignal = new AbortController().signal
  await Promise.race([
    runtime.close({ signal: lifecycleSignal }),
    delay(1_000).then(() => { throw new Error('runtime close did not cancel active model work') }),
  ])

  assert.equal(observedSignal?.aborted, true)
  assert.deepEqual(calls, ['outcome-active'])
  assert.deepEqual(errors, [])
  assert.equal(runtime.state().pending, 0)
  assert.equal(runtime.state().active, 0)
})

test('singleton runtime cannot restart until an abort-ignoring active grade has actually stopped', async () => {
  let resolveEntered
  let releaseGrade
  const entered = new Promise((resolve) => { resolveEntered = resolve })
  const gradeGate = new Promise((resolve) => { releaseGrade = resolve })
  const runtime = createEvolutionOnlineGraderRuntime({
    concurrency: 1,
    listBacklog: () => [],
    runGrade: async () => {
      resolveEntered()
      await gradeGate
    },
    onError: (error) => { throw error },
  })

  try {
    await runtime.start()
    assert.equal(runtime.enqueue({
      userId: 'owner', promotionId: 'promotion-singleton', outcomeId: 'outcome-active',
    }), true)
    await entered
    setEvolutionOnlineGraderRuntimeForTesting(runtime)
    const closing = closeEvolutionOnlineGraderRuntime()

    await assert.rejects(
      () => startEvolutionOnlineGraderRuntime(),
      /runtime is closing/,
    )
    releaseGrade()
    await closing
  } finally {
    releaseGrade?.()
    setEvolutionOnlineGraderRuntimeForTesting(null)
  }
})

test('production online grader runtime leaves unexpected persistence failures for restart recovery', async () => {
  const task = {
    userId: 'owner',
    promotionId: 'promotion-recovery',
    outcomeId: 'outcome-recovery',
  }
  let calls = 0
  let errors = 0
  const runtime = createEvolutionOnlineGraderRuntime({
    listBacklog: () => [task],
    runGrade: async () => {
      calls += 1
      throw new Error('injected persistence failure')
    },
    onError: () => { errors += 1 },
  })

  await runtime.start()
  await runtime.close()
  assert.equal(calls, 1)
  assert.equal(errors, 1)
})

test('production online grader runtime backs off persistent backlog failures and close stops retries', async () => {
  let backlogCalls = 0
  let resolveRetried
  const retried = new Promise((resolve) => { resolveRetried = resolve })
  const runtime = createEvolutionOnlineGraderRuntime({
    retryBaseMs: 2,
    retryMaxMs: 4,
    listBacklog: async () => {
      backlogCalls += 1
      if (backlogCalls >= 3) resolveRetried()
      throw new Error('injected backlog failure')
    },
    onError: () => {},
  })

  await runtime.start()
  await Promise.race([
    retried,
    delay(1_000).then(() => { throw new Error('backlog retry did not run') }),
  ])
  await runtime.close()
  const callsAfterClose = backlogCalls
  await delay(20)

  assert.equal(backlogCalls, callsAfterClose)
  assert.equal(runtime.state().needsBackfill, false)
})

test('production online grader runtime aborts and does not wait for an in-flight backlog query', async () => {
  let backlogCalls = 0
  let resolveEntered
  const entered = new Promise((resolve) => { resolveEntered = resolve })
  let observedSignal = null
  const runtime = createEvolutionOnlineGraderRuntime({
    listBacklog: ({ signal }) => {
      backlogCalls += 1
      observedSignal = signal
      resolveEntered()
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    onError: () => {},
  })

  void runtime.start()
  await entered
  const lifecycleSignal = new AbortController().signal
  await Promise.race([
    runtime.close({ signal: lifecycleSignal }),
    delay(1_000).then(() => { throw new Error('runtime close waited for backlog query') }),
  ])

  assert.equal(backlogCalls, 1)
  assert.equal(observedSignal?.aborted, true)
  assert.equal(runtime.state().pending, 0)
  assert.equal(runtime.state().active, 0)
})
