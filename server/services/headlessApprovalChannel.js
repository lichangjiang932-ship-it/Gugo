/**
 * One headless approval, decided and attributed.
 *
 * Kept apart from the runtime so the approval ledger can be told the truth about
 * who decided. A run with no interactive terminal denies every
 * approval-requiring tool — that is fail-closed and correct — but it is not a
 * user decision, and recording it as one would put a human refusal in the audit
 * trail that never happened.
 */

/** Written to `pending_approvals.decided_by` when no channel could ask anyone. */
export const NO_APPROVAL_CHANNEL_DECIDED_BY = 'system:no-approval-channel'

const NO_APPROVAL_CHANNEL_HELP = 'Run in a terminal to approve, or use --mode acceptEdits '
  + 'or --mode bypass for unattended runs.'

export function normalizeApprovalDecision(value) {
  const decision = typeof value === 'string' ? value : value?.decision
  if (decision === 'approve' || decision === 'deny') return decision
  return 'deny'
}

/**
 * @returns {Promise<{decision: 'approve'|'deny', decidedBy: string}>}
 *   `decidedBy` is the user only when a terminal actually answered the prompt.
 */
export async function resolveHeadlessApprovalDecision({
  interactive = false,
  onApproval = null,
  onDiagnostic = () => {},
  event = null,
  approvalId = '',
  userId = '',
} = {}) {
  if (interactive && typeof onApproval === 'function') {
    try {
      return {
        decision: normalizeApprovalDecision(await onApproval(event)),
        decidedBy: userId,
      }
    } catch (error) {
      // A prompt that failed is also not a user answer, so the attribution stays
      // with the runtime and the operator is told why the call was denied.
      onDiagnostic(`approval prompt failed; denied ${approvalId}: ${error?.message || error}`)
      return { decision: 'deny', decidedBy: NO_APPROVAL_CHANNEL_DECIDED_BY }
    }
  }
  // Denying here is fail-closed, but it is not a user decision. Say so at the
  // moment it happens; the caller otherwise only sees `approval_denied` and
  // would keep retrying a decision it cannot make.
  const tool = String(event?.payload?.toolName || 'unknown')
  onDiagnostic(`no interactive approval channel; denied ${tool}. ${NO_APPROVAL_CHANNEL_HELP}`)
  return { decision: 'deny', decidedBy: NO_APPROVAL_CHANNEL_DECIDED_BY }
}
