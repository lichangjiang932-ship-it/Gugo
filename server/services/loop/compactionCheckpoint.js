import { fingerprintModelRequest, restoreModelInvocationCheckpoint, snapshotModelResponse } from './modelInvocationCheckpoint.js'
import { applyRollingToolResultBudget } from '../contextCompactionMetrics.js'
import { withCanonicalContext } from '../contextCompactionState.js'

const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024
const MAX_CACHED_SUMMARIES = 96
const FINGERPRINT = /^[a-f0-9]{64}$/u

function invalid() {
  throw Object.assign(new Error('The context-compaction checkpoint is invalid or has drifted'), {
    code: 'MODEL_REQUEST_CONTEXT_DRIFT', retryable: false, unsafeToReplay: true,
  })
}

function clone(value) {
  let encoded
  try { encoded = JSON.stringify(value) } catch { invalid() }
  if (!encoded || Buffer.byteLength(encoded) > MAX_CHECKPOINT_BYTES) invalid()
  return JSON.parse(encoded)
}

function freshState() {
  return { version: 1, fingerprint: null, attempt: 0, recipes: [], responses: [], modelInvocation: null, restoredModelInvocation: null }
}

export function restoreCompactionCheckpoint(value, binding = {}) {
  if (value == null) return freshState()
  const state = clone(value)
  if (state.version !== 1 || !FINGERPRINT.test(state.fingerprint || '')
    || !Number.isSafeInteger(state.attempt) || state.attempt < 0 || state.attempt > 2
    || !Array.isArray(state.recipes) || state.recipes.length > 3
    || !Array.isArray(state.responses) || state.responses.length > MAX_CACHED_SUMMARIES) invalid()
  for (const entry of state.responses) {
    if (!FINGERPRINT.test(entry?.fingerprint || '') || !entry.response || typeof entry.response.content !== 'string') invalid()
  }
  for (const recipe of state.recipes) {
    if (recipe == null) continue
    if (!recipe.meta || typeof recipe.meta.compacted !== 'boolean') invalid()
    if (recipe.meta.compacted && (!Number.isSafeInteger(recipe.meta.replacedMessageCount)
      || recipe.meta.replacedMessageCount < 1 || recipe.summary?.meta?.compaction !== true
      || typeof recipe.summary.content !== 'string')) invalid()
  }
  state.modelInvocation = restoreModelInvocationCheckpoint(state.modelInvocation, binding)
  state.restoredModelInvocation = state.modelInvocation
  return state
}

export function snapshotCompactionCheckpoint(state) {
  if (!state?.fingerprint) return null
  const snapshot = { ...state }
  delete snapshot.restoredModelInvocation
  return clone(snapshot)
}

export function compactionRequestFingerprint(s, request) {
  return fingerprintModelRequest(request, {
    jobId: s.job?.id, stepId: s.step?.id, iteration: s.iter,
    modelName: s.job?.modelName, modelProviderId: s.job?.modelProviderId, modelConfigRevision: s.job?.modelConfigRevision,
  })
}

export function cachedCompactionResponse(s, request) {
  const key = compactionRequestFingerprint(s, request)
  const entry = s.compactionCheckpoint.responses.find((candidate) => candidate.fingerprint === key)
  return entry ? clone(entry.response) : null
}

export async function cacheCompactionResponse(s, request, response) {
  const state = s.compactionCheckpoint
  const fingerprint = compactionRequestFingerprint(s, request)
  const snapshot = snapshotModelResponse(response)
  // These outputs become untrusted evidence in a new request, never provider
  // transcript history. Opaque signatures are unnecessary in this small cache.
  delete snapshot.providerReplay
  state.responses = [...state.responses.filter((entry) => entry.fingerprint !== fingerprint), { fingerprint, response: snapshot }]
  if (state.responses.length > MAX_CACHED_SUMMARIES) invalid()
  state.modelInvocation = null
  state.restoredModelInvocation = null
  await s.persistTurn({ boundary: 'context-summary-response' })
}

/** A separate invocation slot prevents summary responses being replayed as answers. */
export function compactionInvocationState(s) {
  return Object.create(s, {
    modelInvocation: { get: () => s.compactionCheckpoint.modelInvocation, set: (value) => { s.compactionCheckpoint.modelInvocation = value } },
    restoredModelInvocation: { get: () => s.compactionCheckpoint.restoredModelInvocation, set: (value) => { s.compactionCheckpoint.restoredModelInvocation = value } },
  })
}

export function assertCompactionRequestSettled(s) {
  const invocation = s.compactionCheckpoint?.modelInvocation
  if (invocation?.status !== 'in_flight') return
  throw Object.assign(new Error('The summary request may still have been accepted by its provider. Reconcile that request before continuing; it was not repeated.'), {
    code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', retryable: false, unsafeToReplay: true,
    modelRequestId: invocation.id, requestFingerprint: invocation.fingerprint,
  })
}

export function assertMainRequestSettled(s) {
  const invocation = s.modelInvocation
  if (invocation?.status !== 'in_flight') return
  throw Object.assign(new Error('The main request may still have been accepted by its provider. Reconcile it before starting a summary; neither request was repeated.'), {
    code: 'MODEL_REQUEST_OUTCOME_UNKNOWN', retryable: false, unsafeToReplay: true,
    modelRequestId: invocation.id, requestFingerprint: invocation.fingerprint,
  })
}

function needsRecoveredRequest(invocation, iteration) {
  return invocation && invocation.status !== 'failed'
    && (invocation.iteration >= iteration || invocation.status === 'in_flight'
      || (invocation.status === 'completed' && invocation.usageApplied === false))
}

export function createCompactionRecoveryCheckpoint(s) {
  const invalidated = new Set()
  return {
    begin(input) {
      if (!s.restoredModelInvocation) assertMainRequestSettled(s)
      // An old unknown slot (or unconsumed manual usage) cannot be discarded
      // merely because a later iteration was persisted beside it.
      if (needsRecoveredRequest(s.restoredModelInvocation, s.iter)
        && s.restoredModelInvocation.iteration !== s.iter) invalid()
      const fingerprint = compactionRequestFingerprint(s, { messages: input.messages, tools: input.tools, parameters: {
        contextWindow: input.contextWindow, activeContextTokens: input.activeContextTokens, semanticSummary: input.semanticSummary,
      } })
      if (s.compactionCheckpoint.fingerprint && s.compactionCheckpoint.fingerprint !== fingerprint) {
        // A known failed live request may be superseded by fresh steering or a
        // bounded wrap-up. Restored/unknown requests still require exact input.
        if (needsRecoveredRequest(s.restoredModelInvocation, s.iter)
          || needsRecoveredRequest(s.compactionCheckpoint.restoredModelInvocation, s.iter)
          || s.modelInvocation?.status === 'in_flight' || s.compactionCheckpoint.modelInvocation?.status === 'in_flight') invalid()
        s.compactionCheckpoint = freshState()
      }
      s.compactionCheckpoint.fingerprint = fingerprint
      return s.compactionCheckpoint.attempt
    },
    preparationOptions() {
      if (!needsRecoveredRequest(s.restoredModelInvocation, s.iter)
        && s.modelInvocation?.status !== 'in_flight') return {}
      // Legacy checkpoints have no prepared recipe. Reconstruct only a local,
      // mechanical candidate, then let the existing main-request fingerprint
      // fence prove it before replay/reconciliation. New summaries or archive
      // IDs cannot reconstruct the original request and must not be created.
      return { semanticSummary: false, userId: null, sessionId: null }
    },
    enterAttempt(attempt) {
      if (s.compactionCheckpoint.attempt !== attempt) {
        if (s.modelInvocation?.status === 'in_flight') invalid()
        s.modelInvocation = null
        s.restoredModelInvocation = null
      }
      s.compactionCheckpoint.attempt = attempt
    },
    restorePrepared(attempt, source, options) {
      const recipe = s.compactionCheckpoint.recipes[attempt]
      if (!recipe) return null
      if (attempt === s.compactionCheckpoint.attempt
        && ['completed', 'not_sent'].includes(s.compactionCheckpoint.restoredModelInvocation?.status)) {
        // A timeout may have produced a mechanical recipe before its unknown
        // summary was manually reconciled. Consume that response in its own
        // stage, including usage, before deciding the final summary again.
        invalidated.add(attempt)
        return null
      }
      const full = recipe.meta.compacted
        ? [...source.filter((message) => message.role === 'system'), recipe.summary,
          ...source.filter((message) => message.role !== 'system').slice(recipe.meta.replacedMessageCount)]
        : source
      const messages = applyRollingToolResultBudget(full, options).messages
      return withCanonicalContext({ ...recipe.meta, messages }, recipe.meta.archivePersisted ? full : source)
    },
    priorArchive(attempt) {
      const meta = s.compactionCheckpoint.recipes[attempt]?.meta
      return meta?.archiveId ? { id: meta.archiveId, source: meta.compactCheckpointSource } : null
    },
    async savePrepared(attempt, prepared) {
      if (s.compactionCheckpoint.recipes[attempt] && !invalidated.has(attempt)) return
      const { messages, ...meta } = prepared
      const summary = prepared.compacted ? messages.find((message) => message?.meta?.compactCheckpointSource?.sha256 === prepared.compactCheckpointSource?.sha256) : null
      if (prepared.compacted && !summary) invalid()
      s.compactionCheckpoint.recipes[attempt] = { meta, ...(summary ? { summary } : {}) }
      // Ordinary short requests already persist this tiny recipe at the model
      // write-ahead fence; only real compaction needs an additional boundary.
      if (prepared.compacted || prepared.attemptedCompaction) await s.persistTurn({ boundary: 'context-compaction-prepared' })
    },
  }
}
