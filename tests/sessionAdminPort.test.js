import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  LEGACY_SESSION_ADMIN_PORT_CONTRACT_VERSION,
  prepareSessionAdminPort,
  SESSION_ADMIN_PORT_CONTRACT_VERSION,
} from '../server/core/sessionAdminPort.js'

function portDefinition(overrides = {}, contractVersion = SESSION_ADMIN_PORT_CONTRACT_VERSION) {
  return {
    contractVersion,
    searchMessages: () => [],
    listSessions: () => [],
    getSessionSnapshot: () => null,
    getSessionBranches: () => null,
    forkSession: () => null,
    replaceSessionMessages: () => null,
    deleteSession: () => null,
    archiveSession: () => null,
    unarchiveSession: () => null,
    pinSession: () => null,
    unpinSession: () => null,
    ...overrides,
  }
}

test('SessionAdmin core contract has no storage or service dependency', () => {
  const source = fs.readFileSync(new URL('../server/core/sessionAdminPort.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from\s+['"]\.\.\/(?:db|services)\//u)
})

test('SessionAdmin v2 normalizes query pagination before invoking the backend', async () => {
  const calls = []
  const port = prepareSessionAdminPort(portDefinition({
    async searchMessages(input) {
      calls.push(['searchMessages', input])
      return []
    },
    listSessions(input) {
      calls.push(['listSessions', input])
      return []
    },
  }))

  assert.deepEqual(port.listSessions({
    userId: 'user-1',
    archived: true,
    limit: '3',
    offset: '2',
  }), [])
  assert.deepEqual(await port.searchMessages({
    userId: 'user-1',
    query: 'local facts',
    limit: '4',
    offset: '1',
  }), [])
  assert.deepEqual(calls, [[
    'listSessions',
    { userId: 'user-1', archived: 'true', limit: 3, offset: 2 },
  ], [
    'searchMessages',
    { userId: 'user-1', query: 'local facts', sessionId: null, limit: 4, offset: 1 },
  ]])
})

test('SessionAdmin optional workspace mutation normalizes selections and explicit clears', () => {
  const calls = []
  const port = prepareSessionAdminPort(portDefinition({
    setSessionWorkspace(input) {
      calls.push(input)
      return {
        id: input.sessionId,
        revision: 3,
        workspacePath: input.workspacePath,
      }
    },
  }))

  assert.deepEqual(port.setSessionWorkspace({
    userId: 'user-1',
    sessionId: 'session-1',
    workspacePath: '  C:\\Project  ',
  }), { id: 'session-1', revision: 3, workspacePath: 'C:\\Project' })
  assert.deepEqual(port.setSessionWorkspace({
    userId: 'user-1',
    sessionId: 'session-1',
    workspacePath: null,
  }), { id: 'session-1', revision: 3, workspacePath: null })
  assert.deepEqual(calls.map(({ workspacePath }) => workspacePath), ['C:\\Project', null])

  for (const workspacePath of ['', 42, 'x'.repeat(32_769)]) {
    assert.throws(
      () => port.setSessionWorkspace({ userId: 'user-1', sessionId: 'session-1', workspacePath }),
      (error) => error?.code === 'SESSION_ADMIN_INPUT_INVALID',
    )
  }
})

test('SessionAdmin v2 rejects invalid inputs before backend invocation', () => {
  let calls = 0
  const port = prepareSessionAdminPort(portDefinition({
    listSessions() {
      calls += 1
      return []
    },
    deleteSession() {
      calls += 1
      return null
    },
  }))

  for (const input of [
    { userId: 'user-1', limit: 0 },
    { userId: 'user-1', offset: '-1' },
    { userId: 'user-1', archived: 'maybe' },
  ]) {
    assert.throws(
      () => port.listSessions(input),
      (error) => error?.code === 'SESSION_ADMIN_INPUT_INVALID' && error?.retryable === false,
    )
  }
  assert.throws(
    () => port.deleteSession({ userId: 'user-1', sessionId: 'session-1' }),
    (error) => error?.code === 'SESSION_ADMIN_INPUT_INVALID'
      && /expectedRevision/.test(error.message),
  )
  assert.equal(calls, 0)
})

test('SessionAdmin v2 rejects coercible non-scalar pagination and revisions', () => {
  let calls = 0
  const port = prepareSessionAdminPort(portDefinition({
    listSessions() {
      calls += 1
      return []
    },
    deleteSession() {
      calls += 1
      return null
    },
  }))
  const coercionProbe = {
    valueOf() {
      calls += 100
      return 1
    },
  }

  for (const limit of [true, [1], coercionProbe]) {
    assert.throws(
      () => port.listSessions({ userId: 'user-1', limit }),
      (error) => error?.code === 'SESSION_ADMIN_INPUT_INVALID'
        && error?.retryable === false,
    )
  }
  for (const expectedRevision of [true, [1], coercionProbe]) {
    assert.throws(
      () => port.deleteSession({
        userId: 'user-1',
        sessionId: 'session-1',
        expectedRevision,
      }),
      (error) => error?.code === 'SESSION_ADMIN_INPUT_INVALID'
        && error?.retryable === false,
    )
  }
  assert.equal(calls, 0)
})

test('SessionAdmin v2 validates synchronous and asynchronous backend results', async () => {
  const invalidList = prepareSessionAdminPort(portDefinition({
    listSessions: () => [{ id: 'missing-revision' }],
  }))
  assert.throws(
    () => invalidList.listSessions({ userId: 'user-1' }),
    (error) => error?.code === 'SESSION_ADMIN_RESULT_INVALID'
      && /revision/.test(error.message),
  )

  const invalidSnapshot = prepareSessionAdminPort(portDefinition({
    getSessionSnapshot: async () => ({ session: { id: 'session-1', revision: 0 } }),
  }))
  await assert.rejects(
    invalidSnapshot.getSessionSnapshot({ userId: 'user-1', sessionId: 'session-1' }),
    (error) => error?.code === 'SESSION_ADMIN_RESULT_INVALID'
      && /messages/.test(error.message),
  )
})

test('SessionAdmin v2 fails closed on malformed results from every method', () => {
  const userInput = { userId: 'user-1' }
  const sessionInput = { ...userInput, sessionId: 'session-1' }
  const cases = [
    ['searchMessages', userInput],
    ['listSessions', userInput],
    ['getSessionSnapshot', sessionInput],
    ['getSessionBranches', sessionInput],
    ['forkSession', sessionInput],
    ['replaceSessionMessages', {
      ...sessionInput,
      expectedRevision: 0,
      messages: [],
    }],
    ['deleteSession', { ...sessionInput, expectedRevision: 0 }],
    ['archiveSession', sessionInput],
    ['unarchiveSession', sessionInput],
    ['pinSession', sessionInput],
    ['unpinSession', sessionInput],
  ]

  for (const [method, input] of cases) {
    const port = prepareSessionAdminPort(portDefinition({
      [method]: () => ({}),
    }))
    assert.throws(
      () => port[method](input),
      (error) => error?.code === 'SESSION_ADMIN_RESULT_INVALID'
        && error?.retryable === false,
      method,
    )
  }
})

test('SessionAdmin v2 rejects inherited and accessor result fields without executing them', () => {
  let getterCalls = 0
  const inheritedSession = Object.create({ id: 'inherited', revision: 0 })
  const accessorSession = { revision: 0 }
  Object.defineProperty(accessorSession, 'id', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'accessor'
    },
  })
  const accessorArray = []
  Object.defineProperty(accessorArray, '0', {
    enumerable: true,
    get() {
      getterCalls += 1
      return { id: 'array-accessor', revision: 0 }
    },
  })
  accessorArray.length = 1

  for (const result of [[inheritedSession], [accessorSession], accessorArray]) {
    const port = prepareSessionAdminPort(portDefinition({ listSessions: () => result }))
    assert.throws(
      () => port.listSessions({ userId: 'user-1' }),
      (error) => error?.code === 'SESSION_ADMIN_RESULT_INVALID'
        && error?.retryable === false,
    )
  }
  assert.equal(getterCalls, 0)
})

test('SessionAdmin v2 projects frozen public DTOs without adapter-private fields', () => {
  let thenGetterCalls = 0
  const backendSession = {
    id: 'session-1',
    title: 'Public title',
    revision: 0,
    backendSecret: 'must-not-cross-the-port',
  }
  Object.defineProperty(backendSession, 'then', {
    enumerable: true,
    get() {
      thenGetterCalls += 1
      throw new Error('must not execute')
    },
  })
  const port = prepareSessionAdminPort(portDefinition({
    listSessions: () => [backendSession],
  }))

  const result = port.listSessions({ userId: 'user-1' })
  assert.deepEqual(result, [{ id: 'session-1', title: 'Public title', revision: 0 }])
  assert.equal(Object.hasOwn(result[0], 'backendSecret'), false)
  assert.equal(Object.hasOwn(result[0], 'then'), false)
  assert.equal(thenGetterCalls, 0)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result[0]), true)
})

test('SessionAdmin v2 rejects inconsistent CAS and snapshot revisions', () => {
  const replacePort = prepareSessionAdminPort(portDefinition({
    replaceSessionMessages: () => ({ revision: 9, totalMessages: 0 }),
  }))
  assert.throws(
    () => replacePort.replaceSessionMessages({
      userId: 'user-1',
      sessionId: 'session-1',
      expectedRevision: 7,
      messages: [],
    }),
    (error) => error?.code === 'SESSION_ADMIN_RESULT_INVALID',
  )

  const deletePort = prepareSessionAdminPort(portDefinition({
    deleteSession: () => ({ deleted: true, previousRevision: 1 }),
  }))
  assert.throws(
    () => deletePort.deleteSession({
      userId: 'user-1',
      sessionId: 'session-1',
      expectedRevision: 8,
    }),
    (error) => error?.code === 'SESSION_ADMIN_RESULT_INVALID',
  )

  const snapshotPort = prepareSessionAdminPort(portDefinition({
    getSessionSnapshot: () => ({
      session: { id: 'session-1', revision: 1 },
      messages: [],
      revision: 2,
      totalMessages: 0,
      complete: true,
      nextOffset: null,
    }),
  }))
  assert.throws(
    () => snapshotPort.getSessionSnapshot({ userId: 'user-1', sessionId: 'session-1' }),
    (error) => error?.code === 'SESSION_ADMIN_RESULT_INVALID',
  )
})

test('SessionAdmin v2 enforces snapshot pagination invariants', () => {
  for (const snapshot of [
    {
      session: { id: 'session-1', revision: 0 },
      messages: [],
      revision: 0,
      totalMessages: 1,
      complete: true,
      nextOffset: null,
    },
    {
      session: { id: 'session-1', revision: 0 },
      messages: [],
      revision: 0,
      totalMessages: 1,
      complete: false,
      nextOffset: 0,
    },
    {
      session: { id: 'session-1', revision: 0 },
      messages: [],
      revision: 0,
      totalMessages: 0,
      complete: true,
      nextOffset: 1,
    },
  ]) {
    const port = prepareSessionAdminPort(portDefinition({ getSessionSnapshot: () => snapshot }))
    assert.throws(
      () => port.getSessionSnapshot({ userId: 'user-1', sessionId: 'session-1' }),
      (error) => error?.code === 'SESSION_ADMIN_RESULT_INVALID',
    )
  }
})

test('SessionAdmin v2 accepts structured CAS mutation results', () => {
  const port = prepareSessionAdminPort(portDefinition({
    replaceSessionMessages: (input) => ({
      revision: input.expectedRevision + 1,
      totalMessages: input.messages.length,
    }),
    deleteSession: (input) => ({ deleted: true, previousRevision: input.expectedRevision }),
  }))

  assert.deepEqual(port.replaceSessionMessages({
    userId: 'user-1',
    sessionId: 'session-1',
    expectedRevision: '7',
    messages: [],
  }), { revision: 8, totalMessages: 0 })
  assert.deepEqual(port.deleteSession({
    userId: 'user-1',
    sessionId: 'session-1',
    expectedRevision: '8',
  }), { deleted: true, previousRevision: 8 })
})

test('SessionAdmin v1 remains compatible without applying v2 wrappers', () => {
  const legacyList = (input) => input
  const port = prepareSessionAdminPort(portDefinition({
    listSessions: legacyList,
  }, LEGACY_SESSION_ADMIN_PORT_CONTRACT_VERSION))

  assert.strictEqual(port.listSessions, legacyList)
  assert.deepEqual(port.listSessions({ limit: 'legacy' }), { limit: 'legacy' })
})

test('SessionAdmin activation rejects accessors and incomplete definitions', () => {
  const withAccessor = portDefinition()
  Object.defineProperty(withAccessor, 'listSessions', {
    enumerable: true,
    get() {
      throw new Error('must not execute')
    },
  })
  assert.throws(
    () => prepareSessionAdminPort(withAccessor),
    (error) => error?.code === 'SESSION_ADMIN_PORT_INVALID'
      && /own data property/.test(error.message),
  )

  const incomplete = portDefinition()
  delete incomplete.deleteSession
  assert.throws(
    () => prepareSessionAdminPort(incomplete),
    (error) => error?.code === 'SESSION_ADMIN_PORT_INVALID'
      && /deleteSession/.test(error.message),
  )
})
