import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOOP_HOST_ADAPTER_CONTRACT_VERSION,
  LOOP_HOST_BROKER_API_VERSION,
  LOOP_HOST_CAPABILITY_DECLARATION_MAX_BYTES,
  LOOP_HOST_CAPABILITY_ERROR_CODES,
  LOOP_HOST_SUPPORTED_ADAPTER_CONTRACT_VERSIONS,
  prepareLoopHostCapability,
} from '../server/core/loopHostCapability.js'

function adapter(overrides = {}) {
  return {
    id: 'external.loop',
    contractVersion: LOOP_HOST_ADAPTER_CONTRACT_VERSION,
    hostCapabilities: { loopBroker: LOOP_HOST_BROKER_API_VERSION },
    run() {},
    ...overrides,
  }
}

function invalidDeclaration(error) {
  return error?.code === LOOP_HOST_CAPABILITY_ERROR_CODES.INVALID_DECLARATION
    && error?.retryable === false
}

test('exports the v1 broker handshake and supported v2/v3 adapter contracts', () => {
  assert.equal(LOOP_HOST_BROKER_API_VERSION, 1)
  assert.equal(LOOP_HOST_ADAPTER_CONTRACT_VERSION, 3)
  assert.deepEqual(LOOP_HOST_SUPPORTED_ADAPTER_CONTRACT_VERSIONS, [2, 3])
  assert.equal(Object.isFrozen(LOOP_HOST_SUPPORTED_ADAPTER_CONTRACT_VERSIONS), true)
})

test('prepares a bounded deeply frozen pure-data v3 capability snapshot', () => {
  const source = adapter({
    provider: { requestModel() { throw new Error('must not escape') } },
    executor: () => { throw new Error('must not escape') },
  })
  const snapshot = prepareLoopHostCapability(source)

  assert.deepEqual(snapshot, {
    apiVersion: 1,
    adapterContractVersion: 3,
    hostCapabilities: { loopBroker: 1 },
  })
  assert.notEqual(snapshot.hostCapabilities, source.hostCapabilities)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.hostCapabilities), true)
  assert.equal(Object.hasOwn(snapshot, 'provider'), false)
  assert.equal(Object.hasOwn(snapshot, 'executor'), false)
  assert.doesNotThrow(() => structuredClone(snapshot))
  assert.ok(
    Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
      <= LOOP_HOST_CAPABILITY_DECLARATION_MAX_BYTES,
  )
})

test('keeps v2 declaration optional without granting an implicit broker capability', () => {
  const snapshot = prepareLoopHostCapability({
    id: 'external.v2',
    contractVersion: 2,
    run() {},
  })

  assert.deepEqual(snapshot, {
    apiVersion: 1,
    adapterContractVersion: 2,
    hostCapabilities: {},
  })
  assert.equal(Object.isFrozen(snapshot.hostCapabilities), true)
})

test('rejects unsupported adapter versions with a stable separate error code', () => {
  for (const contractVersion of [1, 4, '3', null]) {
    assert.throws(
      () => prepareLoopHostCapability(adapter({ contractVersion })),
      (error) => (
        error?.code === LOOP_HOST_CAPABILITY_ERROR_CODES.UNSUPPORTED_ADAPTER_VERSION
        && error?.retryable === false
      ),
    )
  }
})

test('v3 requires own data capability fields and builtin id spoofing cannot bypass it', () => {
  assert.throws(
    () => prepareLoopHostCapability({
      id: 'builtin.agent-loop',
      contractVersion: 3,
      run() {},
    }),
    invalidDeclaration,
  )

  const inherited = Object.create({ loopBroker: 1 })
  assert.throws(
    () => prepareLoopHostCapability(adapter({ hostCapabilities: inherited })),
    invalidDeclaration,
  )
  assert.throws(
    () => prepareLoopHostCapability(adapter({ hostCapabilities: {} })),
    invalidDeclaration,
  )
  assert.throws(
    () => prepareLoopHostCapability(adapter({
      hostCapabilities: { loopBroker: 2 },
    })),
    invalidDeclaration,
  )
})

test('never executes adapter or nested capability accessors', () => {
  let adapterGetterCalls = 0
  const accessorAdapter = adapter()
  Object.defineProperty(accessorAdapter, 'hostCapabilities', {
    enumerable: true,
    get() {
      adapterGetterCalls += 1
      return { loopBroker: 1 }
    },
  })
  assert.throws(
    () => prepareLoopHostCapability(accessorAdapter),
    invalidDeclaration,
  )
  assert.equal(adapterGetterCalls, 0)

  let nestedGetterCalls = 0
  const hostCapabilities = {}
  Object.defineProperty(hostCapabilities, 'loopBroker', {
    enumerable: true,
    get() {
      nestedGetterCalls += 1
      return 1
    },
  })
  assert.throws(
    () => prepareLoopHostCapability(adapter({ hostCapabilities })),
    invalidDeclaration,
  )
  assert.equal(nestedGetterCalls, 0)
})

test('rejects adapter and nested Proxies without invoking their traps', () => {
  let adapterTraps = 0
  const proxiedAdapter = new Proxy(adapter(), {
    get() {
      adapterTraps += 1
      throw new Error('adapter proxy trap must not run')
    },
    getOwnPropertyDescriptor() {
      adapterTraps += 1
      throw new Error('adapter descriptor trap must not run')
    },
  })
  assert.throws(
    () => prepareLoopHostCapability(proxiedAdapter),
    invalidDeclaration,
  )
  assert.equal(adapterTraps, 0)

  let capabilityTraps = 0
  const proxiedCapabilities = new Proxy({ loopBroker: 1 }, {
    ownKeys() {
      capabilityTraps += 1
      throw new Error('capability proxy trap must not run')
    },
    getOwnPropertyDescriptor() {
      capabilityTraps += 1
      throw new Error('capability descriptor trap must not run')
    },
  })
  assert.throws(
    () => prepareLoopHostCapability(adapter({
      hostCapabilities: proxiedCapabilities,
    })),
    invalidDeclaration,
  )
  assert.equal(capabilityTraps, 0)
})

test('rejects shared memory, non-cloneable values, symbols, and oversized unknown fields', () => {
  if (typeof SharedArrayBuffer === 'function') {
    assert.throws(
      () => prepareLoopHostCapability(adapter({
        hostCapabilities: new SharedArrayBuffer(8),
      })),
      invalidDeclaration,
    )
    assert.throws(
      () => prepareLoopHostCapability(adapter({
        hostCapabilities: {
          loopBroker: new Uint8Array(new SharedArrayBuffer(8)),
        },
      })),
      invalidDeclaration,
    )
  }

  for (const hostCapabilities of [
    { loopBroker() {} },
    { loopBroker: Symbol('broker') },
    { loopBroker: 1n },
    { loopBroker: 1, executor() {} },
    { loopBroker: 1, [Symbol('provider')]: {} },
    { loopBroker: 1, ['x'.repeat(4096)]: true },
  ]) {
    assert.throws(
      () => prepareLoopHostCapability(adapter({ hostCapabilities })),
      invalidDeclaration,
    )
  }
})
