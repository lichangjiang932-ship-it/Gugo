/**
 * Declarative completion-policy definitions for the bundled loop kernel.
 *
 * The loop keeps completion/repair attempts in `completionGuards` on the turn
 * checkpoint. Historically each counter was an ad-hoc pair of threshold and
 * increment sites, which made the limits hard to audit and easy to drift. This
 * module is the single read-only definition: policy id, the checkpoint state
 * key, the attempt limit, what resets it, and what exhaustion means.
 *
 * It intentionally separates the definition from the runtime state so tests can
 * pin the current behavior before any migration changes increment timing.
 * `describeCompletionPolicies` is a pure projection used for diagnostics; it
 * never mutates loop state.
 */
import {
  MAX_ARTIFACT_DELIVERY_RETRIES,
  MAX_DIRECTORY_RESUME_RETRIES,
  MAX_DELIVERABLE_SELECTION_RETRIES,
  MAX_EXECUTION_EVIDENCE_RETRIES,
  MAX_LOCAL_HTML_DELIVERY_RETRIES,
  MAX_MUTATION_VERIFICATION_RETRIES,
  MAX_PDF_LAYOUT_VERIFICATION_RETRIES,
  MAX_SOURCE_HANDOFF_RETRIES,
} from './heuristics/constants.js'

export const COMPLETION_POLICY_SCHEMA_VERSION = 1

/**
 * Version of the completion-policy sub-state inside `completionGuards`.
 * Version 0 is the implicit legacy shape: no `completionPolicyVersion` key and
 * one flat counter per policy. Missing fields in legacy data default to zero;
 * a newer version fails closed instead of silently resetting retry counts.
 */
export const COMPLETION_POLICY_VERSION = 1

/**
 * @typedef {object} CompletionPolicyDefinition
 * @property {string} id stable policy id
 * @property {string|null} stateKey persisted completionGuards field, or null for a compatibility-only field
 * @property {number|null} limit attempt limit, or null when the field has no active threshold
 * @property {boolean} active whether the strategy still enforces a limit
 * @property {boolean} [monotonic] true when the count never resets within the turn
 * @property {string} scope what the strategy guards
 * @property {string} resetOn the event that clears the attempt count
 * @property {string} onExhausted terminal behavior once the limit is reached
 */

/** @type {ReadonlyArray<CompletionPolicyDefinition>} */
export const COMPLETION_POLICIES = Object.freeze([
  Object.freeze({
    id: 'artifact_delivery',
    stateKey: 'artifactDeliveryRetries',
    limit: MAX_ARTIFACT_DELIVERY_RETRIES,
    active: true,
    scope: 'a required persisted artifact has not been delivered yet',
    resetOn: 'a verified required artifact is delivered, steering arrives, or the delivery contract becomes satisfiable',
    onExhausted: 'incomplete terminal with artifact_delivery_not_converged',
  }),
  Object.freeze({
    id: 'execution_evidence',
    stateKey: 'executionEvidenceRetries',
    limit: MAX_EXECUTION_EVIDENCE_RETRIES,
    active: true,
    scope: 'a claimed local mutation has no concrete execution evidence',
    monotonic: true,
    resetOn: 'never within the turn; one repair attempt is allowed and the count is monotonic',
    onExhausted: 'incomplete terminal with execution_evidence_missing',
  }),
  Object.freeze({
    id: 'directory_resume',
    stateKey: 'directoryResumeRetries',
    limit: MAX_DIRECTORY_RESUME_RETRIES,
    active: true,
    scope: 'the turn is waiting on a verified local directory authorization',
    monotonic: true,
    resetOn: 'never within the turn; bounded by MAX_DIRECTORY_RESUME_RETRIES across the whole turn',
    onExhausted: 'incomplete terminal until the directory is authorized',
  }),
  Object.freeze({
    id: 'mutation_verification',
    stateKey: 'mutationVerificationRetries',
    limit: MAX_MUTATION_VERIFICATION_RETRIES,
    active: true,
    scope: 'a local mutation has not been re-read and verified',
    resetOn: 'a verification call clears every pending mutation/deletion target',
    onExhausted: 'incomplete terminal with post_mutation_verification_missing',
  }),
  Object.freeze({
    id: 'pdf_layout_verification',
    stateKey: 'pdfLayoutVerificationRetries',
    limit: MAX_PDF_LAYOUT_VERIFICATION_RETRIES,
    active: true,
    scope: 'a generated PDF has not passed layout verification',
    resetOn: 'a successful PDF layout verification is observed',
    onExhausted: 'incomplete terminal with pdf_layout_verification_missing',
  }),
  Object.freeze({
    id: 'deliverable_selection',
    stateKey: 'deliverableSelectionRetries',
    limit: MAX_DELIVERABLE_SELECTION_RETRIES,
    active: true,
    scope: 'the final deliverable set has not been selected',
    resetOn: 'a valid deliverable selection or safe fallback is applied',
    onExhausted: 'incomplete terminal with deliverable_selection_missing',
  }),
  Object.freeze({
    id: 'source_handoff',
    stateKey: 'sourceHandoffRetries',
    limit: MAX_SOURCE_HANDOFF_RETRIES,
    active: true,
    scope: 'terminal text would hand source code back instead of delivering the artifact',
    monotonic: true,
    resetOn: 'never within the turn; bounded by MAX_SOURCE_HANDOFF_RETRIES across the whole turn',
    onExhausted: 'terminal text is filtered to a concise blocker',
  }),
  Object.freeze({
    id: 'local_html_delivery',
    stateKey: 'localHtmlDeliveryRetries',
    limit: MAX_LOCAL_HTML_DELIVERY_RETRIES,
    active: true,
    scope: 'a local HTML delivery fails side-preview validation',
    resetOn: 'the HTML delivery validates, or the turn reaches a terminal state',
    onExhausted: 'incomplete terminal with local_html_delivery_validation_failed',
  }),
  Object.freeze({
    id: 'execution_reasoning',
    stateKey: 'executionReasoningRetries',
    limit: null,
    active: false,
    scope: 'legacy compatibility field kept readable across checkpoints',
    resetOn: 'not applicable; no active increment or threshold',
    onExhausted: 'not applicable',
  }),
])

export const COMPLETION_POLICY_IDS = Object.freeze(COMPLETION_POLICIES.map((policy) => policy.id))

const POLICY_BY_ID = Object.freeze(Object.fromEntries(
  COMPLETION_POLICIES.map((policy) => [policy.id, policy]),
))

const POLICY_BY_STATE_KEY = Object.freeze(Object.fromEntries(
  COMPLETION_POLICIES
    .filter((policy) => policy.stateKey)
    .map((policy) => [policy.stateKey, policy]),
))

export function completionPolicyById(id) {
  return POLICY_BY_ID[String(id || '')] || null
}

export function completionPolicyForStateKey(stateKey) {
  return POLICY_BY_STATE_KEY[String(stateKey || '')] || null
}

/** Persisted completionGuards keys owned by a completion policy. */
export function completionPolicyStateKeys() {
  return COMPLETION_POLICIES.map((policy) => policy.stateKey).filter(Boolean)
}

function readAttempts(state, stateKey) {
  if (!state || !stateKey) return 0
  const value = Number(state[stateKey])
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Pure, read-only diagnostic projection of completion state.
 * @param {Record<string, unknown>} [state] completionGuards-like object
 */
export function describeCompletionPolicies(state = {}) {
  return COMPLETION_POLICIES.map((policy) => {
    const attempts = readAttempts(state, policy.stateKey)
    const exhausted = policy.active && policy.limit != null && attempts >= policy.limit
    return Object.freeze({
      id: policy.id,
      stateKey: policy.stateKey,
      active: policy.active,
      limit: policy.limit,
      attempts,
      remaining: policy.limit == null ? null : Math.max(0, policy.limit - attempts),
      exhausted,
    })
  })
}

export function exhaustedCompletionPolicies(state = {}) {
  return describeCompletionPolicies(state)
    .filter((entry) => entry.exhausted)
    .map((entry) => entry.id)
}

/**
 * Bounded, wire-safe projection for terminal events. Only policies that were
 * actually exercised are reported, and the shape matches
 * `completionPoliciesSchema`. It carries diagnostics only, never authority.
 */
export function completionPolicyDiagnostics(state = {}) {
  return describeCompletionPolicies(state)
    .filter((entry) => entry.attempts > 0)
    .slice(0, 16)
    .map((entry) => Object.freeze({
      id: entry.id,
      attempts: entry.attempts,
      limit: entry.limit,
      exhausted: entry.exhausted,
    }))
}

function unsupportedCompletionPolicyVersion(version) {
  return Object.assign(
    new Error(`Unsupported completion policy version: ${String(version)}`),
    {
      code: 'COMPLETION_POLICY_VERSION_UNSUPPORTED',
      retryable: false,
      version: Number.isSafeInteger(version) ? version : null,
    },
  )
}

function normalizePersistedAttempts(raw) {
  const value = Number(raw)
  // Persisted counts are never clamped down: a stored attempt above the limit
  // must stay exhausted after restore instead of being silently reset.
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Convert any persisted `completionGuards` shape into one versioned state.
 * Legacy version-0 data is upgraded with explicit zero defaults; an unknown
 * future version throws `COMPLETION_POLICY_VERSION_UNSUPPORTED`.
 *
 * @param {Record<string, unknown>} [guards]
 */
export function restoreCompletionPolicyState(guards = {}) {
  const rawVersion = guards?.completionPolicyVersion
  const hasVersion = rawVersion !== undefined && rawVersion !== null && rawVersion !== ''
  const version = hasVersion ? Number(rawVersion) : 0
  if (hasVersion && (!Number.isSafeInteger(version) || version < 0)) {
    throw unsupportedCompletionPolicyVersion(rawVersion)
  }
  if (version > COMPLETION_POLICY_VERSION) throw unsupportedCompletionPolicyVersion(version)
  const counters = {}
  for (const policy of COMPLETION_POLICIES) {
    if (!policy.stateKey) continue
    counters[policy.stateKey] = normalizePersistedAttempts(guards?.[policy.stateKey])
  }
  return Object.freeze({
    version: COMPLETION_POLICY_VERSION,
    sourceVersion: version,
    legacy: !hasVersion,
    counters: Object.freeze(counters),
  })
}

/** Attempt count for a persisted completionGuards-like object. */
export function completionPolicyAttempts(guards, stateKey) {
  if (!stateKey) return 0
  return restoreCompletionPolicyState(guards).counters[stateKey] || 0
}
