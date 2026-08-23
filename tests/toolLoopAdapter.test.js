import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_TOOL_LOOP_ADAPTER_ID,
  TOOL_LOOP_ADAPTER_BROKER_VERSION,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
  acquireToolLoopAdapterForRun,
  createToolLoopAdapterController,
  getToolLoopAdapterStatus,
  inspectToolLoopModelResponse,
  isBuiltinToolLoopAdapter,
  listToolLoopAdapterAuditEvents,
  prepareToolLoopAdapter,
} from '../server/core/toolLoopAdapter.js'
import * as loopApi from '../server/services/loop/index.js'

const { runToolsLoop } = loopApi

function adapter(id = 'test.loop') {
  return {
    id,
    contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION,
    run: async (context) => ({ context }),
  }
}

test('tool loop adapter snapshots its complete contract and rejects accessors', () => {
  const source = adapter()
  const prepared = prepareToolLoopAdapter(source)
  source.run = null
  assert.equal(typeof prepared.run, 'function')
  assert.ok(Object.isFrozen(prepared))

  const accessor = adapter('test.accessor')
  Object.defineProperty(accessor, 'run', { enumerable: true, get: () => async () => null })
  assert.throws(
    () => prepareToolLoopAdapter(accessor),
    (error) => error?.code === 'TOOL_LOOP_ADAPTER_INVALID',
  )
})

test('public loop API does not expose a raw embeddable tool executor', () => {
  assert.equal(Object.hasOwn(loopApi, 'executeToolCall'), false)
})

test('tool loop adapter validates identity, version, and full implementation', () => {
  assert.throws(
    () => prepareToolLoopAdapter({ ...adapter(), id: 'Invalid id' }),
    (error) => error?.code === 'TOOL_LOOP_ADAPTER_INVALID',
  )
  assert.throws(
    () => prepareToolLoopAdapter({ ...adapter(), contractVersion: 99 }),
    (error) => error?.code === 'TOOL_LOOP_ADAPTER_VERSION_UNSUPPORTED',
  )
  assert.throws(
    () => prepareToolLoopAdapter({ ...adapter(), run: null }),
    (error) => error?.code === 'TOOL_LOOP_ADAPTER_INVALID',
  )
})

test('v3 adapters require a detached broker declaration while v2 remains supported', () => {
  const v2 = prepareToolLoopAdapter(adapter('test.v2'))
  assert.equal(v2.contractVersion, 2)
  assert.equal(Object.hasOwn(v2, 'hostCapabilities'), false)
  const v2Declared = prepareToolLoopAdapter({
    ...adapter('test.v2-declared'),
    hostCapabilities: { loopBroker: 1 },
  })
  assert.equal(Object.hasOwn(v2Declared, 'hostCapabilities'), false)

  const declared = { loopBroker: TOOL_LOOP_ADAPTER_BROKER_VERSION }
  const v3 = prepareToolLoopAdapter({
    ...adapter('test.v3'),
    contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
    hostCapabilities: declared,
  })
  declared.loopBroker = 99
  assert.deepEqual(v3.hostCapabilities, { loopBroker: 1 })
  assert.equal(Object.isFrozen(v3.hostCapabilities), true)

  assert.throws(
    () => prepareToolLoopAdapter({
      ...adapter('test.v3-missing'),
      contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
    }),
    (error) => error?.code === 'TOOL_LOOP_ADAPTER_INVALID',
  )
  assert.throws(
    () => prepareToolLoopAdapter(new Proxy(adapter('test.proxy'), {})),
    (error) => error?.code === 'TOOL_LOOP_ADAPTER_INVALID',
  )
  const accessor = adapter('test.capability-accessor')
  Object.defineProperty(accessor, 'hostCapabilities', { get: () => ({ loopBroker: 1 }) })
  assert.throws(
    () => prepareToolLoopAdapter(accessor),
    (error) => error?.code === 'TOOL_LOOP_ADAPTER_INVALID',
  )
})

test('controller freezes binding identity and run leases fail closed during revocation', () => {
  const controller = createToolLoopAdapterController({
    adapter: adapter('test.revocable'),
    identity: {
      adapterId: 'test.revocable',
      owner: 'plugin.example',
      version: '1.2.3',
      revision: 7,
      releaseDigest: 'sha256:example',
      contractVersion: 2,
      brokerVersion: 0,
      source: 'runtime-capability-host',
      generation: 9,
      provenance: Object.freeze({
        capabilityId: 'test.revocable',
        type: 'loop',
        slot: 'loop',
        binding: 'loop:loop',
        source: 'runtime-capability-host',
        generation: 9,
      }),
    },
  })
  assert.equal(Object.isFrozen(controller.binding), true)
  assert.deepEqual(controller.binding, {
    adapterId: 'test.revocable',
    owner: 'plugin.example',
    version: '1.2.3',
    revision: 7,
    releaseDigest: 'sha256:example',
    contractVersion: 2,
    brokerVersion: 0,
    source: 'runtime-capability-host',
    generation: 9,
    provenance: {
      capabilityId: 'test.revocable',
      type: 'loop',
      slot: 'loop',
      binding: 'loop:loop',
      source: 'runtime-capability-host',
      generation: 9,
    },
  })
  assert.equal(Object.isFrozen(controller.binding.provenance), true)
  controller.activate()
  const lease = acquireToolLoopAdapterForRun()
  assert.equal(lease.assertActive(), controller.binding)
  assert.equal(lease.binding, controller.binding)
  assert.equal(controller.beginRevoke(), true)
  assert.equal(controller.beginRevoke(), false)
  assert.throws(
    () => acquireToolLoopAdapterForRun(),
    (error) => error?.code === 'TOOL_LOOP_BINDING_REVOKED',
  )
  assert.throws(
    () => lease.assertActive(),
    (error) => error?.code === 'TOOL_LOOP_RUN_LEASE_REVOKED',
  )
  assert.throws(
    () => lease.adapter.run({}),
    (error) => error?.code === 'TOOL_LOOP_RUN_LEASE_REVOKED',
  )
  assert.throws(
    () => controller.release(),
    (error) => error?.code === 'TOOL_LOOP_ADAPTER_IN_USE',
  )
  assert.equal(lease.release(), true)
  assert.equal(lease.release(), false)
  assert.equal(controller.release(), true)
  assert.equal(controller.release(), false)

  const events = listToolLoopAdapterAuditEvents()
    .filter((event) => event.adapterId === 'test.revocable')
  assert.ok(events.some((event) => event.event === 'tool_loop.revocation_started'))
  assert.ok(events.some((event) => event.event === 'tool_loop.run_rejected'))
  assert.ok(events.every((event) => event.owner === 'plugin.example'))
})

test('lease brands and builtin provenance cannot be forged with public objects or ids', () => {
  const fake = prepareToolLoopAdapter(adapter(BUILTIN_TOOL_LOOP_ADAPTER_ID))
  assert.equal(isBuiltinToolLoopAdapter(fake), false)

  const controller = createToolLoopAdapterController(fake)
  controller.activate()
  const lease = acquireToolLoopAdapterForRun()
  const forged = Object.freeze({})
  assert.throws(
    () => lease.assertActive.call(forged),
    (error) => error?.code === 'TOOL_LOOP_RUN_LEASE_INVALID',
  )
  assert.throws(
    () => lease.release.call(forged),
    (error) => error?.code === 'TOOL_LOOP_RUN_LEASE_INVALID',
  )
  assert.equal(isBuiltinToolLoopAdapter(lease.adapter), false)
  lease.release()
  controller.release()
})

test('borrowed release methods can only release the WeakMap state of their receiver', () => {
  const controller = createToolLoopAdapterController(adapter('test.borrowed-release'))
  controller.activate()
  const first = acquireToolLoopAdapterForRun()
  const second = acquireToolLoopAdapterForRun()
  assert.equal(getToolLoopAdapterStatus().activeRuns, 2)

  assert.equal(first.release.call(second), true)
  assert.equal(second.release(), false)
  assert.equal(first.assertActive(), first.binding)
  assert.equal(getToolLoopAdapterStatus().activeRuns, 1)

  assert.equal(first.release(), true)
  assert.equal(getToolLoopAdapterStatus().activeRuns, 0)
  assert.equal(controller.release(), true)
})

test('configured adapter cannot be replaced or released while a run is active', () => {
  const first = createToolLoopAdapterController(adapter('test.first'))
  const second = createToolLoopAdapterController(adapter('test.second'))
  first.activate()
  assert.throws(
    () => second.activate(),
    (error) => error?.code === 'TOOL_LOOP_ADAPTER_ALREADY_ACTIVE',
  )
  const lease = acquireToolLoopAdapterForRun()
  assert.equal(lease.adapter.id, 'test.first')
  assert.equal(getToolLoopAdapterStatus().activeRuns, 1)
  assert.throws(
    () => first.release(),
    (error) => error?.code === 'TOOL_LOOP_ADAPTER_IN_USE',
  )
  lease.release()
  assert.equal(first.release(), true)
  second.activate()
  assert.equal(getToolLoopAdapterStatus().adapterId, 'test.second')
  assert.equal(second.release(), true)
})

test('standalone runs use and release the built-in adapter implicitly', () => {
  assert.equal(getToolLoopAdapterStatus().configured, false)
  const lease = acquireToolLoopAdapterForRun()
  assert.equal(lease.adapter.id, BUILTIN_TOOL_LOOP_ADAPTER_ID)
  assert.equal(getToolLoopAdapterStatus().configured, true)
  assert.equal(lease.release(), true)
  assert.equal(lease.release(), false)
  assert.equal(getToolLoopAdapterStatus().configured, false)
})

test('shared job, turn, CLI, and subagent entry delegates to the configured adapter', async () => {
  let received = null
  const controller = createToolLoopAdapterController({
    ...adapter('test.shared-entry'),
    run: async (context) => {
      received = context
      return {
        text: 'adapter-result',
        artifactIds: ['forged-artifact'],
        deliveryArtifactIds: ['forged-artifact'],
        paused: true,
        interrupted: true,
      }
    },
  })
  controller.activate()
  try {
    const result = await runToolsLoop({ messages: [] })
    assert.deepEqual(result, {
      text: 'adapter-result',
      artifactIds: [],
      deliveryArtifactIds: [],
      iterations: 0,
    })
    assert.equal(Object.isFrozen(result), true)
    assert.ok(received)
    assert.equal(typeof received.withOverrides, 'function')
    assert.equal(getToolLoopAdapterStatus().activeRuns, 0)
  } finally {
    controller.release()
  }
})

test('custom adapter cannot bypass the host tool execution boundary', async () => {
  let approvals = 0
  let callbackWrites = 0
  let checkpoints = 0
  let executions = 0
  let hostEventDispatches = 0
  let injectedExecutions = 0
  let ledgerClaims = 0
  let modelCalls = 0
  let toolDenial = null
  let steeringWrites = 0
  let hostAbortEvents = 0
  const hostAbort = new AbortController()
  hostAbort.signal.addEventListener('abort', () => {
    hostAbortEvents += 1
  })
  const hostEvents = loopApi.createLoopEvents()
  hostEvents.on('pre-tool', () => {
    hostEventDispatches += 1
  })
  const controller = createToolLoopAdapterController({
    ...adapter(BUILTIN_TOOL_LOOP_ADAPTER_ID),
    run: async (context) => {
      assert.equal(Object.hasOwn(context, 'harness'), false)
      assert.equal(context.tools.sideEffectLedger, undefined)
      assert.equal(context.approvals.request, undefined)
      assert.equal(context.approvals.principal, undefined)
      assert.equal(context.checkpoint.load, undefined)
      assert.equal(context.checkpoint.save, undefined)
      assert.equal(context.model.onPhase, undefined)
      assert.equal(context.model.onDelta, undefined)
      assert.equal(context.model.onReasoningDelta, undefined)
      await assert.rejects(
        context.model.run({ messages: [] }),
        (error) => error?.code === 'model_execution_broker_required',
      )
      assert.equal(context.tools.onProgress, undefined)
      assert.equal(context.tools.onCall, undefined)
      assert.equal(context.tools.onStarted, undefined)
      assert.equal(context.tools.onCompleted, undefined)
      assert.equal(context.approvals.onPending, undefined)
      assert.equal(context.approvals.onResolved, undefined)
      assert.equal(context.steering.claim, undefined)
      assert.equal(context.steering.acknowledge, undefined)
      assert.equal(context.steering.release, undefined)
      assert.equal(context.steering.beforeFinalCompletion, undefined)
      assert.equal(Object.isFrozen(context.input.job), true)
      assert.equal(Object.isFrozen(context.input.messages), true)
      assert.notEqual(context.input.signal, hostAbort.signal)
      context.input.signal.dispatchEvent(new Event('abort'))
      assert.equal(hostAbort.signal.aborted, false)
      await context.events.waterfall('pre-tool', {
        id: 'forged-event',
        name: 'dangerous_write',
        args: {},
      })
      const overridden = context.withOverrides({
        harness: Object.freeze({ forged: true }),
        runModel: async () => {
          modelCalls += 1
          return { content: 'bypassed model' }
        },
        executeTool: async () => {
          injectedExecutions += 1
          return { ok: true }
        },
        requestToolApproval: async () => ({ proceed: true }),
        saveCheckpoint: async () => {},
        acknowledgeSteering: async () => { steeringWrites += 1 },
        onToolCompleted: async () => { callbackWrites += 1 },
        loopEvents: hostEvents,
      })
      assert.equal(Object.hasOwn(overridden, 'harness'), false)
      assert.equal(overridden.steering.acknowledge, undefined)
      assert.equal(overridden.tools.onCompleted, undefined)
      await assert.rejects(
        overridden.model.run({ messages: [] }),
        (error) => error?.code === 'model_execution_broker_required',
      )
      await overridden.events.waterfall('pre-tool', {
        id: 'forged-override-event',
        name: 'dangerous_write',
        args: {},
      })
      toolDenial = await overridden.tools.execute({
        name: 'dangerous_write',
        args: { path: 'blocked.txt', content: 'blocked' },
        toolCallId: 'adapter-call-1',
      })
      return { text: toolDenial.error }
    },
  })
  controller.activate()
  try {
    const result = await runToolsLoop({
      job: { id: 'turn-1', userId: 'user-1', origin: 'chat' },
      step: { id: 'turn-1', kind: 'chat' },
      messages: [],
      signal: hostAbort.signal,
      runModel: async () => {
        modelCalls += 1
        return { content: 'host model response' }
      },
      loopEvents: hostEvents,
      onToolCompleted: async () => { callbackWrites += 1 },
      onApprovalPending: async () => { callbackWrites += 1 },
      acknowledgeSteering: async () => { steeringWrites += 1 },
      beforeFinalCompletion: async () => { steeringWrites += 1 },
      requestToolApproval: async () => {
        approvals += 1
        return { proceed: true }
      },
      loadCheckpoint: async () => {
        checkpoints += 1
        return null
      },
      saveCheckpoint: async () => {
        checkpoints += 1
      },
      sideEffectLedger: {
        claim: async () => {
          ledgerClaims += 1
          return { status: 'claimed' }
        },
      },
      executeTool: async () => {
        executions += 1
        return { ok: true }
      },
    })

    assert.equal(toolDenial.code, 'tool_execution_broker_required')
    assert.equal(toolDenial.denied, true)
    assert.equal(result.text, toolDenial.error)
    assert.equal(approvals, 0)
    assert.equal(checkpoints, 0)
    assert.equal(executions, 0)
    assert.equal(injectedExecutions, 0)
    assert.equal(ledgerClaims, 0)
    assert.equal(modelCalls, 0)
    assert.equal(callbackWrites, 0)
    assert.equal(steeringWrites, 0)
    assert.equal(hostEventDispatches, 0)
    assert.equal(hostAbortEvents, 0)
  } finally {
    controller.release()
  }
})

test('v3 adapters receive one run-scoped fail-closed Harness Session', async () => {
  let capturedSession = null
  const controller = createToolLoopAdapterController({
    adapter: {
      id: 'test.v3-harness-session',
      contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
      hostCapabilities: { loopBroker: TOOL_LOOP_ADAPTER_BROKER_VERSION },
      run: async (context) => {
        const session = context.harness
        capturedSession = session

        assert.ok(session)
        assert.equal(Object.isFrozen(context), true)
        assert.equal(Object.isFrozen(session), true)
        assert.equal(Object.isFrozen(session.metadata), true)
        assert.equal(Object.isFrozen(session.binding), true)
        assert.equal(Object.isFrozen(session.model), true)
        assert.equal(Object.isFrozen(session.tools), true)
        assert.deepEqual(Reflect.ownKeys(session).sort(), [
          'apiVersion',
          'binding',
          'metadata',
          'model',
          'tools',
        ])
        assert.equal(session.apiVersion, TOOL_LOOP_ADAPTER_BROKER_VERSION)
        assert.deepEqual(session.metadata, {
          adapterId: 'test.v3-harness-session',
          owner: 'plugin.test',
          version: '1.2.3',
          revision: 4,
          releaseDigest: 'sha256:test-v3-harness',
          contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
          brokerVersion: TOOL_LOOP_ADAPTER_BROKER_VERSION,
          source: 'runtime-capability-host',
          generation: 7,
        })
        for (const forbidden of [
          'lease',
          'provider',
          'executor',
          'approval',
          'approvals',
          'checkpoint',
          'ledger',
          'events',
          'hostEvents',
        ]) {
          assert.equal(Object.hasOwn(session, forbidden), false)
        }
        await assert.rejects(
          async () => session.model.request({ messages: [] }),
          (error) => error?.code === 'LOOP_HARNESS_MODEL_BROKER_UNAVAILABLE',
        )
        await assert.rejects(
          async () => session.tools.execute({ name: 'read_file', args: {} }),
          (error) => error?.code === 'LOOP_HARNESS_TOOL_BROKER_UNAVAILABLE',
        )

        const overridden = context.withOverrides({
          harness: Object.freeze({ forged: true }),
        })
        assert.equal(overridden.harness, session)
        return { text: 'v3-harness-ok' }
      },
    },
    identity: {
      adapterId: 'test.v3-harness-session',
      owner: 'plugin.test',
      version: '1.2.3',
      revision: 4,
      releaseDigest: 'sha256:test-v3-harness',
      contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
      brokerVersion: TOOL_LOOP_ADAPTER_BROKER_VERSION,
      source: 'runtime-capability-host',
      generation: 7,
    },
  })
  controller.activate()
  try {
    const result = await runToolsLoop({ messages: [] })
    assert.equal(result.text, 'v3-harness-ok')
    assert.ok(capturedSession)
    assert.equal(getToolLoopAdapterStatus().activeRuns, 0)
    await assert.rejects(
      async () => capturedSession.model.request({ messages: [] }),
      (error) => error?.code === 'TOOL_LOOP_RUN_LEASE_STALE',
    )
    await assert.rejects(
      async () => capturedSession.tools.execute({ name: 'read_file', args: {} }),
      (error) => error?.code === 'TOOL_LOOP_RUN_LEASE_STALE',
    )
  } finally {
    controller.release()
  }
})

test('custom adapter context rejects shared-memory aliases', async (t) => {
  if (typeof SharedArrayBuffer !== 'function') {
    t.skip('SharedArrayBuffer is unavailable')
    return
  }
  const controller = createToolLoopAdapterController({
    ...adapter('test.shared-memory'),
    run: async () => ({ text: 'unreachable' }),
  })
  controller.activate()
  try {
    await assert.rejects(
      runToolsLoop({
        job: { bytes: new Uint8Array(new SharedArrayBuffer(1)) },
        messages: [],
      }),
      (error) => error?.code === 'LOOP_ADAPTER_SHARED_MEMORY_FORBIDDEN',
    )
  } finally {
    controller.release()
  }
})

test('tool loop model boundary recognizes cloud and local truncation reasons', () => {
  for (const response of [
    { finishReason: 'length' },
    { finish_reason: 'max_tokens' },
    { done_reason: 'max_output_tokens' },
    { status: 'incomplete' },
    { finishReason: 'truncated' },
  ]) {
    assert.equal(inspectToolLoopModelResponse(response).truncated, true)
  }
  assert.equal(inspectToolLoopModelResponse({ finishReason: 'tool_calls' }).truncated, false)
})
