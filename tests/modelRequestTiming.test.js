import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchTurnEvent } from '../src/lib/turnClient/turnEventDispatch.js'
import { reduceMessageState } from '../src/store/reducers/messageReducer.js'

const at = 1800000000000

test('host request timing measures progress and public release without replay inflation or private data', async () => {
  let state = { activeSessionId: 's', sessions: [{ id: 's', messages: [{ id: 'm', role: 'assistant', content: '', meta: { streaming: true } }] }] }
  const dispatch = (action) => { state = reduceMessageState(state, action) || state }
  const send = (sequence, type, payload, offset) => dispatchTurnEvent({ id: `timing-${sequence}`, sequence, type,
    sessionId: 's', turnId: 't', createdAt: at + offset, payload }, { dispatch, messageTarget: { sessionId: 's', messageId: 'm' } })
  await send(1, 'model.phase', { phase: 'started', elapsedMs: 0 }, 0)
  await send(2, 'model.phase', { phase: 'streaming', elapsedMs: 500, reasoning: 'PRIVATE_REASONING' }, 500)
  await send(3, 'assistant.delta', { text: 'Public answer' }, 1500)
  const meta = state.sessions[0].messages[0].meta
  assert.equal(meta.modelTiming.startedAt, at)
  assert.equal(meta.modelTiming.firstProgressAt, at + 500)
  assert.equal(meta.modelTiming.firstPublicAt, at + 1500)
  assert.equal(Object.hasOwn(meta, 'modelTimingSignal'), false, 'transient signals never enter saved message metadata')
  assert.equal(JSON.stringify(meta.modelTiming).includes('PRIVATE'), false)
  await send(3, 'assistant.delta', { text: 'Public answer' }, 9999)
  assert.equal(state.sessions[0].messages[0].meta.modelTiming.firstPublicAt, at + 1500)
  assert.equal(state.sessions[0].messages[0].content, 'Public answer')
  await send(4, 'model.phase', { phase: 'started', elapsedMs: 0 }, 2000)
  assert.equal(state.sessions[0].messages[0].meta.modelTiming.firstPublicAt, null, 'a new request cannot inherit old narration timing')
  await send(5, 'assistant.delta', { text: '' }, 2100)
  assert.equal(state.sessions[0].messages[0].meta.modelTiming.firstPublicAt, null, 'empty text is not visible progress')
})
