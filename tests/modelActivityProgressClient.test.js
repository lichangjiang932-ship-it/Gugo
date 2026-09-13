import assert from 'node:assert/strict'
import test from 'node:test'
import { modelActivityFromPhase } from '../src/lib/turnClient/modelActivityProgress.js'
import { dispatchTurnEvent } from '../src/lib/turnClient/turnEventDispatch.js'
import { reduceMessageState } from '../src/store/reducers/messageReducer.js'

const epoch = 1788850000000

test('model progress carries counters and request timing without partial arguments or private reasoning', () => {
  const activity = modelActivityFromPhase({
    phase: 'tool_arguments', iteration: 3, toolName: 'create_pptx', toolCallId: 'ppt-call',
    toolArgumentsChars: 12345, elapsedMs: 180000, idleMs: 0,
    arguments: '{"private":"unfinished deck"}', reasoning: 'private reasoning',
  }, epoch)
  assert.deepEqual(activity, {
    kind: 'tool_arguments', phase: 'tool_arguments', iteration: 3,
    toolName: 'create_pptx', toolCallId: 'ppt-call', toolArgumentsChars: 12345,
    elapsedMs: 180000, idleMs: 0, startedAt: epoch - 180000,
  })
})

test('missing or invalid timing never becomes a bogus elapsed clock', () => {
  for (const elapsedMs of [undefined, null, -1, Infinity, '1200', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(modelActivityFromPhase({ phase: 'idle', elapsedMs }, epoch).startedAt, undefined)
  }
  assert.equal(modelActivityFromPhase({ phase: 'idle', elapsedMs: 5000 }, null).startedAt, undefined)
  assert.equal(modelActivityFromPhase({ phase: 'idle', elapsedMs: epoch + 1 }, epoch).startedAt, undefined)
})

test('receiving tool arguments is visible but never creates a running or successful tool call', async () => {
  const actions = []
  await dispatchTurnEvent({
    id: 'args-event', type: 'model.phase', sessionId: 's', turnId: 't', sequence: 5, createdAt: epoch,
    payload: { phase: 'tool_arguments', iteration: 2, toolName: 'create_pptx', toolArgumentsChars: 7200, elapsedMs: 60000 },
  }, { dispatch: (action) => actions.push(action), taskId: 'task' })
  const activity = actions.find((action) => action.type === 'UPDATE_LAST_MESSAGE_META')?.payload?.modelActivity
  assert.equal(activity.kind, 'tool_arguments')
  assert.equal(activity.toolArgumentsChars, 7200)
  assert.equal(activity.startedAt, epoch - 60000)
  assert.equal(actions.some((action) => action.type === 'APPEND_TOOL_CALL_TO_LAST_MESSAGE'), false)
})

test('tool execution begins at the real tool.started event timestamp', async () => {
  const actions = []
  await dispatchTurnEvent({
    id: 'tool-event', type: 'tool.started', sessionId: 's', turnId: 't', sequence: 6, createdAt: epoch,
    payload: { toolCallId: 'ppt-call', name: 'create_pptx' },
  }, { dispatch: (action) => actions.push(action) })
  const started = actions.find((action) => action.type === 'APPEND_TOOL_CALL_TO_LAST_MESSAGE')
  assert.equal(started.payload.startedAt, epoch)
  assert.equal(started.payload.status, 'running')
  assert.equal(started.meta.modelActivity, null)
})

test('reasoning and answer deltas preserve the same request clock but not old tool argument labels', async () => {
  let state = { activeSessionId: 's', sessions: [{ id: 's', messages: [{ id: 'm', role: 'assistant', content: '', meta: { streaming: true } }] }] }
  const dispatch = (action) => { state = reduceMessageState(state, action) || state }
  const send = (type, payload, sequence) => dispatchTurnEvent({
    id: `clock-${sequence}`, type, payload, sessionId: 's', turnId: 't', sequence, createdAt: epoch + sequence,
  }, { dispatch, messageTarget: { sessionId: 's', messageId: 'm' } })
  await send('model.phase', { phase: 'tool_arguments', iteration: 2, toolName: 'read_file', toolArgumentsChars: 123, elapsedMs: 60000 }, 0)
  await send('reasoning.delta', { text: 'private reasoning', iteration: 2 }, 1)
  await send('assistant.delta', { text: 'Checking the result.' }, 2)
  const activity = state.sessions[0].messages[0].meta.modelActivity
  assert.equal(activity.startedAt, epoch - 60000)
  assert.equal(activity.kind, 'responding')
  assert.equal(activity.iteration, 2)
  assert.equal(activity.toolName, undefined)
  assert.equal(activity.toolArgumentsChars, undefined)
  await send('model.phase', { phase: 'started', iteration: 3, elapsedMs: 0 }, 3)
  assert.equal(state.sessions[0].messages[0].meta.modelActivity.startedAt, epoch + 3)
  await send('model.phase', { phase: 'completed', iteration: 3 }, 4)
  assert.equal(state.sessions[0].messages[0].meta.modelActivity, null)
})
