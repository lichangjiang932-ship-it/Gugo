import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LOOP_HARNESS_SESSION_API_VERSION,
  LOOP_HARNESS_SESSION_ERROR_CODES,
  LOOP_HARNESS_SESSION_LIMITS,
  assertLoopHarnessSession,
  createLoopHarnessSession,
} from '../server/core/loopHarnessSession.js'

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code, retryable: false })
}

function controlledLease(bindingOverrides = {}) {
  let status = 'active'
  let binding = {
    adapterId: 'external.loop',
    contractVersion: 3,
    brokerVersion: 1,
    generation: 1,
    ...bindingOverrides,
  }
  let assertions = 0
  const lease = {
    assertActive() {
      assertions += 1
      if (status === 'revoked') {
        throw codedError('TOOL_LOOP_RUN_LEASE_REVOKED')
      }
      if (status === 'stale') {
        throw codedError('TOOL_LOOP_RUN_LEASE_STALE')
      }
      return binding
    },
  }
  return {
    lease,
    assertions: () => assertions,
    revoke: () => { status = 'revoked' },
    stale: () => { status = 'stale' },
    rebind: (next) => { binding = next },
  }
}

function isCode(code) {
  return (error) => error?.code === code && error?.retryable === false
}

test('creates a branded frozen v1 session with detached pure-data snapshots', () => {
  const control = controlledLease()
  const metadata = { runId: 'run-1', nested: { tags: ['local'] } }
  const session = createLoopHarnessSession({ lease: control.lease, metadata })

  assert.equal(LOOP_HARNESS_SESSION_API_VERSION, 1)
  assert.deepEqual(Reflect.ownKeys(session), [
    'apiVersion',
    'metadata',
    'binding',
    'model',
    'tools',
  ])
  assert.equal(session.apiVersion, 1)
  assert.notEqual(session.metadata, metadata)
  assert.notEqual(session.metadata.nested, metadata.nested)
  assert.equal(Object.isFrozen(session), true)
  assert.equal(Object.isFrozen(session.metadata), true)
  assert.equal(Object.isFrozen(session.metadata.nested), true)
  assert.equal(Object.isFrozen(session.metadata.nested.tags), true)
  assert.equal(Object.isFrozen(session.binding), true)
  assert.equal(Object.isFrozen(session.model), true)
  assert.equal(Object.isFrozen(session.tools), true)
  assert.deepEqual(Reflect.ownKeys(session.model), ['request'])
  assert.deepEqual(Reflect.ownKeys(session.tools), ['execute'])
  assert.equal(Object.hasOwn(session, 'brokers'), false)
  assert.equal(Object.hasOwn(session, 'lease'), false)
  assert.equal(assertLoopHarnessSession(session), session)
  assert.throws(
    () => assertLoopHarnessSession({ ...session }),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.INVALID),
  )

  metadata.nested.tags.push('mutated')
  assert.deepEqual(session.metadata.nested.tags, ['local'])
})

test('clones and freezes every broker request and result behind private closures', async () => {
  const control = controlledLease()
  const observed = []
  const session = createLoopHarnessSession({
    lease: control.lease,
    metadata: { runId: 'run-2' },
    brokers: {
      modelRequest(request) {
        observed.push(request)
        assert.equal(Object.isFrozen(request), true)
        assert.equal(Object.isFrozen(request.messages), true)
        return { ok: true, echo: request.messages }
      },
      async toolsExecute(request) {
        observed.push(request)
        assert.equal(Object.isFrozen(request), true)
        return { ok: true, call: request }
      },
    },
  })
  const modelInput = { messages: [{ role: 'user', content: 'hello' }] }
  const toolInput = { name: 'read_file', arguments: { path: 'a.txt' } }
  const modelResult = session.model.request(modelInput)
  const toolResult = await session.tools.execute(toolInput)

  assert.notEqual(observed[0], modelInput)
  assert.notEqual(observed[1], toolInput)
  assert.deepEqual(modelResult, { ok: true, echo: modelInput.messages })
  assert.deepEqual(toolResult, { ok: true, call: toolInput })
  assert.equal(Object.isFrozen(modelResult), true)
  assert.equal(Object.isFrozen(modelResult.echo), true)
  assert.equal(Object.isFrozen(toolResult), true)
  assert.notEqual(modelResult.echo, observed[0].messages)
  assert.notEqual(toolResult.call, observed[1])
  assert.ok(control.assertions() >= 9)
})

test('fails closed with stable errors when a run has no injected broker', () => {
  const control = controlledLease()
  const session = createLoopHarnessSession({ lease: control.lease })

  assert.throws(
    () => session.model.request({}),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.MODEL_BROKER_UNAVAILABLE),
  )
  assert.throws(
    () => session.tools.execute({}),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.TOOL_BROKER_UNAVAILABLE),
  )
})

test('propagates revoked and stale leases before invoking broker authority', () => {
  for (const [transition, code] of [
    ['revoke', 'TOOL_LOOP_RUN_LEASE_REVOKED'],
    ['stale', 'TOOL_LOOP_RUN_LEASE_STALE'],
  ]) {
    const control = controlledLease()
    let calls = 0
    const session = createLoopHarnessSession({
      lease: control.lease,
      brokers: { modelRequest() { calls += 1; return {} } },
    })
    control[transition]()
    assert.throws(() => session.model.request({}), isCode(code))
    assert.equal(calls, 0)
  }
})

test('detects a changed binding even when a lease still claims to be active', () => {
  const control = controlledLease()
  const session = createLoopHarnessSession({
    lease: control.lease,
    brokers: { modelRequest() { return {} } },
  })
  control.rebind({
    adapterId: 'external.other',
    contractVersion: 3,
    brokerVersion: 1,
    generation: 2,
  })
  assert.throws(
    () => session.model.request({}),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.BINDING_STALE),
  )
})

test('rejects a broker result that settles after its run was revoked', async () => {
  const control = controlledLease()
  let resolveResult
  const pending = new Promise((resolve) => { resolveResult = resolve })
  const session = createLoopHarnessSession({
    lease: control.lease,
    brokers: { modelRequest: () => pending },
  })
  const result = session.model.request({ prompt: 'hello' })
  control.revoke()
  resolveResult({ text: 'must not escape' })

  await assert.rejects(result, isCode('TOOL_LOOP_RUN_LEASE_REVOKED'))
})

test('checks the lease after synchronous broker execution', () => {
  const control = controlledLease()
  const session = createLoopHarnessSession({
    lease: control.lease,
    brokers: {
      toolsExecute() {
        control.revoke()
        return { ok: true }
      },
    },
  })
  assert.throws(
    () => session.tools.execute({ name: 'noop' }),
    isCode('TOOL_LOOP_RUN_LEASE_REVOKED'),
  )
})

test('facade methods cannot be detached or borrowed across sessions', () => {
  const first = createLoopHarnessSession({
    lease: controlledLease({ adapterId: 'loop.first' }).lease,
    brokers: { modelRequest: () => ({ owner: 'first' }), toolsExecute: () => ({}) },
  })
  const second = createLoopHarnessSession({
    lease: controlledLease({ adapterId: 'loop.second' }).lease,
    brokers: { modelRequest: () => ({ owner: 'second' }), toolsExecute: () => ({}) },
  })

  assert.throws(
    () => first.model.request.call(second.model, {}),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.INVALID),
  )
  assert.throws(
    () => first.tools.execute.call(second.tools, {}),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.INVALID),
  )
  const detached = first.model.request
  assert.throws(
    () => detached({}),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.INVALID),
  )
  assert.deepEqual(second.model.request({}), { owner: 'second' })
})

test('rejects accessors and Proxies without executing attacker code', () => {
  let getterCalls = 0
  const metadata = {}
  Object.defineProperty(metadata, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'must not run'
    },
  })
  assert.throws(
    () => createLoopHarnessSession({ lease: controlledLease().lease, metadata }),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.BOUNDARY_INVALID),
  )
  assert.equal(getterCalls, 0)

  let traps = 0
  const payload = new Proxy({ prompt: 'hello' }, {
    ownKeys() { traps += 1; throw new Error('must not run') },
    getOwnPropertyDescriptor() { traps += 1; throw new Error('must not run') },
  })
  const session = createLoopHarnessSession({
    lease: controlledLease().lease,
    brokers: { modelRequest: () => ({}) },
  })
  assert.throws(
    () => session.model.request(payload),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.BOUNDARY_INVALID),
  )
  assert.equal(traps, 0)
})

test('rejects shared memory, non-cloneable values, cycles, and oversized payloads', () => {
  const control = controlledLease()
  const session = createLoopHarnessSession({
    lease: control.lease,
    brokers: {
      modelRequest: () => ({ tooLarge: 'x'.repeat(LOOP_HARNESS_SESSION_LIMITS.modelResultBytes) }),
      toolsExecute: () => ({ ok: true }),
    },
  })
  for (const payload of [
    { callback() {} },
    { symbol: Symbol('no') },
    { bigint: 1n },
    { date: new Date() },
  ]) {
    assert.throws(
      () => session.tools.execute(payload),
      isCode(LOOP_HARNESS_SESSION_ERROR_CODES.BOUNDARY_INVALID),
    )
  }
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(
    () => session.tools.execute(cyclic),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.BOUNDARY_INVALID),
  )
  if (typeof SharedArrayBuffer === 'function') {
    assert.throws(
      () => session.tools.execute({ shared: new SharedArrayBuffer(8) }),
      isCode(LOOP_HARNESS_SESSION_ERROR_CODES.BOUNDARY_INVALID),
    )
  }
  assert.throws(
    () => session.model.request({
      prompt: 'x'.repeat(LOOP_HARNESS_SESSION_LIMITS.modelRequestBytes),
    }),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.PAYLOAD_TOO_LARGE),
  )
  assert.throws(
    () => session.model.request({ prompt: 'small' }),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.PAYLOAD_TOO_LARGE),
  )
})

test('rejects unsafe constructor records and enforces combined session data size', () => {
  const control = controlledLease()
  assert.throws(
    () => createLoopHarnessSession({
      lease: control.lease,
      unknown: true,
    }),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.INVALID),
  )
  assert.throws(
    () => createLoopHarnessSession({
      lease: control.lease,
      brokers: { modelRequest: 'raw-provider' },
    }),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.INVALID),
  )
  assert.throws(
    () => createLoopHarnessSession({
      lease: control.lease,
      metadata: { value: 'x'.repeat(LOOP_HARNESS_SESSION_LIMITS.metadataBytes) },
    }),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.PAYLOAD_TOO_LARGE),
  )
})

test('maps revoked Proxies at every public boundary without leaking native errors', () => {
  const revoked = (target = {}) => {
    const revocable = Proxy.revocable(target, {})
    revocable.revoke()
    return revocable.proxy
  }

  assert.throws(
    () => createLoopHarnessSession(revoked()),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.INVALID),
  )
  assert.throws(
    () => createLoopHarnessSession({ lease: revoked() }),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.INVALID),
  )
  assert.throws(
    () => createLoopHarnessSession({
      lease: controlledLease().lease,
      brokers: revoked(),
    }),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.INVALID),
  )

  let brokerCalls = 0
  const requestSession = createLoopHarnessSession({
    lease: controlledLease().lease,
    brokers: { modelRequest: () => { brokerCalls += 1; return {} } },
  })
  assert.throws(
    () => requestSession.model.request(revoked({ prompt: 'secret' })),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.BOUNDARY_INVALID),
  )
  assert.equal(brokerCalls, 0)

  const resultSession = createLoopHarnessSession({
    lease: controlledLease().lease,
    brokers: { modelRequest: () => revoked({ endpoint: 'must-not-escape' }) },
  })
  assert.throws(
    () => resultSession.model.request({}),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.BOUNDARY_INVALID),
  )
})

test('sanitizes synchronous and asynchronous broker failures by capability', async () => {
  const modelFailure = new Error('https://private.invalid/v1 key=sk-secret')
  const toolFailure = new Error('tool endpoint token=private-token')
  const session = createLoopHarnessSession({
    lease: controlledLease().lease,
    brokers: {
      modelRequest() { throw modelFailure },
      toolsExecute() { return Promise.reject(toolFailure) },
    },
  })

  assert.throws(
    () => session.model.request({}),
    (error) => {
      assert.equal(error.code, LOOP_HARNESS_SESSION_ERROR_CODES.MODEL_BROKER_FAILED)
      assert.equal(error.retryable, false)
      assert.equal(error.statusCode, 503)
      assert.notEqual(error, modelFailure)
      assert.equal(Object.hasOwn(error, 'cause'), false)
      assert.doesNotMatch(error.message, /private|secret|invalid\/v1/i)
      return true
    },
  )
  await assert.rejects(
    session.tools.execute({}),
    (error) => {
      assert.equal(error.code, LOOP_HARNESS_SESSION_ERROR_CODES.TOOL_BROKER_FAILED)
      assert.equal(error.retryable, false)
      assert.equal(error.statusCode, 503)
      assert.notEqual(error, toolFailure)
      assert.equal(Object.hasOwn(error, 'cause'), false)
      assert.doesNotMatch(error.message, /private|token/i)
      return true
    },
  )
})

test('lease and session boundary errors take precedence over broker failures', async () => {
  const syncControl = controlledLease()
  const syncSession = createLoopHarnessSession({
    lease: syncControl.lease,
    brokers: {
      modelRequest() {
        syncControl.revoke()
        throw new Error('provider secret')
      },
    },
  })
  assert.throws(
    () => syncSession.model.request({}),
    isCode('TOOL_LOOP_RUN_LEASE_REVOKED'),
  )

  const asyncControl = controlledLease()
  const asyncSession = createLoopHarnessSession({
    lease: asyncControl.lease,
    brokers: {
      toolsExecute: () => Promise.reject(new Error('provider secret')),
    },
  })
  const result = asyncSession.tools.execute({})
  asyncControl.stale()
  await assert.rejects(result, isCode('TOOL_LOOP_RUN_LEASE_STALE'))

  const boundarySession = createLoopHarnessSession({
    lease: controlledLease().lease,
    brokers: { modelRequest: () => ({ callback() {} }) },
  })
  assert.throws(
    () => boundarySession.model.request({}),
    isCode(LOOP_HARNESS_SESSION_ERROR_CODES.BOUNDARY_INVALID),
  )
})

test('checks a revoked lease synchronously and consumes an abandoned broker Promise', async () => {
  const control = controlledLease()
  let rejectPending
  const pending = new Promise((resolve, reject) => { rejectPending = reject })
  const originalThen = Promise.prototype.then
  let rejectionObserverAttached = false
  const session = createLoopHarnessSession({
    lease: control.lease,
    brokers: {
      modelRequest() {
        control.revoke()
        return pending
      },
    },
  })

  Promise.prototype.then = function observedThen(onFulfilled, onRejected) {
    if (this === pending && typeof onRejected === 'function') {
      rejectionObserverAttached = true
    }
    return Reflect.apply(originalThen, this, [onFulfilled, onRejected])
  }
  try {
    assert.throws(
      () => session.model.request({}),
      isCode('TOOL_LOOP_RUN_LEASE_REVOKED'),
    )
  } finally {
    Promise.prototype.then = originalThen
  }
  assert.equal(rejectionObserverAttached, true)

  rejectPending(new Error('must be consumed'))
  await new Promise((resolve) => setImmediate(resolve))
})
