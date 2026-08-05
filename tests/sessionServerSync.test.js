import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSessionMutationDispatcher,
  isServerSessionMutation,
  mergeServerSessionMessages,
  projectSessionMutation,
  resolveSessionMutationTarget,
} from '../src/store/sessionServerSync.js'

function replaceSession(state, sessionId, update) {
  return {
    ...state,
    sessions: state.sessions.map((session) => (
      session.id === sessionId ? update(session) : session
    )),
  }
}

function testReducer(state, action) {
  const activeId = state.activeSessionId
  if (action.type === 'CLEAR_CURRENT_SESSION') {
    return replaceSession(state, activeId, (session) => ({ ...session, messages: [] }))
  }
  if (action.type === 'DELETE_MESSAGE') {
    return replaceSession(state, activeId, (session) => ({
      ...session,
      messages: session.messages.filter((message) => message.id !== action.payload),
    }))
  }
  if (action.type === 'COMPRESS_CURRENT_SESSION') {
    return replaceSession(state, activeId, (session) => ({
      ...session,
      messages: session.messages.slice(-1),
    }))
  }
  if (action.type === 'COMPACT_SESSION') {
    const sessionId = action.payload?.sessionId || activeId
    return replaceSession(state, sessionId, (session) => ({ ...session, messages: action.payload.messages }))
  }
  if (action.type === 'EXPAND_COMPACTED') {
    const sessionId = action.payload?.sessionId || activeId
    return replaceSession(state, sessionId, (session) => ({
      ...session,
      messages: session.messages.flatMap((message) => (
        message.meta?.archiveId === action.payload.archiveId
          ? action.payload.archivedMessages
          : [message]
      )),
    }))
  }
  if (action.type === 'DELETE_SESSION' || action.type === 'APPLY_SERVER_SESSION_DELETE') {
    const sessionId = action.type === 'DELETE_SESSION' ? action.payload : action.payload.sessionId
    return { ...state, sessions: state.sessions.filter((session) => session.id !== sessionId) }
  }
  if (action.type === 'APPLY_SERVER_SESSION_MESSAGES') {
    const { sessionId, messages, revision } = action.payload
    return replaceSession(state, sessionId, (session) => ({
      ...session,
      messages,
      serverRevision: revision,
    }))
  }
  return state
}

function createState({ synced = true } = {}) {
  return {
    activeSessionId: 's1',
    sessions: [{
      id: 's1',
      ...(synced ? { serverRevision: 1 } : {}),
      messages: [
        { id: 'm1', role: 'user', content: 'one' },
        { id: 'm2', role: 'assistant', content: 'two' },
      ],
    }],
  }
}

test('session mutation classification and target resolution cover every destructive action', () => {
  const types = [
    'DELETE_SESSION',
    'CLEAR_CURRENT_SESSION',
    'DELETE_MESSAGE',
    'COMPRESS_CURRENT_SESSION',
    'COMPACT_SESSION',
    'EXPAND_COMPACTED',
  ]
  for (const type of types) assert.equal(isServerSessionMutation({ type }), true, type)
  assert.equal(isServerSessionMutation({ type: 'SEND_MESSAGE' }), false)

  const state = createState()
  assert.equal(resolveSessionMutationTarget(state, { type: 'CLEAR_CURRENT_SESSION' }), 's1')
  assert.equal(resolveSessionMutationTarget(state, { type: 'DELETE_SESSION', payload: 'other' }), 'other')
  assert.equal(resolveSessionMutationTarget(state, {
    type: 'COMPACT_SESSION',
    payload: { sessionId: 'explicit', messages: [] },
  }), 'explicit')
})

test('projectSessionMutation derives exact replacement messages without mutating input state', () => {
  const state = createState()
  const plan = projectSessionMutation({
    state,
    sessionId: 's1',
    action: { type: 'DELETE_MESSAGE', payload: 'm1' },
    reduceState: testReducer,
  })

  assert.equal(plan.kind, 'replace')
  assert.equal(plan.expectedRevision, 1)
  assert.deepEqual(plan.messages.map((message) => message.id), ['m2'])
  assert.deepEqual(state.sessions[0].messages.map((message) => message.id), ['m1', 'm2'])
})

test('server snapshots replace canonical text while retaining local rendering metadata', () => {
  const localMessages = [{
    id: 'assistant-1',
    role: 'assistant',
    content: 'partial',
    timestamp: 10,
    attachments: [{ name: 'preview.png' }],
    meta: {
      streaming: true,
      reasoning: 'local reasoning',
      toolCalls: [{ id: 'call-1', textOffset: 4 }],
      serverArtifacts: [{ id: 'artifact-1' }],
    },
  }]
  const merged = mergeServerSessionMessages(localMessages, [{
    id: 'assistant-1',
    role: 'assistant',
    content: 'complete server text',
    timestamp: 20,
    meta: {
      serverTurnId: 'turn-1',
      streaming: false,
      serverAuthoritative: true,
      toolCalls: [{ id: 'call-1' }],
    },
  }])

  assert.equal(merged[0].content, 'complete server text')
  assert.equal(merged[0].timestamp, 20)
  assert.deepEqual(merged[0].attachments, [{ name: 'preview.png' }])
  assert.equal(merged[0].meta.reasoning, 'local reasoning')
  assert.deepEqual(merged[0].meta.toolCalls, [{ id: 'call-1', textOffset: 4 }])
  assert.deepEqual(merged[0].meta.serverArtifacts, [{ id: 'artifact-1' }])
  assert.equal(merged[0].meta.serverTurnId, 'turn-1')
  assert.equal(merged[0].meta.streaming, false)
  assert.equal(merged[0].meta.serverAuthoritative, true)
})

test('server-backed mutations are pessimistic and serialized with the latest revision', async () => {
  let state = createState()
  const requests = []
  let finishFirstRequest
  const firstRequest = new Promise((resolve) => { finishFirstRequest = resolve })
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    replaceMessages: async (request) => {
      requests.push(request)
      if (requests.length === 1) return firstRequest
      return { ok: true, revision: 3 }
    },
    deleteSession: async () => ({ ok: true }),
  })

  const first = dispatch({ type: 'DELETE_MESSAGE', payload: 'm1' })
  const second = dispatch({ type: 'CLEAR_CURRENT_SESSION' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(requests.length, 1)
  assert.deepEqual(state.sessions[0].messages.map((message) => message.id), ['m1', 'm2'])

  finishFirstRequest({ ok: true, revision: 2 })
  await first
  await second

  assert.equal(requests.length, 2)
  assert.equal(requests[0].expectedRevision, 1)
  assert.deepEqual(requests[0].messages.map((message) => message.id), ['m2'])
  assert.equal(requests[1].expectedRevision, 2)
  assert.deepEqual(requests[1].messages, [])
  assert.equal(state.sessions[0].serverRevision, 3)
  assert.deepEqual(state.sessions[0].messages, [])
})

test('failed server-backed mutation preserves local state', async () => {
  let state = createState()
  const original = structuredClone(state)
  const failures = []
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    replaceMessages: async () => {
      const error = new Error('conflict')
      error.code = 'SESSION_REVISION_CONFLICT'
      throw error
    },
    deleteSession: async () => ({ ok: true }),
    onError: (error) => failures.push(error.code),
  })

  const result = await dispatch({ type: 'CLEAR_CURRENT_SESSION' })
  assert.equal(result, false)
  assert.deepEqual(state, original)
  assert.deepEqual(failures, ['SESSION_REVISION_CONFLICT'])
})

test('local-only sessions retain immediate reducer behavior', () => {
  let state = createState({ synced: false })
  let remoteCalls = 0
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    replaceMessages: async () => { remoteCalls += 1; return { revision: 1 } },
    deleteSession: async () => { remoteCalls += 1; return { ok: true } },
  })

  const result = dispatch({ type: 'CLEAR_CURRENT_SESSION' })
  assert.equal(result, undefined)
  assert.deepEqual(state.sessions[0].messages, [])
  assert.equal(remoteCalls, 0)
})

test('server-backed deletion waits for success before removing the local session', async () => {
  let state = createState()
  let finishDelete
  const pendingDelete = new Promise((resolve) => { finishDelete = resolve })
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    replaceMessages: async () => ({ revision: 2 }),
    deleteSession: () => pendingDelete,
  })

  const operation = dispatch({ type: 'DELETE_SESSION', payload: 's1' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.sessions.length, 1)
  finishDelete({ ok: true })
  await operation
  assert.equal(state.sessions.length, 0)
})
