import { normalizePublicModelRequestDiagnostics as normalizeModelRequestDiagnostics } from '../../shared/turnEventProjection.js'

export { normalizeModelRequestDiagnostics }

const PHASES = new Set(['request', 'response', 'first_token', 'idle', 'background'])
const DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'])

export function modelRequestFailureCopy(failure, t) {
  const diagnostic = normalizeModelRequestDiagnostics(failure?.modelRequestDiagnostics)
  let title = t('chatMessages.modelRequestUnknownTitle')
  let reason = t('chatMessages.modelRequestUnknownBody')
  // Whether the diagnostic named a cause. Falling through to the generic copy
  // above means it did not — the request was cut off without the transport
  // saying why, which is what a closed app or a dropped line looks like. Callers
  // use this to tell "we know what happened" from "we do not", which the reason
  // code alone cannot: that code is a bucket several causes land in.
  let specific = false
  if (PHASES.has(diagnostic?.timeoutPhase) && diagnostic.timeoutMs > 0) {
    specific = true
    title = t('modelRequestRecovery.timeoutTitle')
    reason = t(diagnostic.timeoutPhase === 'first_token'
      ? 'modelRequestRecovery.firstOutputTimeout' : 'modelRequestRecovery.outputIdleTimeout',
    { seconds: Math.ceil(diagnostic.timeoutMs / 1000) })
  } else if (diagnostic?.upstreamStatus >= 400) {
    specific = true
    title = t('modelRequestRecovery.connectionTitle')
    reason = t('modelRequestRecovery.upstreamHttpError', { status: diagnostic.upstreamStatus })
  } else if (DISCONNECT_CODES.has(diagnostic?.upstreamCode)) {
    specific = true
    title = t('modelRequestRecovery.connectionTitle')
    reason = t('modelRequestRecovery.connectionInterrupted')
  } else if (['MODEL_STREAM_TRUNCATED', 'MODEL_STREAM_MALFORMED_FRAME'].includes(diagnostic?.upstreamCode)) {
    specific = true
    title = t('modelRequestRecovery.connectionTitle')
    reason = t('modelRequestRecovery.incompleteStream')
  }
  const retained = diagnostic?.contentRetained ? t('modelRequestRecovery.partialTextRetained') : ''
  return { title, reason, specific, detail: [reason, retained].filter(Boolean).join(' ') }
}
