import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse } from 'acorn'

import { assembleTurnEnginePersistence } from '../server/services/turnEnginePersistenceAssembly.js'
import { TURN_ENGINE_FLAT_PERSISTENCE_OPTIONS } from '../server/services/turnEnginePersistenceBundle.js'
import { createTestTurnEnginePersistence } from './helpers/turnEnginePersistence.js'

test('bundle assembly preserves the prepared bundle and every authoritative port identity', () => {
  const persistence = createTestTurnEnginePersistence()
  const assembled = assembleTurnEnginePersistence({ persistence })

  assert.equal(assembled.persistence, persistence)
  assert.equal(assembled.ports.appendEvent, persistence.eventLog.appendTurnEvent)
  assert.equal(assembled.ports.appendEventBatch, persistence.eventLog.appendTurnEvents)
  assert.equal(assembled.ports.verifyEventCommit, persistence.eventLog.verifyTurnEventCommit)
  assert.equal(assembled.ports.readSession, persistence.session.getSession)
  assert.equal(assembled.ports.commitTurnBoundary, persistence.transactions.commitTurnBoundary)
  assert.equal(assembled.ports.executionLeases, persistence.executionLeases)
  assert.equal(assembled.ports.runtimeCore, persistence.runtimeCore)
  assert.equal(assembled.ports.enqueueSteering, persistence.steering.enqueueTurnSteering)
  assert.equal(assembled.ports.readRecoveryState, persistence.recovery.getTurnRecoveryState)
  assert.equal(
    assembled.ports.readPendingModelRequest,
    persistence.modelRequestRecovery.getPendingModelRequestRecovery,
  )
  assert.equal(assembled.ports.supportsAtomicCheckpointState, true)
})

test('bundle assembly rejects every own flat option even when its value is undefined', () => {
  const persistence = createTestTurnEnginePersistence()

  for (const option of TURN_ENGINE_FLAT_PERSISTENCE_OPTIONS) {
    assert.throws(
      () => assembleTurnEnginePersistence({ persistence, [option]: undefined }),
      (error) => error?.code === 'TURN_ENGINE_PERSISTENCE_BUNDLE_CONFLICT'
        && error.message.includes(option),
      option,
    )
  }
})

test('bundle assembly accepts non-persistence decorators without replacing host resources', () => {
  const persistence = createTestTurnEnginePersistence()
  const writer = Object.freeze({ id: 'decorated-writer' })
  const recordEmergencyFailure = () => {}
  const assembled = assembleTurnEnginePersistence({
    persistence,
    eventWriteBehindFactory: () => writer,
    eventEmitterFactory: () => null,
    recordEmergencyFailure,
  })

  assert.equal(assembled.persistence, persistence)
  assert.equal(assembled.ports.runtimeCore, persistence.runtimeCore)
  assert.equal(assembled.ports.recordEmergencyFailure, recordEmergencyFailure)
  assert.equal(assembled.ports.createEventWriteBehind(), writer)
})

test('flat assembly creates isolated lease and runtime cores by default', () => {
  const first = assembleTurnEnginePersistence()
  const second = assembleTurnEnginePersistence()

  assert.notEqual(first.ports.executionLeases, second.ports.executionLeases)
  assert.notEqual(first.ports.runtimeCore, second.ports.runtimeCore)
  assert.notEqual(first.ports.runtimeCore.lease.ownerId, second.ports.runtimeCore.lease.ownerId)
})

test('flat assembly wires only supplied checkpoint functions into the derived runtime core', () => {
  const calls = []
  const readCheckpoint = (scope) => ({ ...scope, state: 'loaded' })
  const writeCheckpoint = (input) => {
    calls.push(input)
    return 'saved'
  }
  const assembled = assembleTurnEnginePersistence({ readCheckpoint, writeCheckpoint })

  assert.deepEqual(
    assembled.ports.runtimeCore.checkpoint.load({ turnId: 'turn-1' }),
    { turnId: 'turn-1', state: 'loaded' },
  )
  assert.equal(
    assembled.ports.runtimeCore.checkpoint.save(
      { turnId: 'turn-1' },
      { messages: [] },
      { sequence: 4 },
    ),
    'saved',
  )
  assert.deepEqual(calls, [{ turnId: 'turn-1', sequence: 4, state: { messages: [] } }])
})

test('writer selection requires a fresh writer factory and otherwise creates isolated default writers', async () => {
  const factoryWriter = Object.freeze({ id: 'factory-writer' })
  const sharedWriter = Object.freeze({ id: 'shared-writer' })
  const factoryAssembly = assembleTurnEnginePersistence({
    eventWriteBehindFactory: () => factoryWriter,
  })
  assert.equal(factoryAssembly.ports.createEventWriteBehind(), factoryWriter)

  assert.throws(
    () => assembleTurnEnginePersistence({ eventWriteBehind: sharedWriter }),
    (error) => error?.code === 'TURN_EVENT_WRITER_INSTANCE_UNSUPPORTED',
  )
  assert.throws(
    () => factoryAssembly.ports.createEventWriteBehind(),
    (error) => error?.code === 'TURN_EVENT_WRITER_REUSED',
  )

  const batches = []
  const defaultAssembly = assembleTurnEnginePersistence({
    appendEvent: () => {
      throw new Error('single append must not run when an explicit batch appender exists')
    },
    appendEventBatch: async (entries) => { batches.push(entries) },
  })
  const first = defaultAssembly.ports.createEventWriteBehind()
  const second = defaultAssembly.ports.createEventWriteBehind()
  assert.notEqual(first, second)
  first.enqueue({ id: 'event-1' })
  first.enqueue({ id: 'event-2' })
  await first.flush()
  assert.deepEqual(batches, [[{ id: 'event-1' }, { id: 'event-2' }]])
  await second.close()
})

test('custom single-event persistence without an atomic batch appender fails closed', () => {
  assert.throws(
    () => assembleTurnEnginePersistence({ appendEvent: async () => {} }),
    (error) => error?.code === 'TURN_EVENT_BATCH_APPENDER_REQUIRED'
      && error.retryable === false,
  )
})

function importSpecifiers(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const values = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (
      (node.type === 'ImportDeclaration'
        || node.type === 'ExportNamedDeclaration'
        || node.type === 'ExportAllDeclaration')
      && typeof node.source?.value === 'string'
    ) {
      values.push(node.source.value)
    }
    if (node.type === 'ImportExpression' && typeof node.source?.value === 'string') {
      values.push(node.source.value)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast)
  return values
}

test('persistence assembly stays one-way and Turn runtimes avoid concrete persistence stores', () => {
  const assemblyFile = fileURLToPath(
    new URL('../server/services/turnEnginePersistenceAssembly.js', import.meta.url),
  )
  const turnEngineFile = fileURLToPath(new URL('../server/services/TurnEngine.js', import.meta.url))
  const assemblyImports = importSpecifiers(readFileSync(assemblyFile, 'utf8'))
  const turnEngineImports = importSpecifiers(readFileSync(turnEngineFile, 'utf8'))
  const turnRuntimeImports = [
    'turnExecutionRuntime.js',
    'turnLoopExecutionRuntime.js',
    'turnSchedulingRuntime.js',
  ].map((file) => ({
    file,
    imports: importSpecifiers(readFileSync(fileURLToPath(
      new URL(`../server/services/${file}`, import.meta.url),
    ), 'utf8')),
  }))
  const forbiddenAssemblyImports = new Set([
    './TurnEngine.js',
    './turnEngineHost.js',
    '../core/turnPersistenceAdapter.js',
    '../adapters/sqliteTurnPersistenceAdapter.js',
    '../db.js',
  ])
  const concreteTurnEngineImports = new Set([
    './sessionStore.js',
    './turnEventStore.js',
    './eventWriteBehind.js',
    './turnExecutionLeaseRuntime.js',
    './turnRecoveryStateStore.js',
    './runtimeCore.js',
    './turnSteeringStore.js',
    './modelRequestRecoveryService.js',
    './turnEnginePersistenceBundle.js',
  ])

  assert.deepEqual(
    assemblyImports.filter((specifier) => forbiddenAssemblyImports.has(specifier)),
    [],
  )
  assert.equal(assemblyImports.includes('./TurnEngine.js'), false)
  assert.equal(turnEngineImports.includes('./turnEnginePersistenceAssembly.js'), true)
  assert.deepEqual(
    turnEngineImports.filter((specifier) => concreteTurnEngineImports.has(specifier)),
    [],
  )
  for (const { file, imports } of turnRuntimeImports) {
    assert.deepEqual(
      imports.filter((specifier) => concreteTurnEngineImports.has(specifier)),
      [],
      file,
    )
  }
})
