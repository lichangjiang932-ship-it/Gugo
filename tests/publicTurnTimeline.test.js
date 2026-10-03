import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePublicTurnTimeline, PUBLIC_TURN_TIMELINE_LIMITS } from '../shared/publicTurnTimeline.js'
import { copyPublicTimelineCheckpoint, createTurnPublicTimeline, publicTimelineContext, recordPublicToolAnchor, updateTurnPublicText } from '../server/services/turnPublicTimeline.js'
import { assistantPublicTimeline } from '../src/lib/assistantPublicTimeline.js'
import { mergeServerSessionMessages } from '../src/store/sessionMessageSnapshotMerge.js'
import { dispatchTurnEvent } from '../src/lib/turnClient/turnEventDispatch.js'
import { createTurnEvent } from '../shared/turnEvents.js'
import { reduceMessageState } from '../src/store/reducers/messageReducer.js'

const scope = { userId: 'owner', sessionId: 'session', turnId: 'turn' }
function fixture() {
  const state = { publicTimeline: createTurnPublicTimeline(scope, null) }
  updateTurnPublicText(state, 'Inspect 👩‍💻\n\n')
  recordPublicToolAnchor(state, { id: 'read', name: 'read_file' }, state.publicTimeline.text.length)
  updateTurnPublicText(state, state.publicTimeline.text + 'Final answer')
  return state
}

test('host anchors are UTF-16 coordinates and repeated lifecycle events never move a call', () => {
  const state = fixture()
  const before = structuredClone(state.publicTimeline.toolAnchors)
  recordPublicToolAnchor(state, { id: 'read', name: 'read_file' }, state.publicTimeline.text.length)
  assert.deepEqual(state.publicTimeline.toolAnchors, before)
  assert.equal(before[0].textOffset, 'Inspect 👩‍💻\n\n'.length)
  const saved = copyPublicTimelineCheckpoint(state.publicTimeline, scope)
  saved.toolAnchors[0].textOffset = 0
  assert.deepEqual(state.publicTimeline.toolAnchors, before, 'checkpoint objects do not alias mutable host state')
})

test('checkpoint continuation requires the same identity and a known compatible public prefix', () => {
  const state = fixture()
  const checkpoint = { publicTimeline: state.publicTimeline }
  assert.deepEqual(createTurnPublicTimeline(scope, checkpoint), state.publicTimeline)
  for (const field of ['userId', 'sessionId', 'turnId']) {
    assert.equal(createTurnPublicTimeline({ ...scope, [field]: 'different' }, checkpoint), null)
  }
  assert.equal(createTurnPublicTimeline(scope, { messages: [{ role: 'assistant', content: 'not evidence' }] }), null)
  assert.equal(createTurnPublicTimeline(scope, checkpoint, 'unrelated replacement'), null)
  const prefix = createTurnPublicTimeline(scope, checkpoint, 'Inspect 👩‍💻\n\n')
  assert.equal(prefix.text, 'Inspect 👩‍💻\n\n')
  assert.equal(prefix.toolAnchors.length, 1)
})

test('resource limits and malformed anchors disable the projection without truncating into false coordinates', () => {
  const state = fixture()
  updateTurnPublicText(state, 'x'.repeat(PUBLIC_TURN_TIMELINE_LIMITS.textChars + 1))
  assert.equal(state.publicTimeline, null)
  updateTurnPublicText(state, '')
  recordPublicToolAnchor(state, { id: 'new', name: 'read_file' }, 0)
  assert.equal(state.publicTimeline, null)
  const full = { publicTimeline: createTurnPublicTimeline(scope, null) }
  for (let index = 0; index <= PUBLIC_TURN_TIMELINE_LIMITS.toolAnchors; index += 1) {
    recordPublicToolAnchor(full, { id: `tool-${index}`, name: 'read_file' }, 0)
  }
  assert.equal(full.publicTimeline, null)
  const conflict = fixture()
  recordPublicToolAnchor(conflict, { id: 'read', name: 'different_tool' }, 0)
  assert.equal(conflict.publicTimeline, null)
})

test('terminal projections bind the canonical answer without duplicating it or guessing an unrelated replacement', () => {
  const state = fixture()
  const value = publicTimelineContext(state.publicTimeline, scope, 'Final answer').publicTimeline
  assert.equal(value.text, 'Inspect 👩‍💻\n\nFinal answer')
  assert.equal(value.canonicalText, 'Final answer')
  assert.equal(Object.hasOwn(value, 'userId'), false)
  assert.deepEqual(publicTimelineContext(state.publicTimeline, scope, 'Unrelated edited answer'), {})
  updateTurnPublicText(state, state.publicTimeline.text + '\n\n')
  assert.equal(publicTimelineContext(state.publicTimeline, scope, 'Final answer\n\n').publicTimeline.text, state.publicTimeline.text)
  const nonStreaming = { publicTimeline: createTurnPublicTimeline(scope, null) }
  recordPublicToolAnchor(nonStreaming, { id: 'call', name: 'read_file' }, 0)
  assert.equal(publicTimelineContext(nonStreaming.publicTimeline, scope, 'Non-streamed answer').publicTimeline.text, 'Non-streamed answer')
})

test('display getters align tool offsets only with their own public body and reject stale or mismatched projections', () => {
  const publicTimeline = publicTimelineContext(fixture().publicTimeline, scope, 'Final answer').publicTimeline
  const message = { id: 'message', content: 'Final answer', meta: { serverTurnId: 'turn', streaming: false,
    publicTimeline, toolCalls: [{ id: 'read', name: 'read_file', arguments: '{}', status: 'success' }] } }
  const view = assistantPublicTimeline(message)
  assert.equal(view.content, publicTimeline.text)
  assert.equal(view.toolCalls[0].textOffset, 'Inspect 👩‍💻\n\n'.length)
  assert.equal(Object.hasOwn(message.meta.toolCalls[0], 'textOffset'), false, 'canonical tool state remains in its original coordinate space')
  for (const changed of [
    { ...message, content: 'Edited canonical answer' },
    { ...message, meta: { ...message.meta, serverTurnId: 'other' } },
    { ...message, meta: { ...message.meta, serverTurnId: null } },
    { ...message, meta: { ...message.meta, streaming: true } },
    { ...message, meta: { ...message.meta, toolCalls: [{ id: 'read', name: 'different_tool' }] } },
  ]) assert.equal(assistantPublicTimeline(changed).content, changed.content)
})

test('snapshot merging cannot resurrect missing projection data or roll a newer stream back', () => {
  const projection = publicTimelineContext(fixture().publicTimeline, scope, 'Final answer').publicTimeline
  const local = { id: 'same', content: 'Final answer', role: 'assistant', meta: { publicTimeline: projection, serverLastSequence: 4 } }
  const server = { id: 'same', content: 'Final answer', role: 'assistant', meta: { serverLastSequence: 5 } }
  assert.equal(mergeServerSessionMessages([local], [server])[0].meta.publicTimeline, undefined)
  const newer = { ...local, content: 'new live body', meta: { streaming: true, serverLastSequence: 6 } }
  const older = { ...server, meta: { ...server.meta, publicTimeline: projection } }
  const [merged] = mergeServerSessionMessages([newer], [older])
  assert.equal(merged.content, 'new live body')
  assert.equal(merged.meta.publicTimeline, undefined)
})

test('projection normalization strips private fields and rejects malformed, duplicate or foreign coordinates', () => {
  const value = publicTimelineContext(fixture().publicTimeline, scope, 'Final answer').publicTimeline
  const normalized = normalizePublicTurnTimeline({ ...value, reasoning: 'private', toolAnchors: [{ ...value.toolAnchors[0], reasoning: 'private' }] })
  assert.equal(JSON.stringify(normalized).includes('private'), false)
  for (const toolAnchors of [[...value.toolAnchors, ...value.toolAnchors], [{ ...value.toolAnchors[0], textOffset: -1 }],
    [{ ...value.toolAnchors[0], textOffset: value.text.length + 1 }], [{ ...value.toolAnchors[0], textOffset: 1.5 }]]) {
    assert.equal(normalizePublicTurnTimeline({ ...value, toolAnchors }), null)
  }
})

test('the real recovery-attempt dispatcher clears an old display projection in the same reducer update', async () => {
  const projection = publicTimelineContext(fixture().publicTimeline, scope, 'Final answer').publicTimeline
  let state = { activeSessionId: 'session', sessions: [{ id: 'session', messages: [{ id: 'message', role: 'assistant',
    content: 'Final answer', meta: { serverTurnId: 'turn', serverLastSequence: 4, publicTimeline: projection } }] }] }
  await dispatchTurnEvent(createTurnEvent({ id: 'attempt-reset', sessionId: 'session', turnId: 'turn', sequence: 5,
    type: 'turn.attempt', createdAt: 6, payload: { attempt: 2, reason: 'checkpoint_resume', resetStreaming: true,
      checkpointSequence: 3, previousStreamSequence: 4, assistantText: 'Resumed public prefix', reasoningText: '' } }), {
    messageTarget: { sessionId: 'session', messageId: 'message' },
    dispatch: (action) => { state = reduceMessageState(state, action) || state },
  })
  const message = state.sessions[0].messages[0]
  assert.equal(message.content, 'Resumed public prefix')
  assert.equal(message.meta.publicTimeline, null)
  assert.equal(message.meta.serverLastSequence, 5)
  assert.equal(assistantPublicTimeline(message).content, message.content)
})
