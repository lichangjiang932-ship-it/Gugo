import assert from 'node:assert/strict'
import test from 'node:test'

import { LOOP_EVENT_NAMES, createLoopEvents } from '../server/services/loop/events.js'
import {
  installToolHookBridge,
  runPostTool,
  runPreTool,
  TOOL_HOOK_RESULT,
} from '../server/services/loop/executeToolCalls.js'
import { runPreStep } from '../server/services/loop/preStep.js'
import { runModelStep } from '../server/services/loop/step.js'

test('loop events expose the fixed kernel event catalog', () => {
  assert.deepEqual(LOOP_EVENT_NAMES, [
    'pre-step',
    'request',
    'request-error',
    'pre-tool',
    'post-tool',
    'compaction',
    'turn-stopping',
  ])

  const events = createLoopEvents()
  assert.throws(() => events.on('unknown', () => {}), /Unknown loop event/)
  assert.throws(() => events.on('request', null), /listener must be a function/)
})

test('on and off manage listeners without changing an active dispatch snapshot', async () => {
  const events = createLoopEvents()
  const calls = []
  const second = () => calls.push('second')
  const first = () => {
    calls.push('first')
    events.off('pre-step', second)
  }

  events.on('pre-step', first)
  const unsubscribe = events.on('pre-step', second)

  await events.serial('pre-step', {})
  assert.deepEqual(calls, ['first', 'second'])

  calls.length = 0
  await events.serial('pre-step', {})
  assert.deepEqual(calls, ['first'])
  assert.equal(unsubscribe(), false)
})

test('emit observes listeners concurrently and preserves registration order in results', async () => {
  const events = createLoopEvents()
  const calls = []
  let releaseFirst
  const firstFinished = new Promise((resolve) => { releaseFirst = resolve })

  events.on('request', async (request, context) => {
    calls.push(`first:start:${context.turnId}`)
    await firstFinished
    calls.push('first:end')
    return request.model
  })
  events.on('request', async () => {
    calls.push('second')
    releaseFirst()
    return 'observer'
  })

  const results = await events.emit('request', { model: 'primary' }, { turnId: 'turn-1' })
  assert.deepEqual(calls, ['first:start:turn-1', 'second', 'first:end'])
  assert.deepEqual(results, ['primary', 'observer'])
})

test('serial awaits each observer before invoking the next one', async () => {
  const events = createLoopEvents()
  const calls = []

  events.on('post-tool', async () => {
    calls.push('first:start')
    await Promise.resolve()
    calls.push('first:end')
    return 1
  })
  events.on('post-tool', () => {
    calls.push('second')
    return 2
  })

  assert.deepEqual(await events.serial('post-tool', {}), [1, 2])
  assert.deepEqual(calls, ['first:start', 'first:end', 'second'])
})

test('observer dispatch fails open and continues in registration order', async () => {
  const events = createLoopEvents()
  const calls = []
  const observerError = new Error('observer failed')
  assert.equal(events.has('turn-stopping'), false)
  events.on('turn-stopping', () => {
    calls.push('first')
    throw observerError
  })
  events.on('turn-stopping', () => {
    calls.push('second')
    return 'observed'
  })
  assert.equal(events.has('turn-stopping'), true)

  const results = await events.observe('turn-stopping', { text: 'done' }, {})

  assert.deepEqual(calls, ['first', 'second'])
  assert.equal(results[0].ok, false)
  assert.equal(results[0].error, observerError)
  assert.deepEqual(results[1], { ok: true, value: 'observed' })
})

test('waterfall applies sequential replacements and keeps the current value for undefined', async () => {
  const events = createLoopEvents()
  const seen = []

  events.on('pre-tool', (call, context) => {
    seen.push([call.args.count, context.turnId])
    return { ...call, args: { count: call.args.count + 1 } }
  })
  events.on('pre-tool', (call) => {
    seen.push([call.args.count, 'unchanged'])
    return undefined
  })
  events.on('pre-tool', (call) => ({
    ...call,
    args: { count: call.args.count * 2 },
  }))

  const result = await events.waterfall(
    'pre-tool',
    { name: 'read_file', args: { count: 2 } },
    { turnId: 'turn-2' },
  )

  assert.deepEqual(seen, [[2, 'turn-2'], [3, 'unchanged']])
  assert.deepEqual(result, { name: 'read_file', args: { count: 6 } })
})

test('pre-step is an immutable observer and cannot replace messages or tools', async () => {
  const events = createLoopEvents()
  const state = {
    iteration: 3,
    messages: [{ role: 'user', content: 'trusted request' }],
    toolSpecs: [{ function: { name: 'read_file' } }],
  }
  const context = { job: { id: 'host-job' }, phase: 'pre-step' }
  events.on('pre-step', (snapshot, eventContext) => {
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.messages), true)
    assert.equal(Object.isFrozen(snapshot.messages[0]), true)
    assert.equal(Object.isFrozen(snapshot.toolSpecs), true)
    assert.equal(Object.isFrozen(eventContext), true)
    assert.equal(Object.isFrozen(eventContext.job), true)
    assert.throws(() => { snapshot.messages[0].content = 'forged request' }, TypeError)
    assert.throws(() => { eventContext.job.id = 'forged-job' }, TypeError)
    return {
      iteration: 99,
      messages: [{ role: 'system', content: 'forged prompt' }],
      toolSpecs: [{ function: { name: 'undeclared_tool' } }],
    }
  })

  const observed = await runPreStep({ loopEvents: events, context, state })

  assert.equal(observed, state)
  assert.deepEqual(state.messages, [{ role: 'user', content: 'trusted request' }])
  assert.deepEqual(state.toolSpecs, [{ function: { name: 'read_file' } }])
  assert.deepEqual(context, { job: { id: 'host-job' }, phase: 'pre-step' })
})

test('pre-tool projection accepts args only and preserves host-owned call identity', async () => {
  const events = createLoopEvents()
  const original = {
    id: 'call-owned-by-host',
    type: 'function',
    name: 'read_file',
    args: { path: 'before.txt' },
    checkpointStatus: 'pending',
    checkpointApprovalId: null,
    checkpointExecutionArgs: { path: 'persisted.txt' },
    dynamicToolRegistrationId: 'registration-owned-by-host',
    idempotencyKey: 'idempotency-owned-by-host',
  }
  events.on('pre-tool', (call) => {
    call.checkpointExecutionArgs.path = 'mutated-through-alias.txt'
    return {
      ...call,
      id: 'forged-call',
      name: 'write_file',
      args: { path: 'after.txt' },
      checkpointStatus: 'executing',
      checkpointApprovalId: 'forged-approval',
      checkpointExecutionArgs: { path: 'forged-execution.txt' },
      dynamicToolRegistrationId: 'forged-registration',
      idempotencyKey: 'forged-idempotency',
      pluginOwnedField: true,
    }
  })

  const prepared = await runPreTool({ loopEvents: events, call: original })

  assert.deepEqual(prepared, { ...original, args: { path: 'after.txt' } })
  assert.deepEqual(original.checkpointExecutionArgs, { path: 'persisted.txt' })
  assert.equal('pluginOwnedField' in prepared, false)
})

test('post-tool observers receive an immutable isolated outcome snapshot', async () => {
  const events = createLoopEvents()
  const call = { id: 'post-call', name: 'read_file', args: { path: 'result.txt' } }
  const result = { ok: true, nested: { value: 'original' } }
  let observed = null
  events.on('post-tool', (payload) => {
    observed = payload
    assert.equal(Object.isFrozen(payload), true)
    assert.equal(Object.isFrozen(payload.call), true)
    assert.equal(Object.isFrozen(payload.result), true)
    assert.equal(Object.isFrozen(payload.result.nested), true)
    assert.throws(() => { payload.call.name = 'write_file' }, TypeError)
    assert.throws(() => { payload.result.ok = false }, TypeError)
    assert.throws(() => { payload.result.nested.value = 'forged' }, TypeError)
    return { call: { name: 'forged_tool' }, result: { ok: false } }
  })

  const snapshot = await runPostTool({ loopEvents: events, call, result })

  assert.equal(snapshot, observed)
  assert.deepEqual(call, { id: 'post-call', name: 'read_file', args: { path: 'result.txt' } })
  assert.deepEqual(result, { ok: true, nested: { value: 'original' } })
  assert.deepEqual(snapshot, { call, result })
  assert.notEqual(snapshot.call, call)
  assert.notEqual(snapshot.result, result)
})

test('dispatch errors propagate to the loop caller', async () => {
  for (const method of ['emit', 'serial', 'waterfall']) {
    const events = createLoopEvents()
    const error = new Error(`${method} failed`)
    events.on('request-error', () => { throw error })

    await assert.rejects(events[method]('request-error', {}), (caught) => caught === error)
  }
})

test('request-error receives the prepared request and may claim only one retry', async () => {
  const events = createLoopEvents()
  const firstError = new Error('first model failure')
  const retryError = new Error('retry model failure')
  const modelRequests = []
  const errorEvents = []

  events.on('request', (request, context) => ({
    ...request,
    preparedForAttempt: context.attempt,
  }))
  events.on('request-error', (payload, context) => {
    errorEvents.push({ payload, context })
    return {
      kind: 'retry',
      request: { ...payload.request, retryClaimed: true },
    }
  })

  await assert.rejects(runModelStep({
    request: { model: 'original' },
    loopEvents: events,
    context: {
      userId: 'user-prepared-request',
      jobId: 'job-prepared-request',
      phase: 'model-request',
      hostService: { secret: 'must-not-cross-event-boundary' },
    },
    beforeRequest: ({ request, attempt }) => ({
      ...request,
      modelRequestId: `mr_attempt_${attempt}`,
    }),
    runModel: async (request) => {
      modelRequests.push(request)
      throw modelRequests.length === 1 ? firstError : retryError
    },
  }), (error) => error === retryError)

  assert.equal(errorEvents.length, 1)
  assert.deepEqual(errorEvents[0].payload, {
    kind: 'error',
    error: firstError,
    request: {
      model: 'original',
      preparedForAttempt: 1,
      modelRequestId: 'mr_attempt_1',
    },
    attempt: 1,
  })
  assert.deepEqual(errorEvents[0].context, {
    userId: 'user-prepared-request',
    jobId: 'job-prepared-request',
    phase: 'model-request',
    attempt: 1,
  })
  assert.equal(Object.isFrozen(errorEvents[0].context), true)
  assert.equal('error' in errorEvents[0].context, false)
  assert.equal('request' in errorEvents[0].context, false)
  assert.equal('hostService' in errorEvents[0].context, false)
  assert.deepEqual(modelRequests, [
    { model: 'original', preparedForAttempt: 1, modelRequestId: 'mr_attempt_1' },
    {
      model: 'original',
      preparedForAttempt: 2,
      retryClaimed: true,
      modelRequestId: 'mr_attempt_2',
    },
  ])
})

test('a model budget error carrying an authoritative response cannot be claimed for retry', async () => {
  const events = createLoopEvents()
  let modelCalls = 0
  let retryEvents = 0
  events.on('request-error', () => {
    retryEvents += 1
    return { kind: 'retry' }
  })
  const response = { content: 'already paid response', toolCalls: [] }

  await assert.rejects(runModelStep({
    request: { model: 'original' },
    loopEvents: events,
    runModel: async () => {
      modelCalls += 1
      throw Object.assign(new Error('model token budget exceeded'), {
        code: 'MODEL_BUDGET_EXCEEDED',
        partialModelResult: response,
      })
    },
  }), (error) => error?.code === 'MODEL_BUDGET_EXCEEDED'
    && error?.partialModelResult === response)

  assert.equal(modelCalls, 1)
  assert.equal(retryEvents, 0)
})

test('the process hook service is bridged as pre-tool and post-tool consumers', async () => {
  const events = createLoopEvents()
  const dispatched = []
  const dispose = installToolHookBridge({
    loopEvents: events,
    job: { id: 'job-hook-bridge', userId: 'user-hook-bridge' },
    step: { id: 'step-hook-bridge' },
    dispatchHooks: async (payload) => {
      dispatched.push(payload)
      if (payload.event === 'pre_tool_use') {
        return { allow: true, replacementArgs: { value: 'rewritten' } }
      }
      return { allow: true }
    },
  })

  const call = await runPreTool({
    loopEvents: events,
    call: {
      id: 'call-hook-bridge',
      name: 'echo_tool',
      args: { value: 'original' },
    },
  })
  assert.deepEqual(call.args, { value: 'rewritten' })
  assert.equal(call[TOOL_HOOK_RESULT].allow, true)
  await events.serial('post-tool', { call, result: { ok: false, code: 'failed' } })

  assert.deepEqual(dispatched.map(({ event }) => event), ['pre_tool_use', 'post_tool_use'])
  assert.deepEqual(dispatched[1].args, {
    input: { value: 'rewritten' },
    output: { ok: false, code: 'failed' },
  })

  dispose()
  await events.waterfall('pre-tool', { name: 'echo_tool', args: {} })
  assert.equal(dispatched.length, 2)
})
