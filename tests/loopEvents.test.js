import assert from 'node:assert/strict'
import test from 'node:test'

import { LOOP_EVENT_NAMES, createLoopEvents } from '../server/services/loop/events.js'
import {
  installToolHookBridge,
  TOOL_HOOK_RESULT,
} from '../server/services/loop/executeToolCalls.js'
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
    context: { turnId: 'turn-prepared-request' },
    runModel: async (request) => {
      modelRequests.push(request)
      throw modelRequests.length === 1 ? firstError : retryError
    },
  }), (error) => error === retryError)

  assert.equal(errorEvents.length, 1)
  assert.deepEqual(errorEvents[0].payload, {
    kind: 'error',
    error: firstError,
    request: { model: 'original', preparedForAttempt: 1 },
    attempt: 1,
  })
  assert.deepEqual(errorEvents[0].context, {
    turnId: 'turn-prepared-request',
    attempt: 1,
    error: firstError,
    request: { model: 'original', preparedForAttempt: 1 },
  })
  assert.deepEqual(modelRequests, [
    { model: 'original', preparedForAttempt: 1 },
    {
      model: 'original',
      preparedForAttempt: 2,
      retryClaimed: true,
    },
  ])
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

  const call = await events.waterfall('pre-tool', {
    id: 'call-hook-bridge',
    name: 'echo_tool',
    args: { value: 'original' },
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
