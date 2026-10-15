import { classifyGeneratedArtifactFormatCode } from '../generatedArtifactFormatValidationError.js'

const CHECKPOINT_VERSION = 1

function invalidCheckpoint() {
  return Object.assign(new Error('Artifact policy checkpoint is invalid or unsupported'), {
    code: 'ARTIFACT_POLICY_CHECKPOINT_INVALID', retryable: false,
  })
}

export function restoreArtifactFormatRejections(snapshot) {
  if (snapshot == null) return new Map()
  if (snapshot.version !== CHECKPOINT_VERSION || !Array.isArray(snapshot.entries)) throw invalidCheckpoint()
  const result = new Map()
  for (const entry of snapshot.entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw invalidCheckpoint()
    const [key, value] = entry
    const split = typeof key === 'string' ? key.lastIndexOf('::') : -1
    if (split <= 0 || !classifyGeneratedArtifactFormatCode(key.slice(split + 2)).policyBlocked
      || result.has(key) || !Number.isInteger(value?.count) || value.count < 1
      || value.count > ARTIFACT_FORMAT_REJECTION_LIMIT || !Array.isArray(value.callIds)
      || value.callIds.length > value.count
      || value.callIds.some((id) => typeof id !== 'string' || !id)
      || new Set(value.callIds).size !== value.callIds.length) throw invalidCheckpoint()
    result.set(key, { count: value.count, callIds: new Set(value.callIds) })
  }
  return result
}

export function serializeArtifactFormatRejections(rejections) {
  return { version: CHECKPOINT_VERSION, entries: [...(rejections || [])]
    .map(([key, entry]) => [key, { count: entry.count, callIds: [...entry.callIds] }]) }
}

/** Two refusals of the same artifact by the same policy is not a coincidence. */
const ARTIFACT_FORMAT_REJECTION_LIMIT = 2

/**
 * A format refusal that regenerating cannot clear, and the artifact it names.
 *
 * `ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN` says an output part was refused
 * by policy rather than malformed. Repeated attempts at that output need a
 * bounded stop; source-document reads are not attempts. A model can keep trying:
 * one real turn spent twenty-four calls and five minutes on a document
 * background the allow-list will never accept. Repeating commands is what the
 * existing no-progress guard looks for, and every one of those commands was
 * different, so nothing noticed.
 */
function policyBlockedArtifactRejection(result, call) {
  if (!result || typeof result !== 'object') return null
  const code = String(result.formatValidationCode || result.code || '').trim().toUpperCase()
  if (!code || !classifyGeneratedArtifactFormatCode(code).policyBlocked) return null
  const target = String(result.path || result.filePath || result.filename || result.artifactId
    || call?.args?.filename || call?.args?.path || '').trim()
  return target ? { code, target } : null
}

/**
 * Count this outcome's refusal and say whether the artifact has now been refused
 * often enough to stop.
 *
 * The count is kept on the turn state rather than on the iteration because the
 * iteration is reset before every round — which is the boundary it has to
 * survive. A model chasing an artifact it cannot finish succeeds at something on
 * nearly every round, and the batch guard clears on any success at all, so the
 * turn has to remember this for itself.
 */
export function trackPolicyBlockedArtifactRejection(state, result, call) {
  if (!state.requiresPersistedArtifact && !state.mutationExecutionRequested) return null
  const rejection = policyBlockedArtifactRejection(result, call)
  if (!rejection) return null
  // A source read may carry output-validation warnings without being an output.
  // Only a requested generator or a path with actual mutation debt is a delivery attempt.
  const generator = state.expectedArtifactTools?.has(call?.name) === true
  const changedOutput = [...(state.pendingMutationTargets || [])].some((target) => (
    state.d.targetsMatch(target, rejection.target, state.executionScope)
  ))
  if (!generator && !changedOutput) return null
  const rejections = state.artifactFormatRejections
    || (state.artifactFormatRejections = new Map())
  const normalized = state.d.normalizeMutationTarget(rejection.target)
  if (!normalized) return null
  const targetKey = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  const key = `${targetKey}::${rejection.code}`
  const entry = rejections.get(key) || { count: 0, callIds: new Set() }
  const callId = String(call?.id || '').trim()
  if (!callId || !entry.callIds.has(callId)) {
    entry.count = Math.min(ARTIFACT_FORMAT_REJECTION_LIMIT, entry.count + 1)
    if (callId && entry.callIds.size < ARTIFACT_FORMAT_REJECTION_LIMIT) entry.callIds.add(callId)
    rejections.set(key, entry)
  }
  return entry.count >= ARTIFACT_FORMAT_REJECTION_LIMIT ? rejection : null
}
