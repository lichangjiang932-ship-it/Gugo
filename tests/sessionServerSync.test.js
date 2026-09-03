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
import { buildMessageTimeline } from '../src/lib/messageTimeline.js'
import {
  reconcileServerSessionCatalog,
  reduceServerSessionState,
} from '../src/store/reducers/serverSessionReducer.js'

test('server session catalog makes browser histories converge without dropping local drafts', () => {
  const state = {
    activeSessionId: 'removed-server-session',
    sessionDrafts: {
      'local-draft': 'keep',
      'removed-server-session': 'drop',
    },
    sessions: [
      {
        id: 'local-draft',
        title: 'Unsynced draft',
        messages: [],
        createdAt: 30,
        updatedAt: 30,
      },
      {
        id: 'known-session',
        title: 'Old browser title',
        messages: [{ id: 'pending', role: 'assistant', content: '', meta: { streaming: true } }],
        serverRevision: 2,
        createdAt: 10,
        updatedAt: 20,
      },
      {
        id: 'removed-server-session',
        title: 'Deleted elsewhere',
        messages: [],
        serverRevision: 1,
        createdAt: 5,
        updatedAt: 5,
      },
    ],
  }

  const result = reconcileServerSessionCatalog(state, [
    {
      id: 'known-session',
      title: 'Canonical title',
      revision: 3,
      createdAt: 10,
      updatedAt: 40,
      lastViewedAt: 35,
      archivedAt: null,
      pinnedAt: 39,
      parentSessionId: null,
      branchLabel: null,
      forkedAt: null,
    },
    {
      id: 'new-from-other-browser',
      title: 'Other browser chat',
      revision: 1,
      createdAt: 25,
      updatedAt: 25,
      lastViewedAt: null,
      archivedAt: null,
      pinnedAt: null,
      parentSessionId: null,
      branchLabel: null,
      forkedAt: null,
    },
  ], { preserveLocalOnly: true })

  assert.deepEqual(result.sessions.map(({ id }) => id), [
    'local-draft',
    'known-session',
    'new-from-other-browser',
  ])
  assert.equal(result.activeSessionId, 'local-draft')
  assert.deepEqual(result.sessionDrafts, { 'local-draft': 'keep' })
  assert.equal(result.sessions[1].title, 'Canonical title')
  assert.equal(result.sessions[1].serverRevision, 3)
  assert.equal(result.sessions[1].messages[0].id, 'pending')
  assert.equal(result.sessions[1].serverTranscriptStale, true)
  assert.deepEqual(result.sessions[2].messages, [])
})

test('server workspace metadata restores canonical paths and removes stale browser-local paths', () => {
  const state = {
    activeSessionId: 'session-1',
    sessionDrafts: {},
    sessions: [{
      id: 'session-1',
      messages: [{ id: 'message-1', role: 'user', content: 'keep' }],
      workspacePath: 'C:\\BrowserOnly',
      serverRevision: 5,
    }],
  }
  const restored = reconcileServerSessionCatalog(state, [{
    id: 'session-1',
    title: 'Canonical',
    revision: 5,
    workspacePath: 'C:\\Canonical',
  }])
  assert.equal(restored.sessions[0].workspacePath, 'C:\\Canonical')
  assert.equal(restored.sessions[0].messages.length, 1)

  const cleared = reduceServerSessionState(restored, {
    type: 'APPLY_SERVER_SESSION_METADATA',
    payload: {
      sessionId: 'session-1',
      session: { id: 'session-1', revision: 5, workspacePath: null },
    },
  })
  assert.equal(Object.hasOwn(cleared.sessions[0], 'workspacePath'), false)

  const snapshotCleared = reduceServerSessionState(restored, {
    type: 'APPLY_SERVER_SESSION_SNAPSHOT',
    payload: {
      sessionId: 'session-1',
      snapshot: {
        complete: true,
        revision: 5,
        messages: [],
        session: { id: 'session-1', revision: 5, workspacePath: null },
      },
    },
  })
  assert.equal(Object.hasOwn(snapshotCleared.sessions[0], 'workspacePath'), false)
})

test('a newer catalog revision preserves an active local stream until terminal hydration', () => {
  const messages = [
    { id: 'old-user', role: 'user', content: 'earlier' },
    { id: 'turn:user', role: 'user', content: 'new', meta: { pendingServerSync: true } },
    { id: 'turn:assistant', role: 'assistant', content: 'partial', meta: { streaming: true } },
  ]
  const result = reconcileServerSessionCatalog({
    activeSessionId: 'session-1',
    sessionDrafts: {},
    sessions: [{ id: 'session-1', serverRevision: 4, messages }],
  }, [{ id: 'session-1', title: 'Canonical', revision: 6 }])

  assert.equal(result.sessions[0].serverRevision, 6)
  assert.deepEqual(result.sessions[0].messages, messages)
  assert.equal(result.sessions[0].serverTranscriptStale, true)
})

test('a protected matching catalog session keeps its pending transcript before revision acknowledgement', () => {
  const messages = [
    { id: 'turn:user', role: 'user', content: 'new', meta: { pendingServerSync: true } },
    { id: 'turn:assistant', role: 'assistant', content: 'partial', meta: { streaming: true } },
  ]
  const result = reconcileServerSessionCatalog({
    activeSessionId: 'foreground-session',
    sessionDrafts: {},
    sessions: [
      { id: 'foreground-session', serverRevision: 2, messages: [] },
      { id: 'pending-background-session', messages },
    ],
  }, [
    { id: 'foreground-session', title: 'Foreground', revision: 2 },
    { id: 'pending-background-session', title: 'Pending', revision: 1 },
  ], { preserveSessionIds: ['pending-background-session'] })

  const pending = result.sessions.find((session) => session.id === 'pending-background-session')
  assert.equal(pending.serverRevision, 1)
  assert.deepEqual(pending.messages, messages)
})

test('an event-only catalog advance preserves a pending background transcript', () => {
  const messages = [
    { id: 'turn:user', role: 'user', content: 'new', meta: { pendingServerSync: true } },
    { id: 'turn:assistant', role: 'assistant', content: 'partial', meta: { streaming: true } },
  ]
  const result = reconcileServerSessionCatalog({
    activeSessionId: 'foreground-session',
    sessionDrafts: {},
    sessions: [
      { id: 'foreground-session', serverRevision: 2, serverTurnEventRevision: 3, messages: [] },
      { id: 'background-session', serverRevision: 5, serverTurnEventRevision: 10, messages },
    ],
  }, [
    { id: 'foreground-session', title: 'Foreground', revision: 2, turnEventRevision: 3 },
    { id: 'background-session', title: 'Background', revision: 5, turnEventRevision: 11 },
  ])

  const background = result.sessions.find((session) => session.id === 'background-session')
  assert.equal(background.serverTurnEventRevision, 11)
  assert.deepEqual(background.messages, messages)
  assert.equal(background.serverTranscriptStale, true)
})

test('a terminal transcript revision retains pending background rows until snapshot hydration', () => {
  const state = reconcileServerSessionCatalog({
    activeSessionId: 'foreground-session',
    sessionDrafts: {},
    sessions: [
      { id: 'foreground-session', serverRevision: 2, serverTurnEventRevision: 3, messages: [] },
      {
        id: 'background-session',
        serverRevision: 5,
        serverTurnEventRevision: 10,
        messages: [
          { id: 'turn:user', role: 'user', content: 'new', meta: { pendingServerSync: true } },
          { id: 'turn:assistant', role: 'assistant', content: 'stale partial', meta: { streaming: true } },
        ],
      },
    ],
  }, [
    { id: 'foreground-session', title: 'Foreground', revision: 2, turnEventRevision: 3 },
    { id: 'background-session', title: 'Background', revision: 6, turnEventRevision: 12 },
  ])

  const background = state.sessions.find((session) => session.id === 'background-session')
  assert.equal(background.serverRevision, 6)
  assert.equal(background.serverTurnEventRevision, 12)
  assert.equal(background.messages.at(-1).content, 'stale partial')
  assert.equal(background.serverTranscriptStale, true)
  assert.equal(needsServerTranscriptHydration(background), true)

  const hydrated = reduceServerSessionState(state, {
    type: 'APPLY_SERVER_SESSION_SNAPSHOT',
    payload: {
      sessionId: 'background-session',
      snapshot: {
        complete: true,
        revision: 6,
        turnEventRevision: 12,
        messages: [
          { id: 'turn:user', role: 'user', content: 'new', meta: {} },
          { id: 'turn:assistant', role: 'assistant', content: 'final', meta: { streaming: false } },
        ],
      },
    },
  })
  const canonical = hydrated.sessions.find((session) => session.id === 'background-session')
  assert.equal(canonical.messages.at(-1).content, 'final')
  assert.equal(canonical.messages.at(-1).meta.streaming, false)
  assert.equal(Object.hasOwn(canonical, 'serverTranscriptStale'), false)
})

test('a newer catalog revision invalidates a stale completed transcript', () => {
  const result = reconcileServerSessionCatalog({
    activeSessionId: 'session-1',
    sessionDrafts: {},
    sessions: [{
      id: 'session-1',
      serverRevision: 4,
      messages: [{ id: 'old', role: 'assistant', content: 'stale' }],
    }],
  }, [{ id: 'session-1', title: 'Canonical', revision: 5 }])

  assert.equal(result.sessions[0].serverRevision, 5)
  assert.deepEqual(result.sessions[0].messages, [])
})

test('a newer turn-event watermark invalidates a stale transcript at the same message revision', () => {
  const result = reconcileServerSessionCatalog({
    activeSessionId: 'session-1',
    sessionDrafts: {},
    sessions: [{
      id: 'session-1',
      serverRevision: 5,
      serverTurnEventRevision: 10,
      messages: [{ id: 'old', role: 'assistant', content: 'still running' }],
    }],
  }, [{
    id: 'session-1',
    title: 'Canonical',
    revision: 5,
    turnEventRevision: 11,
  }])

  assert.equal(result.sessions[0].serverRevision, 5)
  assert.equal(result.sessions[0].serverTurnEventRevision, 11)
  assert.deepEqual(result.sessions[0].messages, [])
})

test('catalog preserves the transcript just imported by this browser at its canonical revision', () => {
  const result = reconcileServerSessionCatalog({
    activeSessionId: 'just-imported',
    sessionDrafts: {},
    sessions: [{
      id: 'just-imported',
      title: 'Local title',
      updatedAt: 999,
      messages: [{ id: 'local-history', role: 'user', content: 'keep' }],
    }],
  }, [{
    id: 'just-imported',
    title: 'Canonical title',
    revision: 1,
    createdAt: 10,
    updatedAt: 20,
  }], {
    preserveLocalOnly: true,
    importedSessionIds: ['just-imported'],
  })

  assert.equal(result.sessions[0].messages[0].id, 'local-history')
  assert.equal(result.sessions[0].serverRevision, 1)
  assert.equal(result.sessions[0].updatedAt, 20)
})

test('catalog remaps a recovered legacy session and hydrates its re-keyed transcript', () => {
  const result = reconcileServerSessionCatalog({
    activeSessionId: 'occupied-id',
    sessionDrafts: { 'occupied-id': 'keep this draft' },
    sessions: [{
      id: 'occupied-id',
      title: 'Local recovered history',
      messages: [{ id: 'old-message-id', role: 'user', content: 'must survive' }],
    }],
  }, [{
    id: 'legacy-recovery-stable',
    title: 'Local recovered history',
    revision: 0,
    createdAt: 10,
    updatedAt: 20,
  }], {
    importedSessionIds: ['legacy-recovery-stable'],
    legacySessionIdMappings: [{
      sourceSessionId: 'occupied-id',
      sessionId: 'legacy-recovery-stable',
    }],
  })

  assert.equal(result.activeSessionId, 'legacy-recovery-stable')
  assert.deepEqual(result.sessionDrafts, { 'legacy-recovery-stable': 'keep this draft' })
  assert.equal(result.sessions[0].id, 'legacy-recovery-stable')
  assert.equal(result.sessions[0].serverRevision, 0)
  assert.deepEqual(result.sessions[0].messages, [])
})

test('multi-user session catalog does not retain browser-local sessions from another account', () => {
  const result = reconcileServerSessionCatalog({
    activeSessionId: 'local-only',
    sessionDrafts: { 'local-only': 'private draft' },
    sessions: [{ id: 'local-only', messages: [] }],
  }, [{
    id: 'server-owned',
    title: 'Server owned',
    revision: 4,
    createdAt: 10,
    updatedAt: 11,
  }])

  assert.deepEqual(result.sessions.map(({ id }) => id), ['server-owned'])
  assert.equal(result.activeSessionId, 'server-owned')
  assert.deepEqual(result.sessionDrafts, {})
})

test('background catalog refresh protects only explicitly pending local sessions', () => {
  const result = reconcileServerSessionCatalog({
    activeSessionId: 'pending-local',
    sessionDrafts: {
      'pending-local': 'keep until acknowledged',
      'stale-local': 'remove across account catalog refresh',
    },
    sessions: [
      { id: 'pending-local', messages: [{ meta: { pendingServerSync: true } }] },
      { id: 'stale-local', messages: [] },
      { id: 'deleted-server-session', serverRevision: 2, messages: [] },
    ],
  }, [], { preserveSessionIds: ['pending-local'] })

  assert.deepEqual(result.sessions.map(({ id }) => id), ['pending-local'])
  assert.equal(result.activeSessionId, 'pending-local')
  assert.deepEqual(result.sessionDrafts, { 'pending-local': 'keep until acknowledged' })
})

test('independent browser stores converge on the same server Session directory', () => {
  const catalog = [
    { id: 'from-browser-a', title: 'A', revision: 1, createdAt: 10, updatedAt: 11 },
    { id: 'from-browser-b', title: 'B', revision: 2, createdAt: 20, updatedAt: 21 },
  ]
  const browserA = reconcileServerSessionCatalog({
    activeSessionId: 'from-browser-a',
    sessionDrafts: {},
    sessions: [{
      id: 'from-browser-a',
      title: 'A local',
      messages: [{ id: 'a-message', role: 'user', content: 'a' }],
    }],
  }, catalog, { preserveLocalOnly: true })
  const browserB = reconcileServerSessionCatalog({
    activeSessionId: 'from-browser-b',
    sessionDrafts: {},
    sessions: [{
      id: 'from-browser-b',
      title: 'B local',
      messages: [{ id: 'b-message', role: 'user', content: 'b' }],
    }],
  }, catalog, { preserveLocalOnly: true })

  assert.deepEqual(browserA.sessions.map(({ id }) => id), ['from-browser-a', 'from-browser-b'])
  assert.deepEqual(browserB.sessions.map(({ id }) => id), ['from-browser-a', 'from-browser-b'])
  assert.deepEqual(browserA.sessions.map(({ serverRevision }) => serverRevision), [1, 2])
  assert.deepEqual(browserB.sessions.map(({ serverRevision }) => serverRevision), [1, 2])
})

test('catalog reconciliation records a visible mismatch when backend or workspace scope changes', () => {
  const previous = {
    version: 1,
    backendInstanceId: 'sqlite:one',
    workspaceScope: { key: 'workspace:one', path: 'D:\\one' },
  }
  const current = {
    version: 1,
    backendInstanceId: 'sqlite:two',
    workspaceScope: { key: 'workspace:one', path: 'D:\\one' },
  }
  const state = reduceServerSessionState({
    activeSessionId: null,
    sessionCatalogSource: previous,
    sessionCatalogSourceMismatch: null,
    sessionDrafts: {},
    sessions: [],
  }, {
    type: 'RECONCILE_SERVER_SESSION_CATALOG',
    payload: { sessions: [], source: current },
  })

  assert.deepEqual(state.sessionCatalogSource, current)
  assert.deepEqual(state.sessionCatalogSourceMismatch, { previous, current })
})

test('catalog reconciliation clears staged legacy history only with an explicit success signal', () => {
  const pendingLegacySessions = [{ id: 'legacy', messages: [{ id: 'message', content: 'keep' }] }]
  const base = {
    activeSessionId: null,
    pendingLegacySessions,
    sessionDrafts: {},
    sessions: [],
  }
  const retained = reduceServerSessionState(base, {
    type: 'RECONCILE_SERVER_SESSION_CATALOG',
    payload: { sessions: [] },
  })
  assert.strictEqual(retained.pendingLegacySessions, pendingLegacySessions)

  const cleared = reduceServerSessionState(base, {
    type: 'RECONCILE_SERVER_SESSION_CATALOG',
    payload: { sessions: [], clearPendingLegacySessions: true },
  })
  assert.deepEqual(cleared.pendingLegacySessions, [])
})

test('server-authoritative ids remove invisible owner collisions from the local catalog', () => {
  const result = reconcileServerSessionCatalog({
    activeSessionId: 'occupied-by-server',
    sessionDrafts: { 'occupied-by-server': 'must not shadow the server id' },
    sessions: [{
      id: 'occupied-by-server',
      title: 'Browser copy',
      messages: [{ id: 'local-message', role: 'user', content: 'local' }],
    }],
  }, [], {
    preserveLocalOnly: true,
    serverAuthoritativeIds: ['occupied-by-server'],
  })

  assert.deepEqual(result.sessions, [])
  assert.equal(result.activeSessionId, null)
  assert.deepEqual(result.sessionDrafts, {})
})

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
  if (action.type === 'TRUNCATE_MESSAGES') {
    return replaceSession(state, activeId, (session) => ({
      ...session,
      messages: session.messages.slice(0, Math.max(0, Number(action.payload) || 0)),
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
    'TRUNCATE_MESSAGES',
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
  assert.deepEqual(plan.sourceMessages.map((message) => message.id), ['m1', 'm2'])
  assert.deepEqual(plan.messages.map((message) => message.id), ['m2'])
  assert.deepEqual(state.sessions[0].messages.map((message) => message.id), ['m1', 'm2'])
})

test('projectSessionMutation synchronizes an exact transcript truncation', () => {
  const state = createState()
  const plan = projectSessionMutation({
    state,
    sessionId: 's1',
    action: { type: 'TRUNCATE_MESSAGES', payload: 1 },
    reduceState: testReducer,
  })

  assert.equal(plan.kind, 'replace')
  assert.equal(plan.expectedRevision, 1)
  assert.deepEqual(plan.messages.map((message) => message.id), ['m1'])
  assert.deepEqual(state.sessions[0].messages.map((message) => message.id), ['m1', 'm2'])
})

test('server snapshots replace canonical text without retaining stale tool offsets', () => {
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
  assert.deepEqual(merged[0].meta.toolCalls, [{ id: 'call-1' }])
  assert.deepEqual(merged[0].meta.serverArtifacts, [{ id: 'artifact-1' }])
  assert.equal(merged[0].meta.serverTurnId, 'turn-1')
  assert.equal(merged[0].meta.streaming, false)
  assert.equal(merged[0].meta.serverAuthoritative, true)
})

test('server snapshots retain local tool offsets when canonical text is unchanged', () => {
  const content = 'same canonical text'
  const [merged] = mergeServerSessionMessages([{
    id: 'assistant-same',
    role: 'assistant',
    content,
    meta: { toolCalls: [{ id: 'call-same', textOffset: 4 }] },
  }], [{
    id: 'assistant-same',
    role: 'assistant',
    content,
    meta: { toolCalls: [{ id: 'call-same' }] },
  }])

  assert.deepEqual(merged.meta.toolCalls, [{ id: 'call-same', textOffset: 4 }])
})

test('authoritative failure snapshots replace stale local incomplete diagnostics', () => {
  const recoveredFailure = {
    code: 'TURN_INCOMPLETE',
    retryable: false,
    incompleteReason: 'post_mutation_verification_missing',
    missingRequirements: ['mutation_readback', 'diff_or_project_check'],
  }
  const [merged] = mergeServerSessionMessages([{
    id: 'turn-incomplete:assistant',
    role: 'assistant',
    content: 'partial result',
    meta: {
      serverTurnId: 'turn-incomplete',
      serverLastSequence: 8,
      failed: true,
      serverFailure: { code: 'TURN_INCOMPLETE', retryable: false },
    },
  }], [{
    id: 'turn-incomplete:assistant',
    role: 'assistant',
    content: 'partial result',
    meta: {
      serverTurnId: 'turn-incomplete',
      serverLastSequence: 8,
      serverAuthoritative: true,
      failed: true,
      serverFailure: recoveredFailure,
    },
  }])

  assert.deepEqual(merged.meta.serverFailure, recoveredFailure)
})

test('a stale failure snapshot cannot overwrite a newer live terminal diagnosis', () => {
  const liveFailure = {
    code: 'TURN_INCOMPLETE',
    incompleteReason: 'pdf_layout_verification_missing',
    missingRequirements: ['pdf_layout_validation'],
  }
  const [merged] = mergeServerSessionMessages([{
    id: 'turn-newer-failure:assistant',
    role: 'assistant',
    content: 'newer live result',
    meta: {
      serverTurnId: 'turn-newer-failure',
      serverLastSequence: 10,
      failed: true,
      serverFailure: liveFailure,
    },
  }], [{
    id: 'turn-newer-failure:assistant',
    role: 'assistant',
    content: 'older persisted result',
    meta: {
      serverTurnId: 'turn-newer-failure',
      serverLastSequence: 9,
      serverAuthoritative: true,
      failed: true,
      serverFailure: { code: 'TURN_INCOMPLETE' },
    },
  }])

  assert.deepEqual(merged.meta.serverFailure, liveFailure)
})

test('an authoritative completion clears a stale local failure', () => {
  const [merged] = mergeServerSessionMessages([{
    id: 'turn-now-complete:assistant',
    role: 'assistant',
    content: 'done',
    meta: {
      serverTurnId: 'turn-now-complete',
      serverLastSequence: 3,
      failed: true,
      serverFailure: { code: 'TURN_INCOMPLETE' },
    },
  }], [{
    id: 'turn-now-complete:assistant',
    role: 'assistant',
    content: 'done',
    meta: {
      serverTurnId: 'turn-now-complete',
      serverLastSequence: 4,
      serverAuthoritative: true,
      streaming: false,
    },
  }])

  assert.equal(Object.hasOwn(merged.meta, 'serverFailure'), false)
})

test('an older snapshot cannot roll a newer live tool result back to running', () => {
  const [merged] = mergeServerSessionMessages([{
    id: 'assistant-tool-race',
    role: 'assistant',
    content: 'newer live text',
    meta: {
      serverTurnId: 'turn-tool-race',
      serverLastSequence: 5,
      toolCalls: [{
        id: 'call-race',
        name: 'read_file',
        status: 'success',
        result: '{"ok":true}',
        textOffset: 4,
      }],
    },
  }], [{
    id: 'assistant-tool-race',
    role: 'assistant',
    content: 'older snapshot text',
    meta: {
      serverTurnId: 'turn-tool-race',
      serverLastSequence: 3,
      toolCalls: [{ id: 'call-race', name: 'read_file', status: 'running' }],
    },
  }])

  assert.equal(merged.meta.serverLastSequence, 5)
  assert.equal(merged.meta.toolCalls[0].status, 'success')
  assert.equal(merged.meta.toolCalls[0].result, '{"ok":true}')
  assert.equal(merged.meta.toolCalls[0].textOffset, 4)
})

test('authoritative snapshots replace stale local turn timing metadata', () => {
  const [merged] = mergeServerSessionMessages([{
    id: 'timed-assistant',
    role: 'assistant',
    content: 'Finished.',
    timestamp: 5_000,
    meta: {
      serverTurnId: 'timed-turn',
      turnStartedAt: 4_000,
      turnCompletedAt: 5_000,
      latency: 1_000,
    },
  }], [{
    id: 'timed-assistant',
    role: 'assistant',
    content: 'Finished.',
    timestamp: 5_000,
    meta: {
      serverTurnId: 'timed-turn',
      turnStartedAt: 1_000,
      turnCompletedAt: 5_000,
      latency: 4_000,
      serverAuthoritative: true,
    },
  }])

  assert.equal(merged.meta.turnStartedAt, 1_000)
  assert.equal(merged.meta.turnCompletedAt, 5_000)
  assert.equal(merged.meta.latency, 4_000)
})

test('authoritative final text remains fully visible after a discarded candidate response', () => {
  const discardedCandidate = 'C'.repeat(224)
  const finalText = `${'F'.repeat(224)}6B5102A919ABDA03146DE557A78EA1311FEEEAA26C8FBA4E7`
  const [merged] = mergeServerSessionMessages([{
    id: 'assistant-final',
    role: 'assistant',
    content: discardedCandidate + finalText,
    meta: { toolCalls: [{ id: 'readback', name: 'read_file', textOffset: discardedCandidate.length }] },
  }], [{
    id: 'assistant-final',
    role: 'assistant',
    content: finalText,
    meta: { toolCalls: [{ id: 'readback', name: 'read_file' }] },
  }])

  const finalSegment = [...buildMessageTimeline(merged.content, merged.meta.toolCalls)]
    .reverse()
    .find((segment) => segment.kind === 'text' && segment.text.trim())

  assert.equal(merged.content, finalText)
  assert.deepEqual(merged.meta.toolCalls, [{ id: 'readback', name: 'read_file' }])
  assert.equal(finalSegment?.text, finalText)
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

test('an interrupted snapshot keeps streaming and advances a stale local replay cursor', () => {
  const [merged] = mergeServerSessionMessages([{
    id: 'turn-interrupted:assistant',
    role: 'assistant',
    content: 'local partial',
    meta: {
      streaming: false,
      turnCompletedAt: 500,
      latency: 400,
      serverTurnId: 'turn-interrupted',
      serverLastSequence: 3,
      serverConnectionState: null,
    },
  }], [{
    id: 'turn-interrupted:assistant',
    role: 'assistant',
    content: 'durable checkpoint',
    meta: {
      streaming: true,
      interrupted: true,
      turnCompletedAt: null,
      latency: null,
      serverTurnId: 'turn-interrupted',
      serverLastSequence: 8,
      serverConnectionState: 'interrupted',
      serverAuthoritative: true,
    },
  }])

  assert.equal(merged.content, 'durable checkpoint')
  assert.equal(merged.meta.streaming, true)
  assert.equal(merged.meta.turnCompletedAt, null)
  assert.equal(merged.meta.latency, null)
  assert.equal(merged.meta.serverLastSequence, 8)
  assert.equal(merged.meta.serverConnectionState, 'interrupted')
})

test('an authoritative cancelled snapshot restores cancellation instead of ordinary completion', () => {
  const [merged] = mergeServerSessionMessages([{
    id: 'turn-cancelled:assistant',
    role: 'assistant',
    content: 'local partial',
    meta: {
      streaming: true,
      serverTurnId: 'turn-cancelled',
      serverLastSequence: 4,
      serverConnectionState: 'connected',
    },
  }], [{
    id: 'turn-cancelled:assistant',
    role: 'assistant',
    content: 'stopped',
    meta: {
      cancelled: true,
      streaming: false,
      serverTurnId: 'turn-cancelled',
      serverLastSequence: 5,
      serverConnectionState: 'cancelled',
      serverAuthoritative: true,
    },
  }])

  assert.equal(merged.meta.cancelled, true)
  assert.equal(merged.meta.streaming, false)
  assert.equal(merged.meta.serverConnectionState, 'cancelled')
  assert.equal(merged.meta.serverLastSequence, 5)
})

test('verified snapshot receipts prune matching retained files even when retained is omitted', () => {
  const unrelated = {
    id: 'unrelated-retained',
    path: 'D:\\workspace\\other.html',
    filename: 'other.html',
  }
  const [merged] = mergeServerSessionMessages([{
    id: 'turn-files:assistant',
    role: 'assistant',
    content: 'done',
    meta: {
      serverTurnId: 'turn-files',
      serverLastSequence: 7,
      retainedLocalFiles: [{
        id: 'old-receipt',
        path: 'D:\\Workspace\\REPORT.HTML',
        filename: 'REPORT.HTML',
      }, unrelated],
    },
  }], [{
    id: 'turn-files:assistant',
    role: 'assistant',
    content: 'done',
    meta: {
      serverTurnId: 'turn-files',
      serverLastSequence: 8,
      verifiedLocalFiles: [{
        id: 'new-receipt',
        path: 'd:/workspace/report.html',
        filename: 'report.html',
      }],
    },
  }])

  assert.deepEqual(merged.meta.retainedLocalFiles, [unrelated])
  assert.equal(merged.meta.verifiedLocalFiles[0].id, 'new-receipt')
})

test('a stale snapshot cannot replace newer SSE file receipts', () => {
  const localVerified = [{
    id: 'live-verified',
    path: 'D:\\workspace\\live.html',
    filename: 'live.html',
  }]
  const [merged] = mergeServerSessionMessages([{
    id: 'turn-files-newer:assistant',
    role: 'assistant',
    content: 'live',
    meta: {
      serverTurnId: 'turn-files-newer',
      serverLastSequence: 10,
      verifiedLocalFiles: localVerified,
      retainedLocalFiles: [{
        id: 'stale-live-retained',
        path: 'd:/WORKSPACE/LIVE.HTML',
        filename: 'LIVE.HTML',
      }],
    },
  }], [{
    id: 'turn-files-newer:assistant',
    role: 'assistant',
    content: 'snapshot',
    meta: {
      serverTurnId: 'turn-files-newer',
      serverLastSequence: 9,
      verifiedLocalFiles: [{
        id: 'snapshot-verified',
        path: 'D:\\workspace\\snapshot.html',
        filename: 'snapshot.html',
      }],
      retainedLocalFiles: [{
        id: 'snapshot-retained',
        path: 'D:\\workspace\\retained.html',
        filename: 'retained.html',
      }],
    },
  }])

  assert.deepEqual(merged.meta.verifiedLocalFiles, localVerified)
  assert.deepEqual(merged.meta.retainedLocalFiles, [])
  assert.equal(merged.meta.serverLastSequence, 10)
})

test('newer SSE retained receipts do not inherit stale snapshot verification', () => {
  const localRetained = [{
    id: 'live-retained',
    path: 'D:\\workspace\\report.html',
    filename: 'report.html',
  }, {
    id: 'live-unrelated',
    path: 'D:\\workspace\\other.html',
    filename: 'other.html',
  }]
  const [merged] = mergeServerSessionMessages([{
    id: 'turn-files-retained-newer:assistant',
    role: 'assistant',
    content: 'newer retained state',
    meta: {
      serverTurnId: 'turn-files-retained-newer',
      serverLastSequence: 10,
      retainedLocalFiles: localRetained,
    },
  }], [{
    id: 'turn-files-retained-newer:assistant',
    role: 'assistant',
    content: 'stale verified state',
    meta: {
      serverTurnId: 'turn-files-retained-newer',
      serverLastSequence: 5,
      verifiedLocalFiles: [{
        id: 'stale-verified',
        path: 'd:/WORKSPACE/report.html',
        filename: 'REPORT.HTML',
      }],
    },
  }])

  assert.equal(Object.hasOwn(merged.meta, 'verifiedLocalFiles'), false)
  assert.deepEqual(merged.meta.retainedLocalFiles, localRetained)
  assert.equal(merged.meta.serverLastSequence, 10)
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

test('recovery stubs preserve live tool offsets even when placeholder text differs', () => {
  const [recoverable] = mergeServerSessionMessages([{
    id: 'turn-offset:assistant',
    role: 'assistant',
    content: 'live partial text',
    meta: { streaming: true, toolCalls: [{ id: 'live-call', textOffset: 5 }] },
  }], [{
    id: 'turn-offset:assistant',
    role: 'assistant',
    content: 'recovering',
    meta: {
      streaming: true,
      serverRecoveryStub: true,
      toolCalls: [{ id: 'live-call' }],
    },
  }])

  assert.equal(recoverable.meta.serverRecoveryStub, true)
  assert.deepEqual(recoverable.meta.toolCalls, [{ id: 'live-call', textOffset: 5 }])
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
  const withTurnEvents = { ...session, serverTurnEventRevision: 3 }
  assert.equal(needsServerSessionSnapshot(withTurnEvents, '7:3'), false)
  assert.equal(needsServerSessionSnapshot(withTurnEvents, '7:2'), true)
  assert.equal(needsServerTranscriptHydration({ ...session, messages: [{ id: 'history', role: 'user' }] }), false)
})

test('an incomplete local terminal record without structured diagnostics requires hydration', () => {
  const legacyFailure = {
    id: 'turn-incomplete:assistant',
    role: 'assistant',
    content: 'Saved files remain available.',
    meta: {
      failed: true,
      serverFailure: { code: 'TURN_INCOMPLETE', retryable: false },
    },
  }
  const session = {
    id: 's1',
    serverRevision: 7,
    messages: [
      { id: 'turn-incomplete:user', role: 'user', content: 'finish the task' },
      legacyFailure,
    ],
  }

  assert.equal(needsServerTranscriptHydration(session), true)
  assert.equal(needsServerSessionSnapshot(session, null), true)
  assert.equal(needsServerSessionSnapshot(session, 7), false)

  const withReasonOnly = {
    ...session,
    messages: [session.messages[0], {
      ...legacyFailure,
      meta: {
        ...legacyFailure.meta,
        serverFailure: {
          ...legacyFailure.meta.serverFailure,
          incompleteReason: 'private_internal_reason',
        },
      },
    }],
  }
  assert.equal(needsServerTranscriptHydration(withReasonOnly), true)

  const completeDiagnostics = {
    ...withReasonOnly,
    messages: [withReasonOnly.messages[0], {
      ...withReasonOnly.messages[1],
      meta: {
        ...withReasonOnly.messages[1].meta,
        serverFailure: {
          ...withReasonOnly.messages[1].meta.serverFailure,
          missingRequirements: [],
        },
      },
    }],
  }
  assert.equal(needsServerTranscriptHydration(completeDiagnostics), false)
  assert.equal(needsServerTranscriptHydration(undefined), false)
})

test('selecting a historical incomplete session replaces legacy fallback diagnostics from the server', async () => {
  let state = {
    activeSessionId: null,
    sessions: [{
      id: 's1',
      serverRevision: 7,
      messages: [{
        id: 'turn-incomplete:assistant',
        role: 'assistant',
        content: 'Saved files remain available.',
        meta: {
          failed: true,
          serverFailure: { code: 'TURN_INCOMPLETE', retryable: false },
        },
      }],
    }],
  }
  const authoritativeFailure = {
    code: 'TURN_INCOMPLETE',
    retryable: false,
    incompleteReason: 'post_mutation_verification_missing',
    missingRequirements: ['mutation_readback', 'diff_or_project_check'],
  }
  let snapshotRequests = 0
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    fetchSessionSnapshot: async () => {
      snapshotRequests += 1
      return {
        complete: true,
        revision: 7,
        messages: [{
          id: 'turn-incomplete:assistant',
          role: 'assistant',
          content: 'Saved files remain available.',
          meta: { failed: true, serverFailure: authoritativeFailure },
        }],
      }
    },
    replaceMessages: async () => ({ revision: 8 }),
    deleteSession: async () => ({ ok: true }),
  })

  assert.equal(await dispatch({ type: 'SWITCH_SESSION', payload: 's1' }), true)
  assert.equal(snapshotRequests, 1)
  assert.equal(state.activeSessionId, 's1')
  assert.deepEqual(state.sessions[0].messages[0].meta.serverFailure, authoritativeFailure)

  assert.equal(dispatch({ type: 'SWITCH_SESSION', payload: 's1' }), undefined)
  assert.equal(snapshotRequests, 1)
})

test('a legacy incomplete local session is claimed by its matching server session before hydration', async () => {
  let state = {
    activeSessionId: null,
    sessions: [{
      id: 'legacy-s1',
      messages: [{
        id: 'turn-incomplete:assistant',
        role: 'assistant',
        content: 'Saved files remain available.',
        meta: {
          failed: true,
          serverFailure: { code: 'TURN_INCOMPLETE', retryable: false },
        },
      }],
    }],
  }
  const authoritativeFailure = {
    code: 'TURN_INCOMPLETE',
    retryable: false,
    incompleteReason: 'post_mutation_verification_missing',
    missingRequirements: ['mutation_readback', 'diff_or_project_check'],
  }
  let metadataRequests = 0
  let snapshotRequests = 0
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    resolveSessionMetadata: async ({ sessionId }) => {
      metadataRequests += 1
      assert.equal(sessionId, 'legacy-s1')
      return { id: sessionId, revision: 7 }
    },
    fetchSessionSnapshot: async ({ sessionId }) => {
      snapshotRequests += 1
      assert.equal(sessionId, 'legacy-s1')
      return {
        complete: true,
        revision: 7,
        messages: [{
          id: 'turn-incomplete:assistant',
          role: 'assistant',
          content: 'Saved files remain available.',
          meta: { failed: true, serverFailure: authoritativeFailure },
        }],
      }
    },
    replaceMessages: async () => ({ revision: 8 }),
    deleteSession: async () => ({ ok: true }),
  })

  assert.equal(await dispatch({ type: 'SWITCH_SESSION', payload: 'legacy-s1' }), true)
  assert.equal(metadataRequests, 1)
  assert.equal(snapshotRequests, 1)
  assert.equal(state.activeSessionId, 'legacy-s1')
  assert.equal(state.sessions[0].serverRevision, 7)
  assert.deepEqual(state.sessions[0].messages[0].meta.serverFailure, authoritativeFailure)

  assert.equal(dispatch({ type: 'SWITCH_SESSION', payload: 'legacy-s1' }), undefined)
  assert.equal(metadataRequests, 1)
  assert.equal(snapshotRequests, 1)
})

test('a legacy incomplete local session remains unchanged when the server has no matching id', async () => {
  const legacyMessage = {
    id: 'local-only:assistant',
    role: 'assistant',
    content: 'Saved files remain available.',
    meta: {
      failed: true,
      serverFailure: { code: 'TURN_INCOMPLETE', retryable: false },
    },
  }
  let state = {
    activeSessionId: null,
    sessions: [{ id: 'local-only', messages: [legacyMessage] }],
  }
  let metadataRequests = 0
  let snapshotRequests = 0
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    resolveSessionMetadata: async () => { metadataRequests += 1; return null },
    fetchSessionSnapshot: async () => { snapshotRequests += 1; return null },
    replaceMessages: async () => ({ revision: 1 }),
    deleteSession: async () => ({ ok: true }),
  })

  assert.equal(await dispatch({ type: 'SWITCH_SESSION', payload: 'local-only' }), false)
  assert.equal(metadataRequests, 1)
  assert.equal(snapshotRequests, 0)
  assert.equal(state.activeSessionId, 'local-only')
  assert.equal(Object.hasOwn(state.sessions[0], 'serverRevision'), false)
  assert.deepEqual(state.sessions[0].messages, [legacyMessage])
})

test('concurrent legacy incomplete hydration shares one metadata probe and one snapshot request', async () => {
  let state = {
    activeSessionId: null,
    sessions: [{
      id: 'legacy-shared',
      messages: [{
        id: 'legacy-shared:assistant',
        role: 'assistant',
        content: 'Saved files remain available.',
        meta: {
          failed: true,
          serverFailure: { code: 'TURN_INCOMPLETE', retryable: false },
        },
      }],
    }],
  }
  let finishMetadata
  const pendingMetadata = new Promise((resolve) => { finishMetadata = resolve })
  let metadataRequests = 0
  let snapshotRequests = 0
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    resolveSessionMetadata: async () => { metadataRequests += 1; return pendingMetadata },
    fetchSessionSnapshot: async () => {
      snapshotRequests += 1
      return {
        complete: true,
        revision: 4,
        messages: [{
          id: 'legacy-shared:assistant',
          role: 'assistant',
          content: 'Saved files remain available.',
          meta: {
            failed: true,
            serverFailure: {
              code: 'TURN_INCOMPLETE',
              incompleteReason: 'post_mutation_verification_missing',
              missingRequirements: ['mutation_readback'],
            },
          },
        }],
      }
    },
    replaceMessages: async () => ({ revision: 5 }),
    deleteSession: async () => ({ ok: true }),
  })

  const first = dispatch({ type: 'SWITCH_SESSION', payload: 'legacy-shared' })
  const second = dispatch({ type: 'SWITCH_SESSION', payload: 'legacy-shared' })
  assert.equal(first, second)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(metadataRequests, 1)
  assert.equal(snapshotRequests, 0)

  finishMetadata({ id: 'legacy-shared', revision: 4 })
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.equal(metadataRequests, 1)
  assert.equal(snapshotRequests, 1)
  assert.equal(state.sessions[0].serverRevision, 4)
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

test('conflicting replacement never retries against a newer transcript', async () => {
  let state = createState()
  const requests = []
  const failures = []
  let snapshotRequests = 0
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    replaceMessages: async (request) => {
      requests.push(request)
      const error = new Error('stale revision')
      error.code = 'SESSION_REVISION_CONFLICT'
      error.details = { currentRevision: 8 }
      throw error
    },
    deleteSession: async () => ({ ok: true }),
    fetchSessionSnapshot: async () => {
      snapshotRequests += 1
      return {
        complete: true,
        revision: 8,
        messages: [
          { id: 'm1', role: 'user', content: 'one' },
          { id: 'm2', role: 'assistant', content: 'two from server' },
          { id: 'm3', role: 'user', content: 'newer server turn' },
        ],
      }
    },
    onError: (error) => failures.push(error.code),
  })

  assert.equal(await dispatch({ type: 'TRUNCATE_MESSAGES', payload: 1 }), false)
  assert.equal(requests.length, 1)
  assert.equal(snapshotRequests, 1)
  assert.equal(requests[0].expectedRevision, 1)
  assert.deepEqual(requests[0].messages.map((message) => message.id), ['m1'])
  assert.equal(state.sessions[0].serverRevision, 8)
  assert.deepEqual(state.sessions[0].messages.map((message) => message.id), ['m1', 'm2', 'm3'])
  assert.deepEqual(failures, ['SESSION_REVISION_CONFLICT'])
})

test('a committed replacement survives an invalid-result response after snapshot confirmation', async () => {
  let state = createState()
  const requests = []
  const failures = []
  let snapshotRequests = 0
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    replaceMessages: async (request) => {
      requests.push(request)
      const error = new Error('backend result contract rejected a committed write')
      error.code = 'SESSION_ADMIN_RESULT_INVALID'
      throw error
    },
    deleteSession: async () => ({ ok: true }),
    fetchSessionSnapshot: async () => {
      snapshotRequests += 1
      return { complete: true, revision: 5, messages: [] }
    },
    onError: (error) => failures.push(error.code),
  })

  assert.equal(await dispatch({ type: 'CLEAR_CURRENT_SESSION' }), true)
  assert.equal(requests.length, 1)
  assert.equal(snapshotRequests, 1)
  assert.equal(state.sessions[0].serverRevision, 5)
  assert.deepEqual(state.sessions[0].messages, [])
  assert.deepEqual(failures, [])
})

test('a committed replacement survives a conflict response and preserves canonical snapshot data', async () => {
  let state = createState()
  const requests = []
  const failures = []
  let snapshotRequests = 0
  const canonicalMessage = {
    id: 'm1',
    role: 'user',
    content: 'one',
    createdAt: '2026-08-24T08:00:00.000Z',
    serverSequence: 41,
  }
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    replaceMessages: async (request) => {
      requests.push(request)
      const error = new Error('response raced with the committed write')
      error.code = 'SESSION_REVISION_CONFLICT'
      throw error
    },
    deleteSession: async () => ({ ok: true }),
    fetchSessionSnapshot: async () => {
      snapshotRequests += 1
      return { complete: true, revision: 6, messages: [canonicalMessage] }
    },
    onError: (error) => failures.push(error.code),
  })

  assert.equal(await dispatch({ type: 'TRUNCATE_MESSAGES', payload: 1 }), true)
  assert.equal(requests.length, 1)
  assert.equal(snapshotRequests, 1)
  assert.equal(state.sessions[0].serverRevision, 6)
  assert.deepEqual(state.sessions[0].messages, [canonicalMessage])
  assert.deepEqual(failures, [])
})

test('a 500 response retries once from the canonical snapshot when the source transcript is unchanged', async () => {
  let state = createState()
  const requests = []
  const failures = []
  let snapshotRequests = 0
  const canonicalMessages = [
    { id: 'm1', role: 'user', content: 'one', timestamp: 100, serverSequence: 10 },
    { id: 'm2', role: 'assistant', content: 'two', timestamp: 200, serverSequence: 11 },
  ]
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    replaceMessages: async (request) => {
      requests.push(request)
      if (requests.length === 1) {
        const error = new Error('unknown server outcome')
        error.code = 'SESSION_REQUEST_FAILED'
        error.status = 500
        throw error
      }
      return { revision: 8 }
    },
    deleteSession: async () => ({ ok: true }),
    fetchSessionSnapshot: async () => {
      snapshotRequests += 1
      return { complete: true, revision: 7, messages: canonicalMessages }
    },
    onError: (error) => failures.push(error.code),
  })

  assert.equal(await dispatch({ type: 'TRUNCATE_MESSAGES', payload: 1 }), true)
  assert.equal(snapshotRequests, 1)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].expectedRevision, 1)
  assert.equal(requests[1].expectedRevision, 7)
  assert.deepEqual(requests[1].messages, [canonicalMessages[0]])
  assert.equal(state.sessions[0].serverRevision, 8)
  assert.deepEqual(state.sessions[0].messages, [canonicalMessages[0]])
  assert.deepEqual(failures, [])
})

test('a failed safe retry does not fetch a second snapshot', async () => {
  let state = createState()
  const requests = []
  const failures = []
  let snapshotRequests = 0
  const dispatch = createSessionMutationDispatcher({
    getState: () => state,
    reduceState: testReducer,
    dispatchImmediate: (action) => { state = testReducer(state, action) },
    applyServerAction: (action) => { state = testReducer(state, action) },
    replaceMessages: async (request) => {
      requests.push(request)
      const error = new Error(requests.length === 1 ? 'stale revision' : 'changed during retry')
      error.code = 'SESSION_REVISION_CONFLICT'
      error.status = 409
      throw error
    },
    deleteSession: async () => ({ ok: true }),
    fetchSessionSnapshot: async () => {
      snapshotRequests += 1
      return {
        complete: true,
        revision: 2,
        messages: [
          { id: 'm1', role: 'user', content: 'one' },
          { id: 'm2', role: 'assistant', content: 'two' },
        ],
      }
    },
    onError: (error) => failures.push(error.message),
  })

  assert.equal(await dispatch({ type: 'TRUNCATE_MESSAGES', payload: 1 }), false)
  assert.equal(requests.length, 2)
  assert.equal(snapshotRequests, 1)
  assert.equal(requests[1].expectedRevision, 2)
  assert.equal(state.sessions[0].serverRevision, 2)
  assert.deepEqual(state.sessions[0].messages.map((message) => message.id), ['m1', 'm2'])
  assert.deepEqual(failures, ['changed during retry'])
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
