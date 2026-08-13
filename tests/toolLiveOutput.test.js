import test from 'node:test'
import assert from 'node:assert/strict'
import { runProcessWithGroup } from '../server/utils/processGroup.js'
import { parseTurnActivity, createTurnActivity } from '../shared/turnEvents.js'
import { reduceMessageState } from '../src/store/reducers/messageReducer.js'
import {
  createBufferedTurnActivityDispatcher,
  dispatchTurnActivity,
  dispatchTurnEvent,
} from '../src/lib/turnClient/turnEventDispatch.js'
import {
  createToolOutputBuffer,
  DEFAULT_TOOL_OUTPUT_FLUSH_MS,
  TOOL_LIVE_OUTPUT_CHAR_LIMIT,
} from '../src/lib/turnClient/toolOutputBuffer.js'

function createManualScheduler() {
  let nextId = 0
  const pending = new Map()
  const delays = []
  return {
    schedule(callback, delay) {
      const id = ++nextId
      pending.set(id, callback)
      delays.push(delay)
      return id
    },
    cancel(id) {
      pending.delete(id)
    },
    runAll() {
      for (const [id, callback] of [...pending]) {
        pending.delete(id)
        callback()
      }
    },
    delays,
    get size() { return pending.size },
  }
}

test('runProcessWithGroup streams stdout/stderr through onOutput', async () => {
  const deltas = []
  const r = await runProcessWithGroup({
    shellPath: process.execPath,
    shellArgs: ['-e', "console.log('line-one'); console.error('err-one'); console.log('line-two')"],
    cwd: process.cwd(),
    env: process.env,
    timeout: 5_000,
    onOutput: (delta) => deltas.push(delta),
  })
  assert.equal(r.code, 0)
  const out = deltas.filter((d) => d.stream === 'stdout').map((d) => d.chunk).join('')
  const err = deltas.filter((d) => d.stream === 'stderr').map((d) => d.chunk).join('')
  assert.match(out, /line-one/)
  assert.match(out, /line-two/)
  assert.match(err, /err-one/)
})

test('tool_output_delta is a strict non-durable activity', () => {
  const activity = createTurnActivity({
    sessionId: 's1',
    turnId: 't1',
    kind: 'tool_output_delta',
    toolName: 'bash_exec',
    toolCallId: 'call-1',
    stream: 'stdout',
    chunk: 'hello\n',
    createdAt: 3,
  })
  assert.equal(activity.kind, 'tool_output_delta')
  assert.equal(activity.toolCallId, 'call-1')
  assert.throws(() => parseTurnActivity({ ...activity, chunk: 42 }))
  assert.throws(() => parseTurnActivity({ ...activity, stream: 'trace' }))
})

test('APPEND_TOOL_CALL_OUTPUT accumulates live output and caps its tail', () => {
  const state = {
    activeSessionId: 's1',
    sessions: [{ id: 's1', messages: [{ id: 'm1', role: 'assistant', content: '', meta: { toolCalls: [{ id: 'c1', name: 'bash_exec', status: 'running' }] } }] }],
  }
  const first = reduceMessageState(state, { type: 'APPEND_TOOL_CALL_OUTPUT', payload: { id: 'c1', chunk: 'a', stream: 'stdout' } })
  const second = reduceMessageState(first, { type: 'APPEND_TOOL_CALL_OUTPUT', payload: { id: 'c1', chunk: 'b', stream: 'stdout' } })
  const call = second.sessions[0].messages[0].meta.toolCalls[0]
  assert.equal(call.liveOutput, 'ab')
  assert.equal(call.liveStream, 'stdout')
})

test('tool output buffer batches by call id while preserving per-call chunk order', () => {
  const scheduler = createManualScheduler()
  const flushed = []
  const buffer = createToolOutputBuffer({
    onFlush: (output) => flushed.push(output),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  })

  assert.equal(buffer.append({ id: 'call-a', name: 'bash_exec', chunk: 'one', stream: 'stdout' }), true)
  assert.equal(buffer.append({ id: 'call-b', name: 'bash_exec', chunk: 'other', stream: 'stdout' }), true)
  assert.equal(buffer.append({ id: 'call-a', chunk: '-two', stream: 'stderr' }), true)
  assert.equal(buffer.pendingCount, 2)
  assert.equal(flushed.length, 0)
  assert.deepEqual(scheduler.delays, [DEFAULT_TOOL_OUTPUT_FLUSH_MS])

  scheduler.runAll()

  assert.deepEqual(flushed, [
    { id: 'call-a', name: 'bash_exec', chunk: 'one-two', stream: 'stderr' },
    { id: 'call-b', name: 'bash_exec', chunk: 'other', stream: 'stdout' },
  ])
  assert.equal(buffer.pendingCount, 0)
})

test('tool output buffer keeps the 16k tail and dispose flushes exactly once', () => {
  const scheduler = createManualScheduler()
  const flushed = []
  const buffer = createToolOutputBuffer({
    onFlush: (output) => flushed.push(output),
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
  })

  buffer.append({ id: 'call-tail', chunk: 'a'.repeat(10_000) })
  buffer.append({ id: 'call-tail', chunk: 'b'.repeat(10_000) })

  assert.equal(buffer.dispose(), 1)
  assert.equal(scheduler.size, 0)
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].chunk.length, TOOL_LIVE_OUTPUT_CHAR_LIMIT)
  assert.equal(flushed[0].chunk, `${'a'.repeat(6_000)}${'b'.repeat(10_000)}`)
  assert.equal(buffer.append({ id: 'call-tail', chunk: 'ignored' }), false)

  scheduler.runAll()
  assert.equal(flushed.length, 1)
})

test('dispatchTurnActivity routes tool_output_delta to the append output action', () => {
  const dispatched = []
  const result = dispatchTurnActivity(
    createTurnActivity({
      sessionId: 's1',
      turnId: 't1',
      kind: 'tool_output_delta',
      toolName: 'media_transform',
      toolCallId: 'call-9',
      stream: 'stderr',
      chunk: 'frame=1',
      createdAt: 4,
    }),
    { dispatch: (action) => dispatched.push(action), taskId: 'task-1' },
  )
  assert.equal(result, true)
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].type, 'APPEND_TOOL_CALL_OUTPUT')
  assert.equal(dispatched[0].payload.id, 'call-9')
  assert.equal(dispatched[0].payload.chunk, 'frame=1')
  assert.equal(dispatched[0].payload.stream, 'stderr')
})

test('buffered turn activity flushes output before tool completion', async () => {
  const scheduler = createManualScheduler()
  const actions = []
  const buffered = createBufferedTurnActivityDispatcher({
    dispatch: (action) => actions.push(action),
    taskId: 'task-1',
    messageTarget: { sessionId: 's1', messageId: 'assistant-1' },
    bufferOptions: { schedule: scheduler.schedule, cancel: scheduler.cancel },
  })

  buffered.onActivity(createTurnActivity({
    sessionId: 's1', turnId: 't1', kind: 'tool_output_delta',
    toolName: 'bash_exec', toolCallId: 'call-1', stream: 'stdout', chunk: 'final line\n', createdAt: 1,
  }))
  assert.equal(actions.length, 0)

  await dispatchTurnEvent({
    type: 'tool.completed',
    turnId: 't1',
    sequence: 1,
    payload: { toolCallId: 'call-1', name: 'bash_exec', result: { ok: true } },
  }, {
    dispatch: (action) => actions.push(action),
    taskId: 'task-1',
    messageTarget: { sessionId: 's1', messageId: 'assistant-1' },
    flushToolOutput: buffered.flush,
  })

  assert.deepEqual(actions.map((action) => action.type), [
    'APPEND_TOOL_CALL_OUTPUT',
    'APPEND_TOOL_CALL_TO_LAST_MESSAGE',
  ])
  assert.equal(actions[0].payload.chunk, 'final line\n')
  assert.equal(scheduler.size, 0)
  buffered.dispose()
})

test('buffered turn activity flushes output before a terminal failure', async () => {
  const scheduler = createManualScheduler()
  const actions = []
  const buffered = createBufferedTurnActivityDispatcher({
    dispatch: (action) => actions.push(action),
    messageTarget: { sessionId: 's1', messageId: 'assistant-1' },
    bufferOptions: { schedule: scheduler.schedule, cancel: scheduler.cancel },
  })

  buffered.onActivity(createTurnActivity({
    sessionId: 's1', turnId: 't1', kind: 'tool_output_delta',
    toolName: 'bash_exec', toolCallId: 'call-1', stream: 'stderr', chunk: 'last error\n', createdAt: 1,
  }))
  await dispatchTurnEvent({
    type: 'turn.failed',
    turnId: 't1',
    sequence: 2,
    payload: { code: 'TURN_FAILED', message: 'failed' },
  }, {
    dispatch: (action) => actions.push(action),
    messageTarget: { sessionId: 's1', messageId: 'assistant-1' },
    flushToolOutput: buffered.flush,
  })

  assert.equal(actions[0].type, 'APPEND_TOOL_CALL_OUTPUT')
  assert.equal(actions[1].type, 'UPDATE_LAST_MESSAGE_META')
  assert.equal(actions[0].payload.chunk, 'last error\n')
  buffered.dispose()
})

test('tool completion and turn boundaries are output flush barriers', async () => {
  const events = [
    { type: 'tool.completed', payload: { toolCallId: 'call-1', name: 'bash_exec', result: { ok: true } } },
    { type: 'turn.interrupted', payload: { code: 'RETRY', message: 'retrying', retryable: true } },
    { type: 'turn.completed', payload: {} },
    { type: 'turn.paused', payload: { clarification: { question: 'Continue?' } } },
    { type: 'turn.cancelled', payload: {} },
    { type: 'turn.failed', payload: { code: 'FAILED', message: 'failed' } },
  ]

  for (const [index, event] of events.entries()) {
    const order = []
    await dispatchTurnEvent({ ...event, turnId: 't1', sequence: index }, {
      dispatch: () => order.push('dispatch'),
      flushToolOutput: () => order.push('flush'),
    })
    assert.equal(order[0], 'flush', `${event.type} must flush before dispatching its durable state`)
  }
})
