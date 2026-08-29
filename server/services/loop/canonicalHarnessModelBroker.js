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
const EMPTY_MODEL_RESPONSE_TEXT = '模型未返回可显示内容，本次任务未完成。请重试，或检查当前模型配置。'
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

/**
 * Bind one prepared Loop runtime to a deliberately narrow model capability.
 * Provider selection, credentials, transcript, tools, budget, checkpointing,
 * reconciliation, and compaction remain owned by the host runtime.
 */
export function createCanonicalHarnessModelBroker(prepared) {
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

  let phase = 'idle'
  let pendingRequest = null
  let activeRequestToken = null
  let requestAbortScope = null
  let abortPromise = null
  let responseCheckpointPending = false
  let committedResponseText = null
  let committedAnswerReviewDigest = null
  let preRequestDeliveryState = null

  const restorePreRequestDeliveryState = () => {
    if (!preRequestDeliveryState) return
    runtimeState.deliveryArtifactIds = [...preRequestDeliveryState.deliveryArtifactIds]
    runtimeState.deliveryArtifactSelectionArtifactIds = [
      ...preRequestDeliveryState.deliveryArtifactSelectionArtifactIds,
    ]
    runtimeState.deliveryArtifactSelectionExplicit = preRequestDeliveryState.deliveryArtifactSelectionExplicit
    runtimeState.deliverableSelectionRetries = preRequestDeliveryState.deliverableSelectionRetries
  }

  const modelRequest = async (request) => {
    assertEmptyRequest(request)
    if (phase === 'in_flight') {
      throw brokerError(
        CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.BUSY,
        'Canonical Harness model request is already in flight',
      )
    }
    if (phase !== 'idle') {
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
      if (activeRequestToken !== requestToken
        || requestToken.revoked
        || abortScope.signal.aborted) {
        requestToken.revoked = true
        throw requestToken.error
      }
    }

    phase = 'in_flight'
    activeRequestToken = requestToken
    requestAbortScope = abortScope
    pendingRequest = (async () => {
      // Canonical adapters receive one host-owned model response. Resolve a
      // safe deliverable fallback before that request so the final answer can
      // review the exact selection that will be returned to the user.
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
          preRequestDeliveryState = deliveryState
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
      // Keep the completed invocation in this checkpoint. It is the replay
      // fence when the adapter crashes after the provider response arrives.
      responseCheckpointPending = true
      try {
        await runtimeState.persistTurn({ boundary: 'harness-model-response' })
      } finally {
        responseCheckpointPending = false
      }
      assertRequestActive()
      const response = publicModelResult(tracked.response)
      committedResponseText = response.content
      committedAnswerReviewDigest = answerReviewDigest
      return response
    })()

    try {
      const response = await pendingRequest
      assertRequestActive()
      if (phase === 'in_flight') phase = 'response_committed'
      return response
    } catch (error) {
      // A failed attempt is still consumed. In particular, an unresolved
      // provider outcome must never be converted into a successful terminal
      // result merely because an adapter catches the public broker error.
      if (phase === 'in_flight') phase = 'request_failed'
      throw error
    } finally {
      if (activeRequestToken === requestToken && phase !== 'aborting') {
        activeRequestToken = null
        requestAbortScope = null
      }
      if (phase !== 'aborting') abortScope.dispose()
    }
  }

  const finalize = async (result) => {
    if (phase === 'in_flight') {
      throw brokerError(
        CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.BUSY,
        'Canonical Harness model request must settle before finalization',
      )
    }
    if (phase === 'finalized' || phase === 'aborted' || phase === 'finalizing') {
      throw brokerError(
        CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
        'Canonical Harness broker lifecycle is already closed',
      )
    }
    if (phase !== 'response_committed') {
      throw brokerError(
        CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
        'Canonical Harness model response must commit before finalization',
      )
    }
    const adapterText = ownText(result)
    const previousPhase = phase
    const previousModelInvocation = runtimeState.modelInvocation
    const previousRestoredModelInvocation = runtimeState.restoredModelInvocation
    const previousConversationLength = runtimeState.convo.length
    const previousFinalText = runtimeState.finalText
    const previousFinalCheckpointPersisted = runtimeState.finalCheckpointPersisted
    const previousFinalLocalHtmlDeliveryFailure = runtimeState.finalLocalHtmlDeliveryFailure
    const previousLocalHtmlDeliveryRetries = runtimeState.localHtmlDeliveryRetries
    const previousLocalHtmlDeliveryValidationPending = runtimeState.localHtmlDeliveryValidationPending
    const previousDeliveryArtifactIds = [...runtimeState.deliveryArtifactIds]
    const previousDeliveryArtifactSelectionArtifactIds = [
      ...runtimeState.deliveryArtifactSelectionArtifactIds,
    ]
    const previousDeliveryArtifactSelectionExplicit = runtimeState.deliveryArtifactSelectionExplicit
    const previousDeliverableSelectionRetries = runtimeState.deliverableSelectionRetries
    let finalCheckpointPersisted = false
    phase = 'finalizing'
    try {
      const blocked = await finishUnsatisfiedTerminalGate(runtimeState)
      if (blocked) {
        if (blocked.deferredForSteering === true) {
          throw brokerError(
            CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.LIFECYCLE_INVALID,
            'Canonical Harness finalization was deferred by the host',
          )
        }
        finalCheckpointPersisted = runtimeState.finalCheckpointPersisted === true
        phase = 'finalized'
        return publicFinalResult(blocked)
      }

      if (runtimeState.requiresFinalAnswerEvidenceReview()
        && (!committedAnswerReviewDigest
          || !runtimeState.hasCurrentFinalAnswerEvidenceReview(committedAnswerReviewDigest))) {
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
        finalCheckpointPersisted = runtimeState.finalCheckpointPersisted === true
        phase = 'finalized'
        return publicFinalResult(incomplete)
      }

      // Contract v3 keeps its historical conversational projection: an
      // adapter may compose the broker response when there is no host evidence
      // contract to protect. Once execution or deliverable evidence exists,
      // only the digest-bound Provider response may become terminal; adapter
      // text has not itself passed that review and cannot strengthen claims.
      const terminalCandidate = runtimeState.requiresFinalAnswerEvidenceReview()
        ? committedResponseText
        : adapterText
      const protectedText = protectTerminalCandidate(runtimeState, terminalCandidate)
      const emptyModelResponse = !protectedText.trim()
      const terminalText = emptyModelResponse
        ? protectTerminalCandidate(runtimeState, EMPTY_MODEL_RESPONSE_TEXT, { incomplete: true })
        : protectedText
      const terminalReceipt = {
        text: terminalText,
        iterations: Math.max(1, Number(runtimeState.iter) + 1 || 1),
        incomplete: emptyModelResponse,
        reason: emptyModelResponse ? EMPTY_MODEL_RESPONSE_REASON : null,
      }
      // Completion gates can persist a deferred candidate. Keep the completed
      // model invocation installed until the gate has closed so every such
      // checkpoint still carries the replay fence.
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

      // This is the second phase of the model-response commit: clear the
      // completed invocation only in the same snapshot that makes the final
      // assistant text terminal. Any failed flush restores both in-memory
      // fields before the outer adapter path can persist an abort checkpoint.
      runtimeState.modelInvocation = null
      runtimeState.restoredModelInvocation = null
      await runtimeState.persistTurn({
        boundary: 'harness-model-final',
        final: {
          ...terminalReceipt,
          harnessAdapter: true,
        },
      })
      finalCheckpointPersisted = true
      runtimeState.finalCheckpointPersisted = true
      phase = 'finalized'
      const deliverySelection = runtimeState.deliverySelectionFields()
      const terminal = publicFinalResult({
        ...terminalReceipt,
        artifactIds: runtimeState.artifactIds,
        deliveryArtifactIds: deliverySelection.deliveryArtifactIds,
      })
      await runtimeState.emitTurnStopping(terminal)
      return terminal
    } catch (error) {
      if (!finalCheckpointPersisted && runtimeState.finalCheckpointPersisted !== true) {
        runtimeState.modelInvocation = previousModelInvocation
        runtimeState.restoredModelInvocation = previousRestoredModelInvocation
        runtimeState.convo.splice(previousConversationLength)
        runtimeState.finalText = previousFinalText
        runtimeState.finalCheckpointPersisted = previousFinalCheckpointPersisted
        runtimeState.finalLocalHtmlDeliveryFailure = previousFinalLocalHtmlDeliveryFailure
        runtimeState.localHtmlDeliveryRetries = previousLocalHtmlDeliveryRetries
        runtimeState.localHtmlDeliveryValidationPending = previousLocalHtmlDeliveryValidationPending
        if (preRequestDeliveryState) {
          restorePreRequestDeliveryState()
        } else {
          runtimeState.deliveryArtifactIds = previousDeliveryArtifactIds
          runtimeState.deliveryArtifactSelectionArtifactIds = previousDeliveryArtifactSelectionArtifactIds
          runtimeState.deliveryArtifactSelectionExplicit = previousDeliveryArtifactSelectionExplicit
          runtimeState.deliverableSelectionRetries = previousDeliverableSelectionRetries
        }
        phase = previousPhase
      } else {
        // A host terminal result is authoritative once its final checkpoint is
        // durable. A failing turn-stopping observer must not reopen the broker
        // and let the adapter's cleanup path overwrite it with an abort.
        phase = 'finalized'
      }
      throw error
    }
  }

  const abort = () => {
    if (phase === 'finalized' || phase === 'aborted') return
    if (abortPromise) return abortPromise
    if (phase === 'finalizing') {
      return Promise.reject(brokerError(
        CANONICAL_HARNESS_MODEL_BROKER_ERROR_CODES.BUSY,
        'Canonical Harness broker is finalizing',
      ))
    }
    abortPromise = (async () => {
      phase = 'aborting'
      const requestToken = activeRequestToken
      if (requestToken) {
        requestToken.revoked = true
        requestAbortScope?.abort(requestToken.error)
      }
      let pendingRequestSettled = true
      const repairLateResponseCheckpoint = Boolean(responseCheckpointPending)
      if (pendingRequest && requestToken) {
        pendingRequestSettled = await waitForSettlement(
          pendingRequest,
          CANONICAL_HARNESS_ABORT_GRACE_MS,
        )
      }
      requestAbortScope?.dispose()
      restorePreRequestDeliveryState()
      await runtimeState.persistTurn({ boundary: 'harness-adapter-aborted' })
      phase = 'aborted'
      if (!pendingRequestSettled && repairLateResponseCheckpoint) {
        // Some embedded checkpoint stores cannot cancel an in-flight write.
        // Reassert the terminal abort after that stale write settles. Durable
        // built-in stores additionally reject it through their monotonic CAS.
        void Promise.resolve(pendingRequest)
          .catch(() => undefined)
          .then(async () => {
            if (phase === 'aborted') {
              await runtimeState.persistTurn({ boundary: 'harness-adapter-aborted' })
            }
          })
          .catch(() => undefined)
      }
    })()
    return abortPromise
  }

  return Object.freeze({ modelRequest, finalize, abort })
}
