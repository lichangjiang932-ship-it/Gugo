import { approvalErrorKey } from './approvalErrorPresentation.js'
const unknown = () => ({ state: 'unknown', outcome: 'unconfirmed', messageKey: 'toolApproval.decisionUnknown' })
const resolved = new Set(['approved', 'denied', 'edited'])

/** Presentation only. A decision receipt never proves tool execution or grants permission. */
export function decisionReceiptNotice(result, request, owner) {
  const approval = result?.approval
  if (typeof request?.id !== 'string' || !request.id.trim() || !approval || approval.id !== request.id
    || (approval.sessionId && approval.sessionId !== owner?.sessionId)
    || (approval.turnId && approval.turnId !== owner?.turnId)
    || (approval.toolName && request.name && approval.toolName !== request.name)
    || !(result.ok === true || (result.ok === false && result.alreadyDecided === true))) return unknown()
  if (['expired', 'cancelled'].includes(approval.status)) return {
    state: 'error', outcome: approval.status, messageKey: 'toolApproval.decision' + (approval.status === 'expired' ? 'Expired' : 'Cancelled'),
  }
  if (!resolved.has(approval.status)) return unknown()
  const already = result.alreadyDecided === true
  const key = approval.status[0].toUpperCase() + approval.status.slice(1)
  return { state: 'resolved', outcome: (already ? 'already-' : '') + approval.status,
    messageKey: 'toolApproval.decision' + (already ? 'Already' : '') + key }
}
export function decisionFailureNotice(error) {
  const definitive = [400, 401, 403, 404, 409, 410, 422].includes(Number(error?.status))
  return { state: definitive ? 'error' : 'unknown', outcome: 'unconfirmed', messageKey: approvalErrorKey(error) }
}
