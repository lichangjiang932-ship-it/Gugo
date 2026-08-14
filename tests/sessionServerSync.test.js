import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSessionMutationDispatcher,
  isServerSessionMutation,
  mergeServerSessionMessages,
  needsServerSessionSnapshot,
  needsServerTranscriptHydration,
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
  if (action.type === 'SWITCH_SESSION') {
    return { ...state, activeSessionId: action.payload }
  }
  if (action.type === 'APPLY_SERVER_SESSION_SNAPSHOT') {
    const { sessionId, snapshot } = action.payload
    return replaceSession(state, sessionId, (session) => (
      snapshot.revision < (Number(session.serverRevision) || 0)
        ? session
        : { ...session, messages: snapshot.messages, serverRevision: snapshot.revision }
    ))
  }
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
  if (action.type === 'APPLY_SERVER_SESSION_METADATA') {
    const { sessionId, session: metadata } = action.payload
    return replaceSession(state, sessionId, (session) => ({
      ...session,
      serverRevision: metadata.revision,
      ...(Object.prototype.hasOwnProperty.call(metadata, 'archivedAt')
        ? { archivedAt: metadata.archivedAt }
        : {}),
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

test('server snapshot artifacts replace empty or partial local artifact lists', () => {
  const serverArtifacts = [
    { id: 'artifact-1', filename: 'report.docx', url: '/api/artifacts/report.docx' },
    { id: 'artifact-2', filename: 'table.xlsx', url: '/api/artifacts/table.xlsx' },
  ]

  for (const localArtifacts of [[], [serverArtifacts[0]]]) {
    const [merged] = mergeServerSessionMessages(
      [{
        id: 'assistant-1',
        role: 'assistant',
        content: 'done',
        meta: { streaming: false, serverArtifacts: localArtifacts },
      }],
      [{
        id: 'assistant-1',
        role: 'assistant',
        content: 'done',
        meta: { serverAuthoritative: true, serverArtifacts },
      }],
    )

    assert.deepEqual(merged.meta.serverArtifacts, serverArtifacts)
  }
})

test('an authoritative artifact change clears a stale local delivery when the snapshot omits the field', () => {
  const draft = { id: 'draft', filename: 'draft.pdf', url: '/api/artifacts/draft' }
  const final = { id: 'final', filename: 'final.pdf', url: '/api/artifacts/final' }
  const local = [{
    id: 'assistant-delivery',
    role: 'assistant',
    content: 'done',
    meta: {
      serverArtifacts: [draft],
      serverDeliveryArtifactIds: ['draft'],
    },
  }]

  const [changed] = mergeServerSessionMessages(local, [{
    id: 'assistant-delivery',
    role: 'assistant',
    content: 'done',
    meta: { serverAuthoritative: true, serverArtifacts: [draft, final] },
  }])
  assert.ok(Object.hasOwn(changed.meta, 'serverDeliveryArtifactIds'))
  assert.deepEqual(changed.meta.serverDeliveryArtifactIds, [])

  const [unchanged] = mergeServerSessionMessages(local, [{
    id: 'assistant-delivery',
    role: 'assistant',
    content: 'done',
    meta: { serverAuthoritative: true, serverArtifacts: [draft] },
  }])
  assert.deepEqual(unchanged.meta.serverDeliveryArtifactIds, ['draft'])
})

test('a paused server snapshot keeps its directory request when local streaming metadata is stale', () => {
  const clarification = {
    question: 'Please choose and authorize a directory so this task can continue.',
    request_type: 'directory',
    access_mode: 'read_write',
    suggested_path: 'D:\\destok',
  }
  const [merged] = mergeServerSessionMessages(
    [{
      id: 'turn-1:assistant',
      role: 'assistant',
      content: 'Please choose and authorize a directory so this task can continue.',
      meta: {
        streaming: true,
        serverTurnId: 'turn-1',
        serverLastSequence: 6,
        serverConnectionState: 'connected',
        serverClarification: null,
      },
    }],
    [{
      id: 'turn-1:assistant',
      role: 'assistant',
      content: 'Please choose and authorize a directory so this task can continue.',
      meta: {
        streaming: false,
        paused: true,
        serverTurnId: 'turn-1',
        serverLastSequence: 7,
        serverConnectionState: 'paused',
        serverClarification: clarification,
        directoryAuthorizationPending: false,
        serverResumeResolution: null,
      },
    }],
  )

  assert.equal(merged.meta.paused, true)
  assert.equal(merged.meta.streaming, false)
  assert.equal(merged.meta.serverConnectionState, 'paused')
  assert.equal(merged.meta.serverLastSequence, 7)
  assert.deepEqual(merged.meta.serverClarification, clarification)
  assert.equal(merged.meta.serverClarification.request_type, 'directory')
})

test('a paused snapshot does not roll an in-flight directory authorization back to waiting', () => {
  const resolution = {
    type: 'directory_authorization',
    path: 'D:\\destok',
    access_mode: 'read_write',
    paused_sequence: 7,
  }
  const [merged] = mergeServerSessionMessages(
    [{
      id: 'turn-1:assistant',
      role: 'assistant',
      content: 'Please choose and authorize a directory so this task can continue.',
      meta: {
        streaming: true,
        paused: false,
        serverTurnId: 'turn-1',
        serverLastSequence: 7,
        serverConnectionState: 'reconnecting',
        serverClarification: null,
        directoryAuthorizationPending: true,
        serverResumeResolution: resolution,
      },
    }],
    [{
      id: 'turn-1:assistant',
      role: 'assistant',
      content: 'Please choose and authorize a directory so this task can continue.',
      meta: {
        streaming: false,
        paused: true,
        serverTurnId: 'turn-1',
        serverLastSequence: 7,
        serverConnectionState: 'paused',
        serverClarification: {
          request_type: 'directory',
          access_mode: 'read_write',
          suggested_path: 'D:\\destok',
        },
        directoryAuthorizationPending: false,
        serverResumeResolution: null,
      },
    }],
  )

  assert.equal(merged.meta.streaming, true)
  assert.equal(merged.meta.paused, false)
  assert.equal(merged.meta.serverConnectionState, 'reconnecting')
  assert.equal(merged.meta.directoryAuthorizationPending, true)
  assert.deepEqual(merged.meta.serverResumeResolution, resolution)
  assert.equal(merged.meta.serverClarification.request_type, 'directory')
})

test('an empty completion snapshot cannot erase assistant text already received from the stream', () => {
  const [merged] = mergeServerSessionMessages(
    [{ id: 'assistant-1', role: 'assistant', content: 'Done. Your file is ready.', meta: { streaming: true } }],
    [{ id: 'assistant-1', role: 'assistant', content: '', meta: { streaming: false, serverAuthoritative: true } }],
  )

  assert.equal(merged.content, 'Done. Your file is ready.')
  assert.equal(merged.meta.streaming, false)
})

test('recovery stubs stay resumable until a real server assistant replaces them', () => {
  const local = [{
    id: 'turn-1:assistant',
    role: 'assistant',
    content: 'partial',
    meta: { streaming: true, serverTurnId: 'turn-1', serverLastSequence: 7 },
  }]
  const [recoverable] = mergeServerSessionMessages(local, [{
    id: 'turn-1:assistant',
    role: 'assistant',
    content: '',
    meta: {
      streaming: true,
      serverTurnId: 'turn-1',
      serverLastSequence: -1,
      serverRecoveryStub: true,
    },
  }])
  assert.equal(recoverable.content, 'partial')
  assert.equal(recoverable.meta.streaming, true)
  assert.equal(recoverable.meta.serverLastSequence, 7)
  assert.equal(recoverable.meta.serverRecoveryStub, true)

  const [completed] = mergeServerSessionMessages([recoverable], [{
    id: 'turn-1:assistant',
    role: 'assistant',
    content: 'complete',
    meta: { streaming: false, serverTurnId: 'turn-1', serverAuthoritative: true },
  }])
  assert.equal(completed.content, 'complete')
  assert.equal(completed.meta.streaming, false)
  assert.equal(completed.meta.serverRecoveryStub, undefined)
})

test('a server session containing only an active-turn stub still requires transcript hydration', () => {
  const session = {
    id: 's1',
    serverRevision: 7,
    messages: [{
      id: 'turn-1:assistant',
      role: 'assistant',
      content: '',
      meta: { streaming: true, serverTurnId: 'turn-1', serverLastSequence: -1 },
    }],
  }
  assert.equal(needsServerTranscriptHydration(session), true)
  assert.equal(needsServerSessionSnapshot(session, null), true)
  assert.equal(needsServerSessionSnapshot(session, 7), false)
  assert.equal(needsServerTranscriptHydration({ ...session, messages: [{ id: 'history', role: 'user' }] }), false)
})

test('selecting an empty server-backed session hydrates its transcript once per revision', async () => {
  let state = {
    activeSessionId: null,
    sessions: [{ id: 's1', serverRevision: 7, messages: [] }],
  }
  let finishSnapshot
  let snapshotRequests = 0
  const pendingSnapshot = new Promise((resolve) => { finishSnapshot = resolve })
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    fetchSessionSnapshot: async () => {
      snapshotRequests += 1
      return pendingSnapshot
    },
    replaceMessages: async () => ({ revision: 8 }),
    deleteSession: async () => ({ ok: true }),
  })

  const first = dispatch({ type: 'SWITCH_SESSION', payload: 's1' })
  const second = dispatch({ type: 'SWITCH_SESSION', payload: 's1' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(state.activeSessionId, 's1')
  assert.equal(snapshotRequests, 1)
  assert.deepEqual(state.sessions[0].messages, [])

  finishSnapshot({
    complete: true,
    revision: 7,
    messages: [{ id: 'm1', role: 'user', content: 'restored' }],
  })
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(state.sessions[0].messages[0].content, 'restored')

  assert.equal(dispatch({ type: 'SWITCH_SESSION', payload: 's1' }), undefined)
  assert.equal(snapshotRequests, 1)

  state = replaceSession(state, 's1', (session) => ({ ...session, messages: [] }))
  assert.equal(await dispatch({
    type: 'HYDRATE_SERVER_SESSION',
    payload: { sessionId: 's1', revision: 7 },
  }), true)
  assert.equal(snapshotRequests, 2)
  assert.equal(state.sessions[0].messages[0].content, 'restored')
})

test('startup hydration restores the active transcript without dispatching a session switch', async () => {
  let state = {
    activeSessionId: 's1',
    sessions: [{ id: 's1', serverRevision: 3, messages: [] }],
  }
  const immediateActions = []
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => {
      immediateActions.push(action.type)
      state = testReducer(state, action)
    },
    applyServerAction: (action) => { state = testReducer(state, action) },
    fetchSessionSnapshot: async () => ({
      complete: true,
      revision: 3,
      messages: [{ id: 'm1', role: 'assistant', content: 'ready on launch' }],
    }),
    replaceMessages: async () => ({ revision: 4 }),
    deleteSession: async () => ({ ok: true }),
  })

  assert.equal(await dispatch({ type: 'HYDRATE_SERVER_SESSION', payload: 's1' }), true)
  assert.deepEqual(immediateActions, [])
  assert.equal(state.activeSessionId, 's1')
  assert.equal(state.sessions[0].messages[0].content, 'ready on launch')
})

test('session selection does not request a server snapshot without authentication', () => {
  let state = {
    activeSessionId: null,
    sessions: [{ id: 's1', serverRevision: 2, messages: [] }],
  }
  let snapshotRequests = 0
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    canFetchSessionSnapshot: () => false,
    fetchSessionSnapshot: async () => { snapshotRequests += 1; return null },
    replaceMessages: async () => ({ revision: 3 }),
    deleteSession: async () => ({ ok: true }),
  })

  assert.equal(dispatch({ type: 'SWITCH_SESSION', payload: 's1' }), undefined)
  assert.equal(state.activeSessionId, 's1')
  assert.equal(snapshotRequests, 0)
})

test('a lagging server snapshot cannot erase optimistic messages from the active turn', () => {
  const localMessages = [
    { id: 'turn-1:user', role: 'user', content: 'hello', timestamp: 10, meta: { pendingServerSync: true } },
    { id: 'turn-1:assistant', role: 'assistant', content: '', timestamp: 11, meta: { streaming: true } },
  ]
  assert.deepEqual(
    mergeServerSessionMessages(localMessages, []).map((message) => message.id),
    ['turn-1:user', 'turn-1:assistant'],
  )
  const merged = mergeServerSessionMessages(localMessages, [{
    id: 'turn-1:user', role: 'user', content: 'hello', timestamp: 10,
  }])
  assert.equal(merged[0].meta?.pendingServerSync, undefined)
  assert.equal(merged[1].id, 'turn-1:assistant')
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

test('upgraded sessions probe server revision before replacing messages', async () => {
  let state = createState({ synced: false })
  const requests = []
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    resolveSessionMetadata: async () => ({ id: 's1', revision: 7 }),
    replaceMessages: async (request) => { requests.push(request); return { revision: 8 } },
    deleteSession: async () => ({ ok: true }),
  })

  await dispatch({ type: 'CLEAR_CURRENT_SESSION' })
  assert.equal(requests[0].expectedRevision, 7)
  assert.deepEqual(requests[0].messages, [])
  assert.equal(state.sessions[0].serverRevision, 8)
})

test('unknown sessions fall back to local mutation only after a server 404 probe', async () => {
  let state = createState({ synced: false })
  let remoteCalls = 0
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    resolveSessionMetadata: async () => null,
    replaceMessages: async () => { remoteCalls += 1; return { revision: 1 } },
    deleteSession: async () => { remoteCalls += 1; return { ok: true } },
  })

  await dispatch({ type: 'CLEAR_CURRENT_SESSION' })
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
