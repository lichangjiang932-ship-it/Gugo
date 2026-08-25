import { TurnEngineError } from './turnResolutionRuntime.js'

const PERMANENT_REJECTION_CODES = new Set([
  'TURN_FAILED_RETRY_UNSUPPORTED',
  'TURN_FAILED_RETRY_CHECKPOINT_REQUIRED',
  'TURN_FAILED_RETRY_CHECKPOINT_CONFLICT',
  'TURN_FAILED_RETRY_EVENT_INVALID',
  'TURN_FAILED_RETRY_ATTEMPT_INVALID',
  'TURN_FAILED_RETRY_PROJECTION_INVALID',
])

const REJECTION_MESSAGES = Object.freeze({
  TURN_FAILED_RETRY_UNSUPPORTED: '当前存储后端不支持安全的断点续写。为避免重复执行，本任务已停止续写；请发送新消息重新开始。',
  TURN_FAILED_RETRY_CHECKPOINT_REQUIRED: '无法继续此任务：恢复所需的执行检查点不存在或已失效。为避免重复执行，本任务已停止续写；请发送新消息重新开始。',
  TURN_FAILED_RETRY_CHECKPOINT_CONFLICT: '无法继续此任务：执行检查点已发生变化，不能安全恢复。为避免重复执行，本任务已停止续写；请发送新消息重新开始。',
  TURN_FAILED_RETRY_EVENT_INVALID: '无法继续此任务：持久化的续写元数据无效。为避免重复执行，本任务已停止续写；请发送新消息重新开始。',
  TURN_FAILED_RETRY_ATTEMPT_INVALID: '无法继续此任务：续写次数状态无效。为避免重复执行，本任务已停止续写；请发送新消息重新开始。',
  TURN_FAILED_RETRY_PROJECTION_INVALID: '无法继续此任务：续写消息状态无效。为避免重复执行，本任务已停止续写；请发送新消息重新开始。',
})

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isPermanentFailedRetryRejectionCode(value) {
  return PERMANENT_REJECTION_CODES.has(String(value || '').trim())
}

export function failedRetryRejectionFromMessage(message, failureEvent) {
  const context = isRecord(message?.modelContext) ? message.modelContext : null
  const rejection = isRecord(context?.failedRetryRejection)
    ? context.failedRetryRejection
    : null
  const failure = isRecord(context?.error) ? context.error : null
  if (message?.id !== `${failureEvent?.turnId}:assistant`
    || context?.turnEvidence !== true
    || context?.evidenceState !== 'failed'
    || context?.serverLastSequence !== failureEvent?.sequence
    || rejection?.failureSequence !== failureEvent?.sequence
    || rejection?.code !== failure?.code
    || failure?.retryable !== false) return null
  return failure
}

export function failedRetryRejectionEvidenceMessage({
  existing,
  userId,
  sessionId,
  turnId,
  failureEvent,
  error,
  writtenAt,
}) {
  const modelContext = isRecord(existing?.modelContext) ? { ...existing.modelContext } : {}
  const failure = {
    code: String(error?.code || 'TURN_FAILED_RETRY_NOT_ALLOWED'),
    message: String(error?.message || 'This failed Turn cannot be safely retried.'),
    retryable: false,
    ...(error?.hint ? { hint: String(error.hint) } : {}),
  }
  return {
    id: `${turnId}:assistant`,
    userId,
    sessionId,
    role: 'assistant',
    content: String(
      existing?.content
      || failureEvent?.payload?.partialText
      || failureEvent?.payload?.text
      || '',
    ),
    modelContext: {
      ...modelContext,
      turnId,
      turnEvidence: true,
      evidenceState: 'failed',
      serverLastSequence: failureEvent.sequence,
      error: failure,
      failedRetryRejection: {
        code: failure.code,
        failureSequence: failureEvent.sequence,
      },
    },
    createdAt: Number.isFinite(Number(existing?.createdAt))
      ? Number(existing.createdAt)
      : failureEvent.createdAt,
    updatedAt: writtenAt,
  }
}

export function permanentFailedRetryError(error) {
  const code = String(error?.code || 'TURN_FAILED_RETRY_NOT_ALLOWED').trim()
  const wrapped = new TurnEngineError(
    code,
    REJECTION_MESSAGES[code]
      || '无法安全继续此任务。为避免重复执行，本任务已停止续写；请发送新消息重新开始。',
    Number.isInteger(error?.status) ? error.status : 409,
  )
  wrapped.retryable = false
  wrapped.hint = '原任务的已完成结果会保留；请在新消息中说明仍需完成的部分。'
  return wrapped
}
