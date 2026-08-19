import assert from 'node:assert/strict'
import test from 'node:test'

import { reduceSessionLifecycleState } from '../src/store/reducers/sessionLifecycleReducer.js'

test('server fork insertion keeps parent-local model settings and can switch independently', () => {
  const initial = {
    sessions: [{
      id: 'parent',
      title: 'Parent',
      messages: [{ id: 'old', role: 'user', content: 'old' }],
      agentId: 'agent-1',
      modelName: 'model-1',
    }],
    activeSessionId: 'parent',
    newDraftVersion: 0,
    sessionDrafts: {},
  }
  const inserted = reduceSessionLifecycleState(initial, {
    type: 'ADD_SERVER_FORK',
    payload: {
      session: {
        id: 'child',
        title: 'Parent',
        parentSessionId: 'parent',
        branchLabel: 'Alternative',
        forkedAt: 500,
        createdAt: 500,
        updatedAt: 500,
        revision: 2,
      },
    },
  })

  assert.equal(inserted.activeSessionId, 'parent')
  assert.deepEqual(inserted.sessions[0], {
    id: 'child',
    title: 'Parent',
    messages: [],
    createdAt: 500,
    updatedAt: 500,
    lastViewedAt: null,
    archivedAt: null,
    pinnedAt: null,
    parentSessionId: 'parent',
    branchLabel: 'Alternative',
    forkedAt: 500,
    serverRevision: 2,
    agentId: 'agent-1',
    modelName: 'model-1',
  })

  const switched = reduceSessionLifecycleState(inserted, {
    type: 'SWITCH_SESSION',
    payload: 'child',
  })
  assert.equal(switched.activeSessionId, 'child')
  assert.equal(switched.sessions.find(({ id }) => id === 'parent').messages.length, 1)
})
