import { types as utilTypes } from 'node:util'

import {
  usePreparedToolsLoopRuntime as accessPreparedToolsLoopRuntime,
} from './runtime.js'
import {
  finishUnsatisfiedTerminalGate,
  protectTerminalCandidate,
} from './runtime-finalizeRuntime.js'

export const CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES = Object.freeze({
  INVALID: 'CANONICAL_HARNESS_MODEL_BROKER_INVALID',
  REQUEST_INVALID: 'CANONICAL_HARNESS_MODEL_REQUEST_INVALID',
  BUSY: 'CANONICAL_HARNESS_MODEL_BROKER_BUSY',
  ALREADY_USED: 'CANONICAL_HARNESS_MODEL_BROKER_ALREADY_USED',
  LIFECYCLE_INVALID: 'CANONICAL_HARNESS_MODEL_BROKER_LIFECYCLE_INVALID',
})

const claimedPreparedRuntimes = new WeakSet()
const CANONICAL_HARNESS_ABORT_GRACE_MS = 100
const EMPTY_MODEL_RESPONSE_REASON = 'empty_model_response'

function brokerError(code, message) {
  return Object.assign(new TypeError(message), {
    code,
    retryable: false,
  })
}

function createRequestAbortScope(parentSignal) {
  const controller = new AbortController()
  let removeParentAbort = null
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  if (parentSignal && typeof parentSignal.addEventListener === 'function') {
    const forwardParentAbort = () => abort(parentSignal.reason)
    if (parentSignal.aborted) forwardParentAbort()
    else {
      parentSignal.addEventListener('abort', forwardParentAbort, { once: true })
      removeParentAbort = () => parentSignal.removeEventListener('abort', forwardParentAbort)
    }
  }
  return Object.freeze({
    signal: controller.signal,
    abort,
    dispose() {
      removeParentAbort?.()
      removeParentAbort = null
    },
  })
}

async function waitForSettlement(promise, timeoutMs) {
  let timer = null
  const settled = Promise.resolve(promise).then(
    () => true,
    () => true,
  )
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([settled, timedOut])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) {
    return false
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function assertEmptyRequest(request) {
  if (!isPlainObject(request)) {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.REQUEST_INVALID,
      'Canonical Harness model requests must be plain objects',
    )
  }
  let keys
  try {
    keys = Reflect.ownKeys(request)
  } catch {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.REQUEST_INVALID,
      'Canonical Harness model request could not be inspected safely',
    )
  }
  if (keys.length !== 0) {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.REQUEST_INVALID,
      'Canonical Harness model request does not accept caller-controlled fields',
    )
  }
}

function ownText(result) {
  if (!isPlainObject(result)) {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
      'Canonical Harness final result must be a plain object',
    )
  }
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(result, 'text')
  } catch {
    descriptor = null
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
      'Canonical Harness final result must declare a text data property',
    )
  }
  return descriptor.value
}

function publicModelResult(response) {
  return Object.freeze({
    content: typeof response?.content === 'string' ? response.content : '',
    toolCalls: Object.freeze([]),
  })
}

function frozenStringArray(value) {
  return Object.freeze(
    (Array.isArray(value) ? value : []).filter((item) => typeof item === 'string'),
  )
}

function publicFinalResult(result) {
  const terminal = {
    text: typeof result?.text === 'string' ? result.text : '',
    artifactIds: frozenStringArray(result?.artifactIds),
    deliveryArtifactIds: frozenStringArray(result?.deliveryArtifactIds),
    iterations: Math.max(0, Number(result?.iterations) || 0),
  }
  if (result?.incomplete === true) {
    terminal.incomplete = true
    terminal.reason = typeof result?.reason === 'string' ? result.reason : null
  }
  return Object.freeze(terminal)
}

function claimPreparedRuntime(prepared) {
  if (!prepared || typeof prepared !== 'object' || claimedPreparedRuntimes.has(prepared)) {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.INVALID,
      'A fresh prepared Tools Loop runtime is required',
    )
  }
  let runtimeState
  try {
    accessPreparedToolsLoopRuntime(prepared, (state) => {
      if (typeof state?.callTrackedModel !== 'function'
        || typeof state?.persistTurn !== 'function'
        || !Array.isArray(state?.convo)
        || !state?.budget
        || typeof state.budget.consume !== 'function') {
        throw brokerError(
          CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.INVALID,
          'Prepared Tools Loop runtime is not ready for canonical model requests',
        )
      }
      runtimeState = state
    })
  } catch (error) {
    if (error?.code === CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.INVALID) throw error
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.INVALID,
      'Prepared Tools Loop runtime could not be claimed',
    )
  }
  claimedPreparedRuntimes.add(prepared)
  return runtimeState
}

function restorePreRequestDeliveryState(runtime) {
  const { runtimeState, state } = runtime
  if (!state.preRequestDeliveryState) return
  runtimeState.deliveryArtifactIds = [...state.preRequestDeliveryState.deliveryArtifactIds]
  runtimeState.deliveryArtifactSelectionArtifactIds = [
    ...state.preRequestDeliveryState.deliveryArtifactSelectionArtifactIds,
  ]
  runtimeState.deliveryArtifactSelectionExplicit = state.preRequestDeliveryState
    .deliveryArtifactSelectionExplicit
  runtimeState.deliverableSelectionRetries = state.preRequestDeliveryState
    .deliverableSelectionRetries
}

async function runCanonicalModelRequest(runtime, request) {
  const { state, runtimeState } = runtime
  assertEmptyRequest(request)
  if (state.phase === 'in_flight') {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.BUSY,
      'Canonical Harness model request is already in flight',
    )
  }
  if (state.phase !== 'idle') {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.ALREADY_USED,
      'Canonical Harness model request has already been used',
    )
  }
  const requestToken = {
    revoked: false,
    error: brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
      'Canonical Harness model request is no longer owned by this run',
    ),
  }
  const abortScope = createRequestAbortScope(runtimeState.signal)
  const assertRequestActive = () => {
    if (state.activeRequestToken !== requestToken
      || requestToken.revoked
      || abortScope.signal.aborted) {
      requestToken.revoked = true
      throw requestToken.error
    }
  }
  state.phase = 'in_flight'
  state.activeRequestToken = requestToken
  state.requestAbortScope = abortScope
  state.pendingRequest = (async () => {
    if (runtimeState.needsDeliverableSelection?.()) {
      const deliveryState = {
        deliveryArtifactIds: [...runtimeState.deliveryArtifactIds],
        deliveryArtifactSelectionArtifactIds: [
          ...runtimeState.deliveryArtifactSelectionArtifactIds,
        ],
        deliveryArtifactSelectionExplicit: runtimeState.deliveryArtifactSelectionExplicit,
        deliverableSelectionRetries: runtimeState.deliverableSelectionRetries,
      }
      if (runtimeState.applySafeDeliverableFallback?.()) {
        state.preRequestDeliveryState = deliveryState
      }
    }
    runtimeState.prepareFinalAnswerEvidenceReview?.()
    const answerReviewDigest = runtimeState.hasCurrentFinalAnswerEvidenceReview?.()
      ? runtimeState.currentFinalAnswerEvidenceDigest()
      : null
    const tracked = await runtimeState.callTrackedModel({
      messages: runtimeState.convo,
      tools: [],
      toolChoice: 'none',
      allowOverBudget: false,
      consumeBudget: (cost) => runtimeState.budget.consume(cost),
      requestSignal: abortScope.signal,
      assertRequestActive,
    })
    assertRequestActive()
    runtimeState.convo.splice(0, runtimeState.convo.length, ...tracked.messages)
    runtimeState.recovery = runtimeState.d.mergeCompactionRecovery(
      runtimeState.recovery,
      tracked.recovery,
    )
    assertRequestActive()
    state.responseCheckpointPending = true
    try {
      await runtimeState.persistTurn({ boundary: 'harness-model-response' })
    } finally {
      state.responseCheckpointPending = false
    }
    assertRequestActive()
    const response = publicModelResult(tracked.response)
    state.committedResponseText = response.content
    state.committedAnswerReviewDigest = answerReviewDigest
    return response
  })()
  try {
    const response = await state.pendingRequest
    assertRequestActive()
    if (state.phase === 'in_flight') state.phase = 'response_committed'
    return response
  } catch (error) {
    if (state.phase === 'in_flight') state.phase = 'request_failed'
    throw error
  } finally {
    if (state.activeRequestToken === requestToken && state.phase !== 'aborting') {
      state.activeRequestToken = null
      state.requestAbortScope = null
    }
    if (state.phase !== 'aborting') abortScope.dispose()
  }
}

function captureBrokerFinalization(runtime) {
  const r = runtime.runtimeState
  return {
    phase: runtime.state.phase,
    modelInvocation: r.modelInvocation,
    restoredModelInvocation: r.restoredModelInvocation,
    conversationLength: r.convo.length,
    finalText: r.finalText,
    finalCheckpointPersisted: r.finalCheckpointPersisted,
    finalLocalHtmlDeliveryFailure: r.finalLocalHtmlDeliveryFailure,
    localHtmlDeliveryRetries: r.localHtmlDeliveryRetries,
    localHtmlDeliveryValidationPending: r.localHtmlDeliveryValidationPending,
    deliveryArtifactIds: [...r.deliveryArtifactIds],
    deliveryArtifactSelectionArtifactIds: [...r.deliveryArtifactSelectionArtifactIds],
    deliveryArtifactSelectionExplicit: r.deliveryArtifactSelectionExplicit,
    deliverableSelectionRetries: r.deliverableSelectionRetries,
  }
}

function restoreBrokerFinalization(runtime, previous) {
  const { runtimeState, state } = runtime
  runtimeState.modelInvocation = previous.modelInvocation
  runtimeState.restoredModelInvocation = previous.restoredModelInvocation
  runtimeState.convo.splice(previous.conversationLength)
  runtimeState.finalText = previous.finalText
  runtimeState.finalCheckpointPersisted = previous.finalCheckpointPersisted
  runtimeState.finalLocalHtmlDeliveryFailure = previous.finalLocalHtmlDeliveryFailure
  runtimeState.localHtmlDeliveryRetries = previous.localHtmlDeliveryRetries
  runtimeState.localHtmlDeliveryValidationPending = previous.localHtmlDeliveryValidationPending
  if (state.preRequestDeliveryState) restorePreRequestDeliveryState(runtime)
  else {
    runtimeState.deliveryArtifactIds = previous.deliveryArtifactIds
    runtimeState.deliveryArtifactSelectionArtifactIds = previous.deliveryArtifactSelectionArtifactIds
    runtimeState.deliveryArtifactSelectionExplicit = previous.deliveryArtifactSelectionExplicit
    runtimeState.deliverableSelectionRetries = previous.deliverableSelectionRetries
  }
  state.phase = previous.phase
}

async function finishCanonicalTerminalGate(runtime) {
  const { runtimeState, state } = runtime
  const blocked = await finishUnsatisfiedTerminalGate(runtimeState)
  if (blocked) {
    if (blocked.deferredForSteering === true) {
      throw brokerError(
        CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
        'Canonical Harness finalization was deferred by the host',
      )
    }
    state.finalCheckpointPersisted = runtimeState.finalCheckpointPersisted === true
    state.phase = 'finalized'
    return publicFinalResult(blocked)
  }
  if (runtimeState.requiresFinalAnswerEvidenceReview()
    && (!state.committedAnswerReviewDigest
      || !runtimeState.hasCurrentFinalAnswerEvidenceReview(state.committedAnswerReviewDigest))) {
    const incomplete = await runtimeState.finishIncomplete({
      text: '',
      reason: 'final_answer_evidence_review_missing',
    })
    if (incomplete?.deferredForSteering === true) {
      throw brokerError(
        CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
        'Canonical Harness finalization was deferred by the host',
      )
    }
    state.finalCheckpointPersisted = runtimeState.finalCheckpointPersisted === true
    state.phase = 'finalized'
    return publicFinalResult(incomplete)
  }
  return null
}

async function finalizeCanonicalBroker(runtime, result) {
  const { state, runtimeState } = runtime
  if (state.phase === 'in_flight') {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.BUSY,
      'Canonical Harness model request must settle before finalization',
    )
  }
  if (['finalized', 'aborted', 'finalizing'].includes(state.phase)) {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
      'Canonical Harness broker lifecycle is already closed',
    )
  }
  if (state.phase !== 'response_committed') {
    throw brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
      'Canonical Harness model response must commit before finalization',
    )
  }
  const adapterText = ownText(result)
  const previous = captureBrokerFinalization(runtime)
  state.finalCheckpointPersisted = false
  state.phase = 'finalizing'
  try {
    const blocked = await finishCanonicalTerminalGate(runtime)
    if (blocked) return blocked
    const candidate = runtimeState.requiresFinalAnswerEvidenceReview()
      ? state.committedResponseText
      : adapterText
    const protectedText = protectTerminalCandidate(runtimeState, candidate)
    const emptyModelResponse = !protectedText.trim()
    const terminalText = emptyModelResponse
      ? protectTerminalCandidate(
          runtimeState,
          runtimeState.d.formatIncompleteTerminalText(EMPTY_MODEL_RESPONSE_REASON, {
            locale: runtimeState.locale,
          }),
          { incomplete: true },
        )
      : protectedText
    const terminalReceipt = {
      text: terminalText,
      iterations: Math.max(1, Number(runtimeState.iter) + 1 || 1),
      incomplete: emptyModelResponse,
      reason: emptyModelResponse ? EMPTY_MODEL_RESPONSE_REASON : null,
    }
    const completion = await runtimeState.steeringController.prepareCompletion({
      text: terminalReceipt.text,
      incomplete: terminalReceipt.incomplete,
      reason: terminalReceipt.reason,
    })
    if (!completion.closed) {
      throw brokerError(
        CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
        'Canonical Harness finalization was deferred by the host',
      )
    }
    if (terminalReceipt.incomplete) runtimeState.suppressTerminalArtifacts()
    if (!completion.prepared && terminalReceipt.text) {
      runtimeState.convo.push({ role: 'assistant', content: terminalReceipt.text })
    }
    runtimeState.modelInvocation = null
    runtimeState.restoredModelInvocation = null
    await runtimeState.persistTurn({
      boundary: 'harness-model-final',
      final: { ...terminalReceipt, harnessAdapter: true },
    })
    state.finalCheckpointPersisted = true
    runtimeState.finalCheckpointPersisted = true
    state.phase = 'finalized'
    const selection = runtimeState.deliverySelectionFields()
    const terminal = publicFinalResult({
      ...terminalReceipt,
      artifactIds: runtimeState.artifactIds,
      deliveryArtifactIds: selection.deliveryArtifactIds,
    })
    await runtimeState.emitTurnStopping(terminal)
    return terminal
  } catch (error) {
    if (!state.finalCheckpointPersisted && runtimeState.finalCheckpointPersisted !== true) {
      restoreBrokerFinalization(runtime, previous)
    } else {
      state.phase = 'finalized'
    }
    throw error
  }
}

function abortCanonicalBroker(runtime) {
  const { state, runtimeState } = runtime
  if (state.phase === 'finalized' || state.phase === 'aborted') return
  if (state.abortPromise) return state.abortPromise
  if (state.phase === 'finalizing') {
    return Promise.reject(brokerError(
      CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.BUSY,
      'Canonical Harness broker is finalizing',
    ))
  }
  state.abortPromise = (async () => {
    state.phase = 'aborting'
    const requestToken = state.activeRequestToken
    if (requestToken) {
      requestToken.revoked = true
      state.requestAbortScope?.abort(requestToken.error)
    }
    let pendingRequestSettled = true
    const repairLateResponseCheckpoint = Boolean(state.responseCheckpointPending)
    if (state.pendingRequest && requestToken) {
      pendingRequestSettled = await waitForSettlement(
        state.pendingRequest,
        CANONICAL_HARNESS_ABORT_GRACE_MS,
      )
    }
    state.requestAbortScope?.dispose()
    restorePreRequestDeliveryState(runtime)
    await runtimeState.persistTurn({ boundary: 'harness-adapter-aborted' })
    state.phase = 'aborted'
    if (!pendingRequestSettled && repairLateResponseCheckpoint) {
      void Promise.resolve(state.pendingRequest)
        .catch(() => undefined)
        .then(async () => {
          if (state.phase === 'aborted') {
            await runtimeState.persistTurn({ boundary: 'harness-adapter-aborted' })
          }
        })
        .catch(() => undefined)
    }
  })()
  return state.abortPromise
}

/** Bind one prepared Loop runtime to a deliberately narrow model capability. */
export function createCanonicalHarnessModelBroker(prepared) {
  const runtimeState = claimPreparedRuntime(prepared)
  const runtime = {
    runtimeState,
    state: {
      phase: 'idle',
      pendingRequest: null,
      activeRequestToken: null,
      requestAbortScope: null,
      abortPromise: null,
      responseCheckpointPending: false,
      committedResponseText: null,
      committedAnswerReviewDigest: null,
      preRequestDeliveryState: null,
      finalCheckpointPersisted: false,
    },
  }
  return Object.freeze({
    modelRequest: (request) => runCanonicalModelRequest(runtime, request),
    finalize: (result) => finalizeCanonicalBroker(runtime, result),
    abort: () => abortCanonicalBroker(runtime),
  })
}
