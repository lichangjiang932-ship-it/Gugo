import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  acquireHostTurnPersistenceCapability,
  createBoundTurnPersistenceAdapter,
  listRuntimeCapabilityContributions,
  prepareRuntimeCapabilitySnapshot,
  registerRuntimeCapabilityContribution,
  selectedToolLoopBinding,
  selectedToolLoopAdapter,
} from '../server/core/runtimeCapabilityHost.js'
import {
  BUILTIN_TOOL_LOOP_ADAPTER_ID,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
} from '../server/core/toolLoopAdapter.js'
import {
  prepareTurnPersistenceAdapter,
  TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION,
} from '../server/core/turnPersistenceAdapter.js'
import {
  isBuiltinSqliteTurnPersistenceProvenance,
  resolveBuiltinSqliteTurnPersistenceBootstrap,
} from '../server/adapters/builtinSqliteTurnPersistenceBootstrap.js'
import { SQLITE_TURN_PERSISTENCE_ADAPTER } from '../server/adapters/sqliteTurnPersistenceAdapter.js'
import {
  TURN_PERSISTENCE_MODULE_ENV,
  TURN_PERSISTENCE_TRUST_ROOT_ENV,
} from '../server/core/turnPersistenceBootstrap.js'

test('builtin runtime capability host binds one complete persistence backend', async () => {
  assert.equal(
    listRuntimeCapabilityContributions().some((entry) => entry.type === 'persistence'),
    false,
  )
  const lease = acquireHostTurnPersistenceCapability(SQLITE_TURN_PERSISTENCE_ADAPTER)
  try {
    assert.equal(Object.isFrozen(lease), true)
    assert.equal(lease.adapter.id, 'builtin.sqlite')
    const snapshot = await prepareRuntimeCapabilitySnapshot({
      cwd: process.cwd(),
      env: { APP_DATA_DIR: 'Z:\\gugo-capability-host-missing', GUGO_LOAD_DOTENV: '0' },
    })
    const types = new Set(listRuntimeCapabilityContributions().map((entry) => entry.type))
    assert.deepEqual([...types].sort(), ['loop', 'persistence', 'policy', 'provider', 'tool'])

    const loop = selectedToolLoopAdapter(snapshot)
    const persistence = createBoundTurnPersistenceAdapter(snapshot)
    assert.equal(loop.contractVersion, TOOL_LOOP_ADAPTER_CONTRACT_VERSION)
    assert.equal(persistence.contractVersion, TURN_PERSISTENCE_ADAPTER_CONTRACT_VERSION)
    assert.equal(typeof persistence.session.getSession, 'function')
    assert.equal(typeof persistence.eventLog.verifyTurnEventCommit, 'function')
    assert.equal(persistence.eventLog.supportsAtomicCheckpointState, true)
    assert.equal(typeof persistence.transactions.commitTurnStart, 'function')
    assert.equal(typeof persistence.transactions.commitTurnCheckpoint, 'function')
    assert.equal(typeof persistence.transactions.commitTurnBoundary, 'function')
  } finally {
    lease.release()
  }
})

test('host persistence lease prevents mismatched replacement and permits a fresh registration', () => {
  const secondInput = Object.freeze({
    ...SQLITE_TURN_PERSISTENCE_ADAPTER,
  })
  const lease = acquireHostTurnPersistenceCapability(SQLITE_TURN_PERSISTENCE_ADAPTER)
  try {
    assert.throws(
      () => acquireHostTurnPersistenceCapability(secondInput),
      (error) => error?.code === 'RUNTIME_BUILTIN_PERSISTENCE_ALREADY_REGISTERED',
    )
  } finally {
    lease.release()
  }

  const replacementLease = acquireHostTurnPersistenceCapability(secondInput)
  assert.equal(replacementLease.release(), true)
  assert.equal(replacementLease.release(), false)
})

test('overlapping hosts retain the shared backend until every owner lease releases', () => {
  const replacementInput = Object.freeze({
    ...SQLITE_TURN_PERSISTENCE_ADAPTER,
  })
  const first = acquireHostTurnPersistenceCapability(SQLITE_TURN_PERSISTENCE_ADAPTER)
  const second = acquireHostTurnPersistenceCapability(SQLITE_TURN_PERSISTENCE_ADAPTER)
  try {
    assert.equal(first.release(), true)
    assert.throws(
      () => acquireHostTurnPersistenceCapability(replacementInput),
      (error) => error?.code === 'RUNTIME_BUILTIN_PERSISTENCE_ALREADY_REGISTERED',
    )
    assert.equal(
      listRuntimeCapabilityContributions().some((entry) => entry.type === 'persistence'),
      true,
    )
  } finally {
    second.release()
  }

  const replacementLease = acquireHostTurnPersistenceCapability(replacementInput)
  assert.equal(replacementLease.release(), true)
})

test('prepared persistence identity is idempotent and interoperates with its raw owner', () => {
  const prepared = prepareTurnPersistenceAdapter(SQLITE_TURN_PERSISTENCE_ADAPTER)
  assert.strictEqual(prepareTurnPersistenceAdapter(SQLITE_TURN_PERSISTENCE_ADAPTER), prepared)
  assert.strictEqual(prepareTurnPersistenceAdapter(prepared), prepared)

  const rawOwner = acquireHostTurnPersistenceCapability(SQLITE_TURN_PERSISTENCE_ADAPTER)
  const preparedOwner = acquireHostTurnPersistenceCapability(prepared)
  assert.strictEqual(rawOwner.adapter, preparedOwner.adapter)
  assert.equal(rawOwner.release(), true)
  assert.equal(preparedOwner.release(), true)
})

test('independent built-in bootstraps share one prepared backend across overlapping hosts', async () => {
  const firstBootstrap = await resolveBuiltinSqliteTurnPersistenceBootstrap({ env: {} })
  const secondBootstrap = await resolveBuiltinSqliteTurnPersistenceBootstrap({ env: {} })
  assert.strictEqual(firstBootstrap.adapter, secondBootstrap.adapter)
  assert.notStrictEqual(firstBootstrap.provenance, secondBootstrap.provenance)
  assert.equal(Object.isFrozen(firstBootstrap.provenance), true)
  assert.equal(Object.isFrozen(secondBootstrap.provenance), true)
  assert.equal(
    isBuiltinSqliteTurnPersistenceProvenance(
      firstBootstrap.provenance,
      firstBootstrap.adapter,
    ),
    true,
  )
  assert.equal(
    isBuiltinSqliteTurnPersistenceProvenance(
      secondBootstrap.provenance,
      secondBootstrap.adapter,
    ),
    true,
  )

  const replacementInput = Object.freeze({
    ...SQLITE_TURN_PERSISTENCE_ADAPTER,
  })
  const first = acquireHostTurnPersistenceCapability(firstBootstrap.adapter)
  const second = acquireHostTurnPersistenceCapability(secondBootstrap.adapter)
  try {
    assert.equal(first.release(), true)
    assert.throws(
      () => acquireHostTurnPersistenceCapability(replacementInput),
      (error) => error?.code === 'RUNTIME_BUILTIN_PERSISTENCE_ALREADY_REGISTERED',
    )
  } finally {
    second.release()
  }

  const replacementLease = acquireHostTurnPersistenceCapability(replacementInput)
  assert.equal(replacementLease.release(), true)
})

test('repeated trusted-module bootstraps share the cached ESM adapter lease', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-persistence-owner-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const modulePath = path.join(root, 'adapter.mjs')
  const sqliteAdapterUrl = new URL(
    '../server/adapters/sqliteTurnPersistenceAdapter.js',
    import.meta.url,
  )
  fs.writeFileSync(
    modulePath,
    `export { SQLITE_TURN_PERSISTENCE_ADAPTER as turnPersistenceAdapter } from ${JSON.stringify(sqliteAdapterUrl.href)}\n`,
    'utf8',
  )
  const options = {
    cwd: root,
    env: {
      [TURN_PERSISTENCE_MODULE_ENV]: modulePath,
      [TURN_PERSISTENCE_TRUST_ROOT_ENV]: root,
    },
  }

  const firstBootstrap = await resolveBuiltinSqliteTurnPersistenceBootstrap(options)
  const secondBootstrap = await resolveBuiltinSqliteTurnPersistenceBootstrap(options)
  assert.strictEqual(firstBootstrap.adapter, secondBootstrap.adapter)
  assert.notStrictEqual(firstBootstrap.provenance, secondBootstrap.provenance)
  assert.equal(firstBootstrap.provenance.source, 'module')
  assert.equal(secondBootstrap.provenance.source, 'module')
  assert.equal(
    isBuiltinSqliteTurnPersistenceProvenance(
      firstBootstrap.provenance,
      firstBootstrap.adapter,
    ),
    false,
  )

  const first = acquireHostTurnPersistenceCapability(firstBootstrap.adapter)
  const second = acquireHostTurnPersistenceCapability(secondBootstrap.adapter)
  assert.strictEqual(first.adapter, second.adapter)
  assert.equal(first.release(), true)
  assert.equal(second.release(), true)
})

test('selected Loop binding snapshots builtin identity as deeply frozen data', async () => {
  const snapshot = await prepareRuntimeCapabilitySnapshot({
    env: { APP_DATA_DIR: 'Z:\\gugo-loop-binding-missing', GUGO_LOAD_DOTENV: '0' },
  })
  const binding = selectedToolLoopBinding(snapshot)

  assert.strictEqual(binding.adapter, selectedToolLoopAdapter(snapshot))
  assert.deepEqual(binding.identity, {
    adapterId: BUILTIN_TOOL_LOOP_ADAPTER_ID,
    owner: 'builtin',
    version: '0.11.31',
    revision: 1,
    releaseDigest: null,
    contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
    brokerVersion: 0,
    source: 'registry_default',
    generation: binding.identity.generation,
    provenance: {
      capabilityId: BUILTIN_TOOL_LOOP_ADAPTER_ID,
      type: 'loop',
      slot: 'loop',
      binding: 'loop:loop',
      source: 'registry_default',
      generation: binding.identity.generation,
    },
  })
  assert.equal(Object.isFrozen(binding), true)
  assert.equal(Object.isFrozen(binding.identity), true)
  assert.equal(Object.isFrozen(binding.identity.provenance), true)
  assert.doesNotMatch(JSON.stringify(binding.identity), /run/u)
})

test('selected Loop binding follows plugin default and explicit builtin provenance', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-loop-binding-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(root, '.gugo'), { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const releaseDigest = `sha256-${'b'.repeat(64)}`
  const adapter = Object.freeze({
    id: 'plugin.snapshot-loop',
    contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
    run: async () => ({ text: 'fixture' }),
  })
  const dispose = registerRuntimeCapabilityContribution({
    id: adapter.id,
    type: 'loop',
    owner: 'snapshot-plugin',
    version: '2.3.4',
    revision: 9,
    priority: 100,
    replaces: BUILTIN_TOOL_LOOP_ADAPTER_ID,
    releaseDigest,
    implementation: adapter,
    healthCheck: () => true,
  })
  try {
    const pluginSnapshot = await prepareRuntimeCapabilitySnapshot({
      cwd: root,
      env: { APP_DATA_DIR: dataDir, GUGO_LOAD_DOTENV: '0' },
    })
    const pluginBinding = selectedToolLoopBinding(pluginSnapshot)
    assert.strictEqual(pluginBinding.adapter, adapter)
    assert.deepEqual(
      {
        adapterId: pluginBinding.identity.adapterId,
        owner: pluginBinding.identity.owner,
        version: pluginBinding.identity.version,
        revision: pluginBinding.identity.revision,
        releaseDigest: pluginBinding.identity.releaseDigest,
        source: pluginBinding.identity.source,
      },
      {
        adapterId: adapter.id,
        owner: 'snapshot-plugin',
        version: '2.3.4',
        revision: 9,
        releaseDigest,
        source: 'registry_default',
      },
    )

    fs.writeFileSync(path.join(root, '.gugo', 'runtime.json'), JSON.stringify({
      env: {},
      capabilityBindings: { loop: BUILTIN_TOOL_LOOP_ADAPTER_ID },
    }))
    const explicitSnapshot = await prepareRuntimeCapabilitySnapshot({
      cwd: root,
      env: { APP_DATA_DIR: dataDir, GUGO_LOAD_DOTENV: '0' },
    })
    const explicitBinding = selectedToolLoopBinding(explicitSnapshot)
    assert.equal(explicitBinding.identity.adapterId, BUILTIN_TOOL_LOOP_ADAPTER_ID)
    assert.equal(explicitBinding.identity.source, 'project_config')
    assert.equal(explicitBinding.identity.provenance.source, 'project_config')
  } finally {
    dispose()
    await prepareRuntimeCapabilitySnapshot({
      env: { APP_DATA_DIR: 'Z:\\gugo-loop-binding-reset', GUGO_LOAD_DOTENV: '0' },
    })
  }
})

function loopSnapshotFixture({ entry: entryOverrides = {}, adapter: adapterOverrides = {} } = {}) {
  const adapter = Object.freeze({
    id: 'plugin.fixture-loop',
    contractVersion: 2,
    run: async () => ({ text: 'fixture' }),
    ...adapterOverrides,
  })
  const entry = Object.freeze({
    id: adapter.id,
    type: 'loop',
    slot: 'loop',
    owner: 'fixture-plugin',
    version: '1.2.3',
    revision: 4,
    releaseDigest: `sha256-${'c'.repeat(64)}`,
    binding: 'loop:loop',
    source: 'explicit_config',
    generation: 7,
    ...entryOverrides,
  })
  return Object.freeze({
    effectiveBindings: Object.freeze([entry]),
    get: () => adapter,
  })
}

test('selected Loop binding accepts v3 only with the complete broker declaration', () => {
  const hostCapabilities = Object.freeze({ loopBroker: 1 })
  const snapshot = loopSnapshotFixture({
    adapter: { contractVersion: 3, hostCapabilities },
  })
  const binding = selectedToolLoopBinding(snapshot)
  assert.equal(binding.identity.contractVersion, 3)
  assert.equal(binding.identity.brokerVersion, 1)

  assert.throws(
    () => selectedToolLoopBinding(loopSnapshotFixture({ adapter: { contractVersion: 3 } })),
    (error) => error?.code === 'RUNTIME_LOOP_BINDING_INVALID',
  )
  assert.throws(
    () => selectedToolLoopBinding(loopSnapshotFixture({
      adapter: {
        contractVersion: 3,
        hostCapabilities: Object.freeze({ loopBroker: 2 }),
      },
    })),
    (error) => error?.code === 'RUNTIME_LOOP_BINDING_VERSION_UNSUPPORTED',
  )
})

test('selected Loop binding rejects incomplete, forged, and accessor-backed snapshots', () => {
  assert.throws(
    () => selectedToolLoopBinding(loopSnapshotFixture({ entry: { revision: '4' } })),
    (error) => error?.code === 'RUNTIME_LOOP_BINDING_INVALID',
  )
  assert.throws(
    () => selectedToolLoopBinding(loopSnapshotFixture({ entry: { id: 'plugin.forged-loop' } })),
    (error) => error?.code === 'RUNTIME_LOOP_BINDING_IDENTITY_MISMATCH',
  )
  assert.throws(
    () => selectedToolLoopBinding(loopSnapshotFixture({ adapter: { contractVersion: 99 } })),
    (error) => error?.code === 'RUNTIME_LOOP_BINDING_VERSION_UNSUPPORTED',
  )

  let adapterGetterReads = 0
  const accessorSnapshot = {}
  Object.defineProperties(accessorSnapshot, {
    effectiveBindings: {
      value: loopSnapshotFixture().effectiveBindings,
      enumerable: true,
    },
    get: {
      enumerable: true,
      get() {
        adapterGetterReads += 1
        return () => null
      },
    },
  })
  assert.throws(
    () => selectedToolLoopBinding(accessorSnapshot),
    (error) => error?.code === 'RUNTIME_LOOP_BINDING_INVALID',
  )
  assert.equal(adapterGetterReads, 0)

  let ownerGetterReads = 0
  const accessorEntry = {
    ...loopSnapshotFixture().effectiveBindings[0],
  }
  Object.defineProperty(accessorEntry, 'owner', {
    enumerable: true,
    get() {
      ownerGetterReads += 1
      return 'fixture-plugin'
    },
  })
  const entryAccessorSnapshot = Object.freeze({
    effectiveBindings: Object.freeze([Object.freeze(accessorEntry)]),
    get: loopSnapshotFixture().get,
  })
  assert.throws(
    () => selectedToolLoopBinding(entryAccessorSnapshot),
    (error) => error?.code === 'RUNTIME_LOOP_BINDING_INVALID',
  )
  assert.equal(ownerGetterReads, 0)
})
