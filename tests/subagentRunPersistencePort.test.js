import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION,
  SUBAGENT_RUN_PERSISTENCE_PORT_METHODS,
  createSubagentRunPersistencePortController,
  getActiveSubagentRunPersistencePort,
  getSubagentRunPersistencePortStatus,
  prepareSubagentRunPersistencePort,
} from '../server/core/subagentRunPersistencePort.js'

function runDto(overrides = {}) {
  return {
    id: 'run-1',
    userId: 'user-1',
    parentSessionId: 'session-1',
    parentMessageId: 'message-1',
    agentType: 'researcher',
    prompt: 'Inspect the local workspace',
    modelName: 'local-model',
    modelProviderId: 'provider-1',
    modelConfigRevision: 3,
    status: 'running',
    resultText: '',
    trace: [{ type: 'started', detail: { local: true } }],
    tokensIn: 2,
    tokensOut: 1,
    createdAt: 100,
    finishedAt: null,
    ...overrides,
  }
}

function portDefinition(overrides = {}) {
  return {
    id: 'test.subagent-run-persistence',
    apiVersion: SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION,
    createRun(input) {
      return runDto({
        id: input.id,
        userId: input.userId,
        parentSessionId: input.parentSessionId,
        parentMessageId: input.parentMessageId,
        agentType: input.agentType,
        prompt: input.prompt,
        modelName: input.modelName,
        modelProviderId: input.modelProviderId,
        modelConfigRevision: input.modelConfigRevision,
        trace: input.trace,
        createdAt: input.createdAt,
      })
    },
    getRun(input) {
      return runDto(input)
    },
    markRunning(input) {
      return runDto({ id: input.id, userId: input.userId, trace: input.trace })
    },
    saveRunningTrace(input) {
      return runDto({ id: input.id, userId: input.userId, trace: input.trace })
    },
    finishRun(input) {
      return runDto({
        id: input.id,
        userId: input.userId,
        status: input.status,
        resultText: input.resultText,
        trace: input.trace,
        finishedAt: input.finishedAt,
      })
    },
    listRunningRuns() {
      return [runDto()]
    },
    interruptRunningRun(input) {
      return { userId: input.userId, id: input.id, interrupted: true }
    },
    ...overrides,
  }
}

function createInput(overrides = {}) {
  return {
    id: 'run-1',
    userId: 'user-1',
    parentSessionId: 'session-1',
    parentMessageId: 'message-1',
    agentType: 'researcher',
    prompt: 'Inspect the local workspace',
    modelName: 'local-model',
    modelProviderId: 'provider-1',
    modelConfigRevision: 3,
    trace: [{ type: 'queued', detail: { local: true } }],
    createdAt: 100,
    ...overrides,
  }
}

test('SubagentRunPersistencePort rejects missing methods and unsupported versions', () => {
  assert.deepEqual(SUBAGENT_RUN_PERSISTENCE_PORT_METHODS, [
    'createRun',
    'getRun',
    'markRunning',
    'saveRunningTrace',
    'finishRun',
    'listRunningRuns',
    'interruptRunningRun',
  ])
  assert.equal(Object.isFrozen(SUBAGENT_RUN_PERSISTENCE_PORT_METHODS), true)

  const missing = portDefinition()
  delete missing.saveRunningTrace
  assert.throws(
    () => prepareSubagentRunPersistencePort(missing),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_INVALID'
      && /saveRunningTrace/.test(error.message),
  )
  assert.throws(
    () => prepareSubagentRunPersistencePort(portDefinition({ apiVersion: 2 })),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_VERSION_UNSUPPORTED'
      && error?.retryable === false,
  )
})

test('SubagentRunPersistencePort sends deeply frozen inputs to every adapter method', () => {
  const received = new Map()
  const definition = portDefinition()
  for (const method of [
    'createRun',
    'getRun',
    'markRunning',
    'saveRunningTrace',
    'finishRun',
    'interruptRunningRun',
  ]) {
    const implementation = definition[method]
    definition[method] = (input) => {
      received.set(method, input)
      return implementation(input)
    }
  }
  const port = prepareSubagentRunPersistencePort(definition)

  port.createRun(createInput())
  port.getRun({ userId: 'user-1', id: 'run-1' })
  port.markRunning({
    userId: 'user-1',
    id: 'run-1',
    trace: [{ type: 'running', detail: { attempt: 1 } }],
    startedAt: 101,
  })
  port.saveRunningTrace({
    userId: 'user-1',
    id: 'run-1',
    trace: [{ type: 'checkpoint', detail: { step: 2 } }],
  })
  port.finishRun({
    userId: 'user-1',
    id: 'run-1',
    status: 'completed',
    resultText: 'done',
    trace: [{ type: 'finished', detail: { verified: true } }],
    finishedAt: 102,
  })
  port.interruptRunningRun({
    userId: 'user-1',
    id: 'run-1',
    status: 'interrupted',
    resultText: '',
    trace: [{ type: 'interrupted', detail: { reason: 'shutdown' } }],
    finishedAt: 103,
  })

  assert.deepEqual([...received.keys()], [
    'createRun',
    'getRun',
    'markRunning',
    'saveRunningTrace',
    'finishRun',
    'interruptRunningRun',
  ])
  for (const input of received.values()) {
    assert.equal(Object.isFrozen(input), true)
    if (input.trace) {
      assert.equal(Object.isFrozen(input.trace), true)
      assert.equal(Object.isFrozen(input.trace[0]), true)
      assert.equal(Object.isFrozen(input.trace[0].detail), true)
    }
  }
})

test('SubagentRunPersistencePort fails closed when an adapter changes owner or run identity', async () => {
  const wrongOwner = prepareSubagentRunPersistencePort(portDefinition({
    getRun: () => runDto({ userId: 'user-2' }),
  }))
  assert.throws(
    () => wrongOwner.getRun({ userId: 'user-1', id: 'run-1' }),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_IDENTITY_MISMATCH',
  )

  const wrongRun = prepareSubagentRunPersistencePort(portDefinition({
    finishRun: async (input) => runDto({
      id: 'run-2',
      userId: input.userId,
      status: input.status,
      finishedAt: input.finishedAt,
    }),
  }))
  await assert.rejects(
    wrongRun.finishRun({
      userId: 'user-1',
      id: 'run-1',
      status: 'completed',
      resultText: 'done',
      trace: [],
      finishedAt: 102,
    }),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_IDENTITY_MISMATCH',
  )
})

test('SubagentRunPersistencePort preserves sync returns and validates thenables', async () => {
  const port = prepareSubagentRunPersistencePort(portDefinition({
    getRun(input) {
      return {
        then(resolve) {
          resolve(runDto(input))
        },
      }
    },
  }))

  const created = port.createRun(createInput())
  assert.equal(typeof created?.then, 'undefined')
  assert.equal(created.id, 'run-1')

  const loaded = port.getRun({ userId: 'user-1', id: 'run-1' })
  assert.equal(typeof loaded?.then, 'function')
  assert.deepEqual(await loaded, runDto())

  const promised = prepareSubagentRunPersistencePort(portDefinition({
    getRun: async (input) => runDto(input),
  }))
  assert.deepEqual(
    await promised.getRun({ userId: 'user-1', id: 'run-1' }),
    runDto(),
  )
})

test('SubagentRunPersistencePort never executes adapter accessors', () => {
  let portGetterCalls = 0
  const definition = portDefinition()
  Object.defineProperty(definition, 'id', {
    enumerable: true,
    get() {
      portGetterCalls += 1
      return 'attacker.port'
    },
  })
  assert.throws(
    () => prepareSubagentRunPersistencePort(definition),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_INVALID'
      && /own data property/.test(error.message),
  )
  assert.equal(portGetterCalls, 0)

  let outputGetterCalls = 0
  const outputWithGetter = runDto()
  Object.defineProperty(outputWithGetter, 'id', {
    enumerable: true,
    get() {
      outputGetterCalls += 1
      return 'run-1'
    },
  })
  const outputPort = prepareSubagentRunPersistencePort(portDefinition({
    getRun: () => outputWithGetter,
  }))
  assert.throws(
    () => outputPort.getRun({ userId: 'user-1', id: 'run-1' }),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID'
      && /own data property/.test(error.message),
  )
  assert.equal(outputGetterCalls, 0)

  let nestedGetterCalls = 0
  const nested = { type: 'checkpoint' }
  Object.defineProperty(nested, 'detail', {
    enumerable: true,
    get() {
      nestedGetterCalls += 1
      return { unsafe: true }
    },
  })
  const nestedPort = prepareSubagentRunPersistencePort(portDefinition({
    getRun: () => runDto({ trace: [nested] }),
  }))
  assert.throws(
    () => nestedPort.getRun({ userId: 'user-1', id: 'run-1' }),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID'
      && /own data property/.test(error.message),
  )
  assert.equal(nestedGetterCalls, 0)

  let thenGetterCalls = 0
  const resultWithThenGetter = {}
  Object.defineProperty(resultWithThenGetter, 'then', {
    enumerable: true,
    get() {
      thenGetterCalls += 1
      throw new Error('then getter must never run')
    },
  })
  const thenPort = prepareSubagentRunPersistencePort(portDefinition({
    getRun: () => resultWithThenGetter,
  }))
  assert.throws(
    () => thenPort.getRun({ userId: 'user-1', id: 'run-1' }),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID'
      && /result\.then/.test(error.message),
  )
  assert.equal(thenGetterCalls, 0)
})

test('SubagentRunPersistencePort projects deeply frozen run outputs', () => {
  const backend = runDto({
    trace: [{ type: 'checkpoint', detail: { files: ['a.txt'] } }],
  })
  const port = prepareSubagentRunPersistencePort(portDefinition({
    getRun: () => backend,
  }))
  const output = port.getRun({ userId: 'user-1', id: 'run-1' })

  assert.notEqual(output, backend)
  assert.equal(Object.isFrozen(output), true)
  assert.equal(Object.isFrozen(output.trace), true)
  assert.equal(Object.isFrozen(output.trace[0]), true)
  assert.equal(Object.isFrozen(output.trace[0].detail), true)
  assert.equal(Object.isFrozen(output.trace[0].detail.files), true)
})

test('SubagentRunPersistencePort is unavailable with a 503 until lifecycle activation', () => {
  assert.deepEqual(getSubagentRunPersistencePortStatus(), {
    configured: false,
    portId: null,
    apiVersion: SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION,
    source: null,
  })
  assert.equal(Object.isFrozen(getSubagentRunPersistencePortStatus()), true)
  assert.throws(
    () => getActiveSubagentRunPersistencePort(),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_NOT_CONFIGURED'
      && error?.statusCode === 503
      && error?.retryable === false,
  )
})

test('SubagentRunPersistencePort controller activates one binding and releases it', () => {
  const first = createSubagentRunPersistencePortController(portDefinition(), {
    source: 'test.lifecycle',
  })
  const second = createSubagentRunPersistencePortController(portDefinition({
    id: 'test.subagent-run-persistence.second',
  }))

  try {
    const active = first.activate()
    assert.equal(Object.isFrozen(active), true)
    assert.equal(first.activate(), active)
    assert.equal(getActiveSubagentRunPersistencePort(), active)
    assert.deepEqual(getSubagentRunPersistencePortStatus(), {
      configured: true,
      portId: 'test.subagent-run-persistence',
      apiVersion: SUBAGENT_RUN_PERSISTENCE_PORT_CONTRACT_VERSION,
      source: 'test.lifecycle',
    })
    assert.throws(
      () => second.activate(),
      (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_ALREADY_ACTIVE',
    )
  } finally {
    first.release()
    second.release()
  }

  assert.equal(first.release(), false)
  assert.equal(getSubagentRunPersistencePortStatus().configured, false)
})

test('listRunningRuns preserves global owner identity and rejects duplicate identities', () => {
  const port = prepareSubagentRunPersistencePort(portDefinition({
    listRunningRuns: () => [
      runDto({ userId: 'user-1', id: 'shared-run' }),
      runDto({ userId: 'user-2', id: 'shared-run' }),
    ],
  }))
  const output = port.listRunningRuns()

  assert.deepEqual(output.map(({ userId, id }) => ({ userId, id })), [
    { userId: 'user-1', id: 'shared-run' },
    { userId: 'user-2', id: 'shared-run' },
  ])
  assert.equal(Object.isFrozen(output), true)
  assert.ok(output.every((run) => Object.isFrozen(run)))

  const duplicate = prepareSubagentRunPersistencePort(portDefinition({
    listRunningRuns: () => [runDto(), runDto()],
  }))
  assert.throws(
    () => duplicate.listRunningRuns(),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID'
      && /duplicate owner\/run identity/.test(error.message),
  )
})

test('interruptRunningRun returns a frozen identity-bound receipt', () => {
  const port = prepareSubagentRunPersistencePort(portDefinition())
  const input = {
    userId: 'user-1',
    id: 'run-1',
    status: 'interrupted',
    resultText: 'stopped during recovery',
    trace: [{ type: 'interrupted' }],
    finishedAt: 103,
  }
  const receipt = port.interruptRunningRun(input)

  assert.deepEqual(receipt, {
    userId: 'user-1',
    id: 'run-1',
    interrupted: true,
  })
  assert.equal(Object.isFrozen(receipt), true)

  const mismatched = prepareSubagentRunPersistencePort(portDefinition({
    interruptRunningRun: () => ({
      userId: 'user-2',
      id: 'run-1',
      interrupted: true,
    }),
  }))
  assert.throws(
    () => mismatched.interruptRunningRun(input),
    (error) => error?.code === 'SUBAGENT_RUN_PERSISTENCE_PORT_IDENTITY_MISMATCH',
  )
})
