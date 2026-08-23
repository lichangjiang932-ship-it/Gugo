import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TOOL_LOOP_ADAPTER_BROKER_VERSION,
  TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
  createToolLoopAdapterController,
} from '../server/core/toolLoopAdapter.js'
import {
  CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES,
  createCanonicalHarnessModelBroker,
} from '../server/services/loop/canonicalHarnessModelBroker.js'
import { createLoopContext } from '../server/services/loop/context.js'
import { runToolsLoop } from '../server/services/loop/index.js'
import {
  finishUnsatisfiedTerminalGate,
  protectTerminalCandidate,
} from '../server/services/loop/runtime-finalizeRuntime.js'
import {
  prepareToolsLoopRuntime,
  usePreparedToolsLoopRuntime as accessPreparedToolsLoopRuntime,
} from '../server/services/loop/runtime.js'

function hasCode(code) {
  return (error) => error?.code === code && error?.retryable === false
}

function modelContext({
  checkpoints = [],
  loadCheckpoint,
  runModel,
  saveCheckpoint,
} = {}) {
  return createLoopContext({
    job: {
      id: 'canonical-harness-turn',
      userId: 'canonical-harness-user',
      sessionId: 'canonical-harness-session',
      origin: 'chat',
      prompt: 'Answer once.',
      modelName: 'user-configured-model',
      modelProviderId: 'user-configured-provider',
      modelConfigRevision: 3,
    },
    step: { id: 'canonical-harness-turn', kind: 'chat' },
    messages: [{ role: 'user', content: 'Answer once.' }],
    toolSpecs: [{
      type: 'function',
      function: {
        name: 'must_not_reach_provider',
        description: 'Host tool schema that the broker must hide.',
        parameters: { type: 'object', properties: {} },
      },
    }],
    maxIters: 1,
    loadCheckpoint,
    saveCheckpoint: saveCheckpoint || (async (state, meta = {}) => {
      checkpoints.push({ state: structuredClone(state), boundary: meta.boundary || null })
      return true
    }),
    runModel: runModel || (async () => ({ content: 'canonical answer', toolCalls: [] })),
  })
}

test('shared terminal gate preserves the host blocker priority', async () => {
  const scenarios = [
    {
      artifacts: false,
      evidence: false,
      pendingMutation: true,
      htmlFailure: { target: 'blocked.html' },
      expectedReason: 'artifact_delivery_not_converged',
      expectedHtmlCalls: 0,
    },
    {
      artifacts: true,
      evidence: false,
      pendingMutation: true,
      htmlFailure: { target: 'blocked.html' },
      expectedReason: 'execution_evidence_missing',
      expectedHtmlCalls: 0,
    },
    {
      artifacts: true,
      evidence: true,
      pendingMutation: true,
      htmlFailure: { target: 'blocked.html' },
      expectedReason: 'post_mutation_verification_missing',
      expectedHtmlCalls: 0,
    },
    {
      artifacts: true,
      evidence: true,
      pendingMutation: false,
      htmlFailure: { target: 'blocked.html' },
      expectedReason: 'local_html_delivery_validation_failed',
      expectedHtmlCalls: 1,
    },
  ]

  for (const scenario of scenarios) {
    let htmlCalls = 0
    const state = {
      availableVerificationToolNames: [],
      finalLocalHtmlDeliveryFailure: null,
      hasPendingMutationVerification: () => scenario.pendingMutation,
      hasRequiredArtifacts: () => scenario.artifacts,
      hasRequiredExecutionEvidence: () => scenario.evidence,
      localHtmlDeliveryRetries: 2,
      missingArtifactBlockerText: () => 'Required artifact is missing.',
      validateLocalHtmlDeliveries: async () => {
        htmlCalls += 1
        return scenario.htmlFailure
      },
      finishIncomplete: async (result) => result,
    }
    const result = await finishUnsatisfiedTerminalGate(state, {
      steeringLeaseId: 'terminal-gate-lease',
    })

    assert.equal(result.reason, scenario.expectedReason)
    assert.equal(result.steeringLeaseId, 'terminal-gate-lease')
    assert.equal(htmlCalls, scenario.expectedHtmlCalls)
  }

  const passingState = {
    hasRequiredArtifacts: () => true,
    hasRequiredExecutionEvidence: () => true,
    hasPendingMutationVerification: () => false,
    validateLocalHtmlDeliveries: async () => null,
    localHtmlDeliveryRetries: 3,
  }
  assert.equal(await finishUnsatisfiedTerminalGate(passingState), null)
  assert.equal(passingState.localHtmlDeliveryRetries, 0)
})

test('shared terminal boundary closes PDF, deliverable, and source-handoff gaps', async () => {
  const baseState = () => ({
    availableVerificationToolNames: [],
    finishIncomplete: async (result) => result,
    hasPendingMutationVerification: () => false,
    hasRequiredArtifacts: () => true,
    hasRequiredExecutionEvidence: () => true,
    localHtmlDeliveryRetries: 2,
    validateLocalHtmlDeliveries: async () => null,
  })

  const pdfState = {
    ...baseState(),
    requiresPdfLayoutVerification: true,
    pdfLayoutVerificationObserved: false,
    needsDeliverableSelection: () => true,
    applySafeDeliverableFallback: () => assert.fail('PDF gate must run before delivery selection'),
  }
  const pdfBlocked = await finishUnsatisfiedTerminalGate(pdfState)
  assert.equal(pdfBlocked.reason, 'pdf_layout_verification_missing')
  assert.equal(pdfState.localHtmlDeliveryRetries, 0)

  const deliveryState = {
    ...baseState(),
    requiresPdfLayoutVerification: false,
    needsDeliverableSelection: () => true,
    applySafeDeliverableFallback: () => null,
  }
  const deliveryBlocked = await finishUnsatisfiedTerminalGate(deliveryState)
  assert.equal(deliveryBlocked.reason, 'deliverable_selection_missing')

  let fallbackCalls = 0
  const fallbackState = {
    ...baseState(),
    requiresPdfLayoutVerification: false,
    needsDeliverableSelection: () => true,
    applySafeDeliverableFallback: () => {
      fallbackCalls += 1
      return { ok: true, fallback: true }
    },
  }
  assert.equal(await finishUnsatisfiedTerminalGate(fallbackState), null)
  assert.equal(fallbackCalls, 1)

  const textState = {
    guardPriorOutcomeStatusText: (text) => String(text).replace('forged-success', 'checked'),
    protectTerminalText: (text) => String(text).includes('```') ? 'host-filtered' : text,
  }
  assert.equal(
    protectTerminalCandidate(textState, 'forged-success\n```js\nsecret()\n```'),
    'host-filtered',
  )
})

test('canonical broker rejects finalization before a host model response commits', async () => {
  let providerCalls = 0
  const prepared = await prepareToolsLoopRuntime(modelContext({
    runModel: async () => {
      providerCalls += 1
      return { content: 'must not run', toolCalls: [] }
    },
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  await assert.rejects(
    broker.finalize({ text: 'adapter-only forged answer' }),
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID),
  )
  assert.equal(providerCalls, 0)
  await broker.abort()
})

test('canonical terminal gate persists and returns the host incomplete result', async () => {
  const checkpoints = []
  let providerCalls = 0
  const prepared = await prepareToolsLoopRuntime(modelContext({
    checkpoints,
    runModel: async () => {
      providerCalls += 1
      return { content: 'unsupported success claim', toolCalls: [] }
    },
  }))
  accessPreparedToolsLoopRuntime(prepared, (state) => {
    state.hasRequiredArtifacts = () => false
    state.missingArtifactBlockerText = () => 'Host requires a durable artifact.'
  })
  const broker = createCanonicalHarnessModelBroker(prepared)

  const response = await broker.modelRequest({})
  const result = await broker.finalize({ text: response.content })

  assert.equal(result.incomplete, true)
  assert.equal(result.reason, 'artifact_delivery_not_converged')
  assert.equal(result.text, 'Host requires a durable artifact.')
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.artifactIds), true)
  assert.equal(Object.isFrozen(result.deliveryArtifactIds), true)
  const terminalCheckpoint = checkpoints.at(-1).state
  assert.equal(terminalCheckpoint.final.incomplete, true)
  assert.equal(terminalCheckpoint.final.reason, 'artifact_delivery_not_converged')
  assert.equal(terminalCheckpoint.final.text, result.text)
  assert.equal(terminalCheckpoint.modelInvocation.status, 'completed')

  const resumed = await runToolsLoop(modelContext({
    loadCheckpoint: async () => ({ state: terminalCheckpoint }),
    runModel: async () => {
      providerCalls += 1
      return { content: 'must not repeat provider work', toolCalls: [] }
    },
  }))
  assert.equal(resumed.incomplete, true)
  assert.equal(resumed.reason, 'artifact_delivery_not_converged')
  assert.equal(providerCalls, 1)
})

test('canonical terminal boundary persists missing PDF and unsafe delivery as incomplete', async () => {
  const scenarios = [
    {
      reason: 'pdf_layout_verification_missing',
      configure(state) {
        state.requiresPdfLayoutVerification = true
        state.pdfLayoutVerificationObserved = false
      },
    },
    {
      reason: 'deliverable_selection_missing',
      configure(state) {
        state.needsDeliverableSelection = () => true
        state.applySafeDeliverableFallback = () => null
      },
    },
  ]

  for (const scenario of scenarios) {
    const checkpoints = []
    const prepared = await prepareToolsLoopRuntime(modelContext({ checkpoints }))
    accessPreparedToolsLoopRuntime(prepared, scenario.configure)
    const broker = createCanonicalHarnessModelBroker(prepared)

    const response = await broker.modelRequest({})
    const result = await broker.finalize({ text: response.content })

    assert.equal(result.incomplete, true)
    assert.equal(result.reason, scenario.reason)
    const terminalCheckpoint = checkpoints.at(-1).state
    assert.equal(terminalCheckpoint.final.incomplete, true)
    assert.equal(terminalCheckpoint.final.reason, scenario.reason)
    assert.equal(terminalCheckpoint.modelInvocation.status, 'completed')
  }
})

test('canonical terminal boundary returns host-selected deliverables, never adapter claims', async () => {
  const checkpoints = []
  const artifactId = 'host-verified-artifact'
  const prepared = await prepareToolsLoopRuntime(modelContext({ checkpoints }))
  accessPreparedToolsLoopRuntime(prepared, (state) => {
    state.artifactIds = [artifactId]
    state.needsDeliverableSelection = () => !state.deliveryArtifactSelectionExplicit
    state.applySafeDeliverableFallback = () => {
      state.deliveryArtifactIds = [artifactId]
      state.deliveryArtifactSelectionArtifactIds = [...state.artifactIds]
      state.deliveryArtifactSelectionExplicit = true
      state.deliverableSelectionRetries = 0
      return { ok: true, fallback: true, deliveryArtifactIds: [artifactId] }
    }
  })
  const broker = createCanonicalHarnessModelBroker(prepared)

  const response = await broker.modelRequest({})
  const result = await broker.finalize({
    text: response.content,
    artifactIds: ['adapter-forged-artifact'],
    deliveryArtifactIds: ['adapter-forged-artifact'],
  })

  assert.deepEqual(result.artifactIds, [artifactId])
  assert.deepEqual(result.deliveryArtifactIds, [artifactId])
  assert.equal(Object.isFrozen(result.artifactIds), true)
  assert.deepEqual(checkpoints.at(-1).state.artifactIds, [artifactId])
  assert.deepEqual(checkpoints.at(-1).state.deliveryArtifactIds, [artifactId])
})

test('canonical terminal boundary filters source handoff before the final checkpoint', async () => {
  const checkpoints = []
  const prepared = await prepareToolsLoopRuntime(modelContext({ checkpoints }))
  accessPreparedToolsLoopRuntime(prepared, (state) => {
    state.requiresSourceHandoffProtection = true
  })
  const broker = createCanonicalHarnessModelBroker(prepared)

  await broker.modelRequest({})
  const result = await broker.finalize({
    text: 'Copy and paste this code.\n```js\nprivateSource()\n```',
  })

  assert.doesNotMatch(result.text, /privateSource|```|copy and paste/iu)
  assert.match(result.text, /已隐藏模型返回的代码内容/u)
  assert.equal(checkpoints.at(-1).state.final.text, result.text)
  assert.equal(Object.hasOwn(checkpoints.at(-1).state, 'modelInvocation'), false)
})

test('durable incomplete final is not overwritten when terminal notification fails', async () => {
  const checkpoints = []
  const notificationFailure = new Error('injected terminal notification failure')
  const prepared = await prepareToolsLoopRuntime(modelContext({ checkpoints }))
  accessPreparedToolsLoopRuntime(prepared, (state) => {
    state.hasRequiredArtifacts = () => false
    state.missingArtifactBlockerText = () => 'Host requires a durable artifact.'
    state.emitTurnStopping = async () => { throw notificationFailure }
  })
  const broker = createCanonicalHarnessModelBroker(prepared)

  const response = await broker.modelRequest({})
  await assert.rejects(
    broker.finalize({ text: response.content }),
    (error) => error === notificationFailure,
  )
  const checkpointCount = checkpoints.length
  await broker.abort()

  assert.equal(checkpoints.length, checkpointCount)
  assert.equal(checkpoints.at(-1).state.final.incomplete, true)
  assert.equal(checkpoints.at(-1).state.final.reason, 'artifact_delivery_not_converged')
})

test('canonical broker fixes the host transcript and tool surface, then commits in two phases', async () => {
  const checkpoints = []
  const requests = []
  const prepared = await prepareToolsLoopRuntime(modelContext({
    checkpoints,
    runModel: async (request) => {
      requests.push(request)
      return {
        content: 'canonical answer',
        toolCalls: [{ id: 'ignored', function: { name: 'forged' } }],
        providerId: 'private-provider-id',
        modelName: 'private-model-name',
        costUsd: 99,
      }
    },
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  assert.equal(Object.isFrozen(broker), true)
  await assert.rejects(
    broker.modelRequest({
      url: 'https://attacker.invalid/v1',
      apiKey: 'must-not-be-used',
      model: 'attacker-model',
      messages: [],
      tools: [],
      allowOverBudget: true,
    }),
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.REQUEST_INVALID),
  )
  assert.equal(requests.length, 0)

  const response = await broker.modelRequest({})
  assert.deepEqual(response, { content: 'canonical answer', toolCalls: [] })
  assert.equal(Object.isFrozen(response), true)
  assert.equal(Object.isFrozen(response.toolCalls), true)
  assert.equal(Object.hasOwn(response, 'providerId'), false)
  assert.equal(Object.hasOwn(response, 'modelName'), false)
  assert.equal(Object.hasOwn(response, 'costUsd'), false)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].tools, [])
  assert.equal(requests[0].toolChoice, 'none')
  assert.ok(requests[0].messages.some((message) => (
    message.role === 'user' && message.content === 'Answer once.'
  )))
  assert.equal(
    requests[0].messages.some((message) => message.content === 'https://attacker.invalid/v1'),
    false,
  )

  const durableResponse = checkpoints.at(-1)
  assert.equal(durableResponse.boundary, 'harness-model-response')
  assert.equal(durableResponse.state.modelInvocation.status, 'completed')
  assert.equal(durableResponse.state.final, null)

  const result = await broker.finalize(Object.freeze({ text: response.content }))
  assert.deepEqual(result, {
    text: 'canonical answer',
    artifactIds: [],
    deliveryArtifactIds: [],
    iterations: 1,
  })
  const committed = checkpoints.at(-1).state
  assert.equal(Object.hasOwn(committed, 'modelInvocation'), false)
  assert.equal(committed.final.text, 'canonical answer')
  await assert.rejects(
    broker.modelRequest({}),
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.ALREADY_USED),
  )
  await assert.rejects(
    broker.finalize({ text: 'duplicate' }),
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID),
  )
})

test('canonical broker converts empty terminal text into a durable incomplete result', async (t) => {
  for (const scenario of [
    { name: 'empty text', text: '' },
    { name: 'whitespace-only text', text: ' \r\n\t ' },
  ]) {
    await t.test(scenario.name, async () => {
      const checkpoints = []
      let providerCalls = 0
      const prepared = await prepareToolsLoopRuntime(modelContext({
        checkpoints,
        runModel: async () => {
          providerCalls += 1
          return { content: scenario.text, toolCalls: [] }
        },
      }))
      const broker = createCanonicalHarnessModelBroker(prepared)

      await broker.modelRequest({})
      const result = await broker.finalize({ text: scenario.text })

      assert.equal(result.incomplete, true)
      assert.ok(result.text.trim(), 'empty model output must produce a visible terminal message')
      assert.ok(String(result.reason || '').trim(), 'empty model output must have an incomplete reason')

      const terminalCheckpoint = structuredClone(checkpoints.at(-1).state)
      assert.equal(terminalCheckpoint.final.incomplete, true)
      assert.equal(terminalCheckpoint.final.text, result.text)
      assert.equal(terminalCheckpoint.final.reason, result.reason)
      assert.equal(terminalCheckpoint.final.reason, 'empty_model_response')
      assert.equal(Object.hasOwn(terminalCheckpoint, 'modelInvocation'), false)

      const resumed = await runToolsLoop(modelContext({
        loadCheckpoint: async () => ({ state: terminalCheckpoint }),
        runModel: async () => {
          providerCalls += 1
          return { content: 'must not repeat an empty Provider response', toolCalls: [] }
        },
      }))
      assert.equal(resumed.incomplete, true)
      assert.equal(resumed.text, result.text)
      assert.equal(resumed.reason, result.reason)
      assert.equal(providerCalls, 1)
    })
  }
})

test('legacy empty canonical final resumes as incomplete without another Provider request', async () => {
  const checkpoints = []
  let providerCalls = 0
  const prepared = await prepareToolsLoopRuntime(modelContext({
    checkpoints,
    runModel: async () => {
      providerCalls += 1
      return { content: 'initial response', toolCalls: [] }
    },
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  const response = await broker.modelRequest({})
  await broker.finalize({ text: response.content })
  const legacyCheckpoint = structuredClone(checkpoints.at(-1).state)
  legacyCheckpoint.final = {
    ...legacyCheckpoint.final,
    text: '',
    incomplete: false,
    reason: null,
    harnessAdapter: true,
  }

  const resumed = await runToolsLoop(modelContext({
    loadCheckpoint: async () => ({ state: legacyCheckpoint }),
    runModel: async () => {
      providerCalls += 1
      return { content: 'must not repeat Provider work', toolCalls: [] }
    },
  }))

  assert.equal(resumed.incomplete, true)
  assert.equal(resumed.reason, 'empty_model_response')
  assert.ok(resumed.text.trim(), 'legacy empty final must recover with a visible message')
  assert.equal(providerCalls, 1)
})

test('canonical terminal receipt matches the stopping event and durable final', async () => {
  const checkpoints = []
  let stoppingResult = null
  const prepared = await prepareToolsLoopRuntime(modelContext({ checkpoints }))
  accessPreparedToolsLoopRuntime(prepared, (state) => {
    const emitTurnStopping = state.emitTurnStopping
    state.emitTurnStopping = async (result, phase) => {
      stoppingResult = structuredClone(result)
      return emitTurnStopping(result, phase)
    }
  })
  const broker = createCanonicalHarnessModelBroker(prepared)

  const response = await broker.modelRequest({})
  const immediateResult = await broker.finalize({ text: response.content })
  const durableFinal = checkpoints.at(-1).state.final
  const coreReceipt = (value) => ({
    text: String(value?.text || ''),
    iterations: Math.max(0, Number(value?.iterations) || 0),
    incomplete: value?.incomplete === true,
    reason: value?.reason || null,
  })

  assert.deepEqual(coreReceipt(stoppingResult), coreReceipt(immediateResult))
  assert.deepEqual(coreReceipt(immediateResult), coreReceipt(durableFinal))
})

test('canonical broker is single-flight and abort preserves the completed replay fence', async () => {
  const checkpoints = []
  let releaseProvider
  const providerPending = new Promise((resolve) => { releaseProvider = resolve })
  const prepared = await prepareToolsLoopRuntime(modelContext({
    checkpoints,
    runModel: async () => providerPending,
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  const first = broker.modelRequest({})
  await assert.rejects(
    broker.modelRequest({}),
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.BUSY),
  )
  releaseProvider({ content: 'settled once', toolCalls: [] })
  assert.equal((await first).content, 'settled once')
  await broker.abort()

  const aborted = checkpoints.at(-1)
  assert.equal(aborted.boundary, 'harness-adapter-aborted')
  assert.equal(aborted.state.modelInvocation.status, 'completed')
})

test('canonical abort cancels a provider request and persists one recovery checkpoint', async () => {
  const checkpoints = []
  let providerSignal = null
  let providerStarted
  const started = new Promise((resolve) => { providerStarted = resolve })
  const prepared = await prepareToolsLoopRuntime(modelContext({
    checkpoints,
    runModel: async ({ signal }) => {
      providerSignal = signal
      providerStarted()
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new Error('provider aborted'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    },
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  const request = broker.modelRequest({})
  await started
  const [firstAbort, secondAbort] = await Promise.all([broker.abort(), broker.abort()])
  assert.equal(firstAbort, undefined)
  assert.equal(secondAbort, undefined)
  await assert.rejects(
    request,
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID),
  )
  assert.equal(providerSignal?.aborted, true)
  assert.equal(
    checkpoints.filter((item) => item.boundary === 'harness-adapter-aborted').length,
    1,
  )
  assert.equal(checkpoints.at(-1).state.modelInvocation.status, 'in_flight')
})

test('canonical abort is bounded and fences a provider that ignores cancellation', async () => {
  const checkpoints = []
  let releaseProvider
  let providerStarted
  const started = new Promise((resolve) => { providerStarted = resolve })
  const providerPending = new Promise((resolve) => { releaseProvider = resolve })
  const prepared = await prepareToolsLoopRuntime(modelContext({
    checkpoints,
    runModel: async () => {
      providerStarted()
      return providerPending
    },
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  const request = broker.modelRequest({})
  await started
  const abortStartedAt = Date.now()
  await broker.abort()
  assert.ok(Date.now() - abortStartedAt < 1_000, 'abort must not wait indefinitely for Provider')
  const checkpointCountAfterAbort = checkpoints.length
  assert.equal(checkpoints.at(-1).boundary, 'harness-adapter-aborted')
  assert.equal(checkpoints.at(-1).state.modelInvocation.status, 'in_flight')

  releaseProvider({ content: 'late response must be fenced', toolCalls: [] })
  await assert.rejects(
    request,
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID),
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(checkpoints.length, checkpointCountAfterAbort)
})

test('canonical abort remains durable when a response checkpoint settles late', async () => {
  const completedWrites = []
  let durableCheckpoint = null
  let releaseResponseCheckpoint
  let responseCheckpointStarted
  const responseCheckpointPending = new Promise((resolve) => {
    releaseResponseCheckpoint = resolve
  })
  const responseCheckpointHasStarted = new Promise((resolve) => {
    responseCheckpointStarted = resolve
  })
  const prepared = await prepareToolsLoopRuntime(modelContext({
    saveCheckpoint: async (state, meta = {}) => {
      const checkpoint = {
        state: structuredClone(state),
        boundary: meta.boundary || null,
      }
      if (checkpoint.boundary === 'harness-model-response') {
        responseCheckpointStarted()
        await responseCheckpointPending
      }
      durableCheckpoint = checkpoint
      completedWrites.push(checkpoint)
      return true
    },
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  const request = broker.modelRequest({})
  await responseCheckpointHasStarted
  const abortStartedAt = Date.now()
  await broker.abort()
  const abortDurationMs = Date.now() - abortStartedAt
  const durableImmediatelyAfterAbort = durableCheckpoint?.boundary
  const requestRejected = assert.rejects(
    request,
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID),
  )
  releaseResponseCheckpoint()
  await requestRejected
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(abortDurationMs < 1_000, 'abort must remain bounded while a checkpoint write is stuck')
  assert.equal(durableImmediatelyAfterAbort, 'harness-adapter-aborted')
  assert.equal(durableCheckpoint?.boundary, 'harness-adapter-aborted')
  assert.equal(durableCheckpoint?.state.final, null)
  assert.equal(completedWrites.at(-1)?.boundary, 'harness-adapter-aborted')
})

test('canonical broker prevents provider work when the request checkpoint cannot be saved', async () => {
  let providerCalls = 0
  const checkpointCause = new Error('checkpoint unavailable')
  const prepared = await prepareToolsLoopRuntime(modelContext({
    saveCheckpoint: async (_state, meta = {}) => {
      if (meta.boundary === 'model-request') throw checkpointCause
      return true
    },
    runModel: async () => {
      providerCalls += 1
      return { content: 'must not run', toolCalls: [] }
    },
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  await assert.rejects(
    broker.modelRequest({}),
    (error) => error?.code === 'CHECKPOINT_FLUSH_FAILED'
      && error?.cause === checkpointCause,
  )
  assert.equal(providerCalls, 0)
})

test('canonical broker rejects forged prepared handles and duplicate ownership', async () => {
  const forged = Object.freeze(Object.create(null))
  assert.throws(
    () => createCanonicalHarnessModelBroker(forged),
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.INVALID),
  )

  const prepared = await prepareToolsLoopRuntime(modelContext())
  const broker = createCanonicalHarnessModelBroker(prepared)
  assert.throws(
    () => createCanonicalHarnessModelBroker(prepared),
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.INVALID),
  )
  await broker.abort()
})

test('response checkpoint failure consumes the request and preserves its completed fence', async () => {
  const checkpoints = []
  let providerCalls = 0
  let rejectResponseCheckpoint = true
  const prepared = await prepareToolsLoopRuntime(modelContext({
    runModel: async () => {
      providerCalls += 1
      return { content: 'completed before checkpoint failure', toolCalls: [] }
    },
    saveCheckpoint: async (state, meta = {}) => {
      checkpoints.push({ state: structuredClone(state), boundary: meta.boundary || null })
      if (meta.boundary === 'harness-model-response' && rejectResponseCheckpoint) {
        rejectResponseCheckpoint = false
        throw new Error('injected response checkpoint failure')
      }
      return true
    },
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  await assert.rejects(
    broker.modelRequest({}),
    (error) => error?.code === 'CHECKPOINT_FLUSH_FAILED',
  )
  await assert.rejects(
    broker.modelRequest({}),
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.ALREADY_USED),
  )
  await assert.rejects(
    broker.finalize({ text: 'must not bypass the failed response checkpoint' }),
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID),
  )
  await broker.abort()

  assert.equal(providerCalls, 1)
  const recovered = checkpoints.at(-1)
  assert.equal(recovered.boundary, 'harness-adapter-aborted')
  assert.equal(recovered.state.modelInvocation.status, 'completed')
  assert.equal(recovered.state.final, null)
})

test('failed final checkpoint restores the completed invocation before abort persists recovery', async () => {
  const checkpoints = []
  let rejectFinalCheckpoint = true
  const prepared = await prepareToolsLoopRuntime(modelContext({
    saveCheckpoint: async (state, meta = {}) => {
      checkpoints.push({ state: structuredClone(state), boundary: meta.boundary || null })
      if (meta.final && rejectFinalCheckpoint) {
        rejectFinalCheckpoint = false
        throw new Error('injected final checkpoint failure')
      }
      return true
    },
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  const response = await broker.modelRequest({})
  await assert.rejects(
    broker.finalize({ text: response.content }),
    (error) => error?.code === 'CHECKPOINT_FLUSH_FAILED',
  )
  await broker.abort()

  const recovered = checkpoints.at(-1)
  assert.equal(recovered.boundary, 'harness-adapter-aborted')
  assert.equal(recovered.state.modelInvocation.status, 'completed')
  assert.equal(recovered.state.final, null)
  assert.equal(
    recovered.state.messages.some((message) => (
      message.role === 'assistant' && message.content === response.content
    )),
    false,
  )
})

test('failed final checkpoint rolls back host deliverable fallback before abort recovery', async () => {
  const checkpoints = []
  const artifactId = 'fallback-rollback-artifact'
  let rejectFinalCheckpoint = true
  const prepared = await prepareToolsLoopRuntime(modelContext({
    saveCheckpoint: async (state, meta = {}) => {
      checkpoints.push({ state: structuredClone(state), boundary: meta.boundary || null })
      if (meta.final && rejectFinalCheckpoint) {
        rejectFinalCheckpoint = false
        throw new Error('injected deliverable final checkpoint failure')
      }
      return true
    },
  }))
  accessPreparedToolsLoopRuntime(prepared, (state) => {
    state.artifactIds = [artifactId]
    state.deliverableSelectionRetries = 2
    state.needsDeliverableSelection = () => !state.deliveryArtifactSelectionExplicit
    state.applySafeDeliverableFallback = () => {
      state.deliveryArtifactIds = [artifactId]
      state.deliveryArtifactSelectionArtifactIds = [...state.artifactIds]
      state.deliveryArtifactSelectionExplicit = true
      state.deliverableSelectionRetries = 0
      return { ok: true, fallback: true, deliveryArtifactIds: [artifactId] }
    }
  })
  const broker = createCanonicalHarnessModelBroker(prepared)

  const response = await broker.modelRequest({})
  await assert.rejects(
    broker.finalize({ text: response.content }),
    (error) => error?.code === 'CHECKPOINT_FLUSH_FAILED',
  )
  await broker.abort()

  const recovered = checkpoints.at(-1)
  assert.equal(recovered.boundary, 'harness-adapter-aborted')
  assert.equal(recovered.state.modelInvocation.status, 'completed')
  assert.deepEqual(recovered.state.deliveryArtifactIds, [])
  assert.deepEqual(
    recovered.state.completionGuards.deliveryArtifactSelectionArtifactIds,
    [],
  )
  assert.equal(recovered.state.completionGuards.deliverableSelectionRetries, 2)
  assert.equal(recovered.state.final, null)
})

test('failed or outcome-unknown model attempts cannot be finalized as adapter success', async () => {
  const checkpoints = []
  const unknown = Object.assign(new Error('private upstream request may still be running'), {
    code: 'MODEL_REQUEST_OUTCOME_UNKNOWN',
    unsafeToReplay: true,
  })
  const prepared = await prepareToolsLoopRuntime(modelContext({
    checkpoints,
    runModel: async () => { throw unknown },
  }))
  const broker = createCanonicalHarnessModelBroker(prepared)

  await assert.rejects(broker.modelRequest({}), (error) => error === unknown)
  await assert.rejects(
    broker.finalize({ text: 'adapter fallback must not become terminal' }),
    hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID),
  )
  await broker.abort()

  const recovered = checkpoints.at(-1)
  assert.equal(recovered.boundary, 'harness-adapter-aborted')
  assert.equal(recovered.state.modelInvocation.status, 'in_flight')
  assert.equal(recovered.state.final, null)
})

function v3Controller(run) {
  return createToolLoopAdapterController({
    adapter: {
      id: 'test.canonical-harness-replay',
      contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
      hostCapabilities: { loopBroker: TOOL_LOOP_ADAPTER_BROKER_VERSION },
      run,
    },
    identity: {
      adapterId: 'test.canonical-harness-replay',
      owner: 'plugin.canonical-harness-test',
      version: '1.0.0',
      revision: 1,
      releaseDigest: 'sha256:canonical-harness-test',
      contractVersion: TOOL_LOOP_ADAPTER_CONTRACT_VERSION_V3,
      brokerVersion: TOOL_LOOP_ADAPTER_BROKER_VERSION,
      source: 'runtime-capability-host',
      generation: 1,
    },
  })
}

test('v3 adapter cannot catch an unknown model outcome and finalize fallback text', async () => {
  let checkpoint = null
  let observedBrokerError = null
  let providerCalls = 0
  const controller = v3Controller(async (context) => {
    try {
      await context.harness.model.request({})
    } catch (error) {
      observedBrokerError = error
    }
    return { text: 'adapter fallback must not erase the unknown request fence' }
  })
  controller.activate()

  try {
    await assert.rejects(
      runToolsLoop({
        job: {
          id: 'canonical-harness-unknown-turn',
          userId: 'canonical-harness-unknown-user',
          sessionId: 'canonical-harness-unknown-session',
          origin: 'chat',
          prompt: 'Answer once.',
          modelName: 'user-configured-model',
          modelProviderId: 'user-configured-provider',
          modelConfigRevision: 1,
        },
        step: { id: 'canonical-harness-unknown-turn', kind: 'chat' },
        messages: [{ role: 'user', content: 'Answer once.' }],
        toolSpecs: [],
        maxIters: 1,
        saveCheckpoint: async (state) => {
          checkpoint = structuredClone(state)
          return true
        },
        runModel: async () => {
          providerCalls += 1
          throw Object.assign(
            new Error('https://private.invalid/v1 key=sk-private-provider-key'),
            { code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', unsafeToReplay: true },
          )
        },
      }),
      hasCode(CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID),
    )
    assert.equal(providerCalls, 1)
    assert.equal(observedBrokerError?.code, 'LOOP_HARNESS_MODEL_BROKER_FAILED')
    assert.doesNotMatch(String(observedBrokerError?.message || ''), /private|provider-key/iu)
    assert.equal(checkpoint.modelInvocation.status, 'in_flight')
    assert.equal(checkpoint.final, null)
  } finally {
    controller.release()
  }
})

test('v3 adapter crash aborts fire-and-forget model work without late checkpoints', async () => {
  const checkpoints = []
  let providerSignal = null
  let providerStarted
  let releaseProvider
  const started = new Promise((resolve) => { providerStarted = resolve })
  const providerPending = new Promise((resolve) => { releaseProvider = resolve })
  const controller = v3Controller(async (context) => {
    void context.harness.model.request({})
    await started
    throw new Error('adapter crashed with model work in flight')
  })
  controller.activate()

  try {
    const startedAt = Date.now()
    await assert.rejects(
      runToolsLoop({
        job: {
          id: 'canonical-harness-fire-and-forget-turn',
          userId: 'canonical-harness-fire-and-forget-user',
          sessionId: 'canonical-harness-fire-and-forget-session',
          origin: 'chat',
          prompt: 'Answer once.',
          modelName: 'user-configured-model',
          modelProviderId: 'user-configured-provider',
          modelConfigRevision: 1,
        },
        step: { id: 'canonical-harness-fire-and-forget-turn', kind: 'chat' },
        messages: [{ role: 'user', content: 'Answer once.' }],
        toolSpecs: [],
        maxIters: 1,
        saveCheckpoint: async (state, meta = {}) => {
          checkpoints.push({ state: structuredClone(state), boundary: meta.boundary || null })
          return true
        },
        runModel: async ({ signal }) => {
          providerSignal = signal
          providerStarted()
          return providerPending
        },
      }),
      /adapter crashed with model work in flight/u,
    )
    assert.ok(Date.now() - startedAt < 1_000, 'adapter failure must not wait on a stuck Provider')
    assert.equal(providerSignal?.aborted, true)
    assert.equal(checkpoints.at(-1).boundary, 'harness-adapter-aborted')
    assert.equal(checkpoints.at(-1).state.modelInvocation.status, 'in_flight')
    const checkpointCountAfterAbort = checkpoints.length

    releaseProvider({ content: 'late response must be ignored', toolCalls: [] })
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(checkpoints.length, checkpointCountAfterAbort)
  } finally {
    releaseProvider?.({ content: 'cleanup response', toolCalls: [] })
    controller.release()
  }
})

test('v3 adapter crash replays the durable model response without a duplicate provider request', async () => {
  let checkpoint = null
  let providerCalls = 0
  let adapterRuns = 0
  const controller = v3Controller(async (context) => {
    adapterRuns += 1
    await assert.rejects(
      context.harness.model.request({ baseURL: 'https://attacker.invalid', apiKey: 'secret' }),
      (error) => error?.code === 'LOOP_HARNESS_MODEL_BROKER_FAILED'
        && !String(error?.message || '').includes('attacker.invalid')
        && !String(error?.message || '').includes('secret'),
    )
    const response = await context.harness.model.request({})
    if (adapterRuns === 1) throw new Error('adapter crashed after durable model response')
    return { text: response.content }
  })
  controller.activate()

  const options = () => ({
    job: {
      id: 'canonical-harness-replay-turn',
      userId: 'canonical-harness-replay-user',
      sessionId: 'canonical-harness-replay-session',
      origin: 'chat',
      prompt: 'Answer once.',
      modelName: 'user-configured-model',
      modelProviderId: 'user-configured-provider',
      modelConfigRevision: 1,
    },
    step: { id: 'canonical-harness-replay-turn', kind: 'chat' },
    messages: [{ role: 'user', content: 'Answer once.' }],
    toolSpecs: [],
    maxIters: 1,
    loadCheckpoint: checkpoint ? async () => ({ state: checkpoint }) : undefined,
    saveCheckpoint: async (state) => {
      checkpoint = structuredClone(state)
      return { state: checkpoint }
    },
    runModel: async () => {
      providerCalls += 1
      return { content: 'durable canonical answer', toolCalls: [] }
    },
  })

  try {
    await assert.rejects(
      runToolsLoop(options()),
      /adapter crashed after durable model response/u,
    )
    assert.equal(providerCalls, 1)
    assert.equal(checkpoint.modelInvocation.status, 'completed')

    const resumed = await runToolsLoop(options())
    assert.equal(resumed.text, 'durable canonical answer')
    assert.equal(providerCalls, 1, 'completed model response must replay without another provider call')
    assert.equal(Object.hasOwn(checkpoint, 'modelInvocation'), false)
    assert.equal(checkpoint.final.text, 'durable canonical answer')
  } finally {
    controller.release()
  }
})
