import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionMutationDispatcher } from '../src/store/sessionServerSync.js'

function dispatcher(error, onError = () => {}) {
  return createSessionMutationDispatcher({
    getState: () => ({ sessions: [{ id: 'a', serverRevision: 1, messages: [] }] }),
    reduceState: (state) => state, dispatchImmediate() {}, applyServerAction() {},
    deleteSession: async () => { throw error }, replaceMessages: async () => {}, onError,
  })
}

test('mutation feedback is safe and operation-local while the legacy boolean result stays unchanged', async () => {
  const failure = Object.assign(new Error('PRIVATE_TOKEN_DO_NOT_RENDER'), { code: 'SESSION_ACTIVE', status: 409 })
  const feedback = []
  const dispatch = dispatcher(failure)
  assert.equal(await dispatch({ type: 'DELETE_SESSION', payload: 'a' }, { onFailure: (value) => feedback.push(value) }), false)
  assert.deepEqual(feedback, [{ code: 'SESSION_ACTIVE', status: 409, outcome: 'refused' }])
  assert.equal(JSON.stringify(feedback).includes('PRIVATE_TOKEN'), false)
})

test('diagnostic observers cannot turn a failed mutation into a rejected or successful operation', async () => {
  const dispatch = dispatcher(new Error('PRIVATE_DIAGNOSTIC'), () => { throw new Error('observer error') })
  const feedback = []
  assert.equal(await dispatch({ type: 'DELETE_SESSION', payload: 'a' }, { onFailure: (value) => {
    feedback.push(value)
    throw new Error('observer error')
  } }), false)
  assert.deepEqual(feedback, [{ code: 'SESSION_MUTATION_UNKNOWN', status: 0, outcome: 'unknown' }])
})
