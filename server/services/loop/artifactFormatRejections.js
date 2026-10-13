import { classifyGeneratedArtifactFormatCode } from '../generatedArtifactFormatValidationError.js'

/** Two refusals of the same artifact by the same policy is not a coincidence. */
const ARTIFACT_FORMAT_REJECTION_LIMIT = 2

/**
 * A format refusal that regenerating cannot clear, and the artifact it names.
 *
 * `ARTIFACT_FORMAT_ACTIVE_CONTENT_FORBIDDEN` says the artifact safety policy
 * refused a part — not that the bytes are malformed — so generating the same
 * kind of file again is refused again. A model is free to keep trying, and does:
 * one real turn spent twenty-four calls and five minutes on a document
 * background the allow-list will never accept. Repeating commands is what the
 * existing no-progress guard looks for, and every one of those commands was
 * different, so nothing noticed.
 */
function policyBlockedArtifactRejection(result) {
  if (!result || typeof result !== 'object') return null
  const code = String(result.formatValidationCode || result.code || '').trim()
  if (!code || !classifyGeneratedArtifactFormatCode(code).policyBlocked) return null
  const target = String(result.path || result.filePath || result.filename || result.artifactId || '').trim()
  return { code, target: target.replace(/\\/gu, '/').toLowerCase() }
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
export function trackPolicyBlockedArtifactRejection(state, result) {
  const rejection = policyBlockedArtifactRejection(result)
  if (!rejection) return null
  const rejections = state.artifactFormatRejections
    || (state.artifactFormatRejections = new Map())
  const key = `${rejection.target}::${rejection.code}`
  const seen = (rejections.get(key) || 0) + 1
  rejections.set(key, seen)
  return seen >= ARTIFACT_FORMAT_REJECTION_LIMIT ? rejection : null
}
