import { normalizePublicModelRequestDiagnostics as normalizeModelRequestDiagnostics } from '../../shared/turnEventProjection.js'

export { normalizeModelRequestDiagnostics }

const PHASES = new Set(['request', 'response', 'first_token', 'idle', 'background'])
const DISCONNECT_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'])

export function modelRequestFailureCopy(failure, t) {
  const diagnostic = normalizeModelRequestDiagnostics(failure?.modelRequestDiagnostics)
  let title = t('chatMessages.modelRequestUnknownTitle')
  let reason = t('chatMessages.modelRequestUnknownBody')
  if (PHASES.has(diagnostic?.timeoutPhase) && diagnostic.timeoutMs > 0) {
    title = t('modelRequestRecovery.timeoutTitle')
    reason = t(diagnostic.timeoutPhase === 'first_token'
      ? 'modelRequestRecovery.firstOutputTimeout' : 'modelRequestRecovery.outputIdleTimeout',
    { seconds: Math.ceil(diagnostic.timeoutMs / 1000) })
  } else if (diagnostic?.upstreamStatus >= 400) {
    title = t('modelRequestRecovery.connectionTitle')
    reason = t('modelRequestRecovery.upstreamHttpError', { status: diagnostic.upstreamStatus })
  } else if (DISCONNECT_CODES.has(diagnostic?.upstreamCode)) {
    title = t('modelRequestRecovery.connectionTitle')
    reason = t('modelRequestRecovery.connectionInterrupted')
  } else if (['MODEL_STREAM_TRUNCATED', 'MODEL_STREAM_MALFORMED_FRAME'].includes(diagnostic?.upstreamCode)) {
    title = t('modelRequestRecovery.connectionTitle')
    reason = t('modelRequestRecovery.incompleteStream')
  }
  const retained = diagnostic?.contentRetained ? t('modelRequestRecovery.partialTextRetained') : ''
  return { title, reason, detail: [reason, retained].filter(Boolean).join(' ') }
}
