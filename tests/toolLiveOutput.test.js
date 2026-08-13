import test from 'node:test'
import assert from 'node:assert/strict'
import { runProcessWithGroup } from '../server/utils/processGroup.js'
import { parseTurnActivity, createTurnActivity } from '../shared/turnEvents.js'
import { reduceMessageState } from '../src/store/reducers/messageReducer.js'
import { dispatchTurnActivity } from '../src/lib/turnClient/turnEventDispatch.js'

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
