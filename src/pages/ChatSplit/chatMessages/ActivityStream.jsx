import { TOOL_CALL_STATUS } from '../../../store/taskStatus.js'
import { useT } from '../../../i18n/I18nProvider.jsx'
import { ReasoningTrace } from './ActivityTraces.jsx'

/**
 * 降级链路可视化:provider 重试 / 切换以一条 amber 文字行透出,
 * 让用户知道「模型没死,只是换了条路」,而不是只看到转圈。
 */
function fallbackNotice(meta, t) {
  const fb = meta?.modelFallback
  if (!fb) return null
  const retry = fb.kind === 'retry'
  return (
    <div className="chat-activity-line chat-activity-line-fallback" data-testid="model-fallback">
      <span className="chat-activity-mark chat-activity-mark-fallback" aria-hidden="true">{retry ? '\u21bb' : '\u21c4'}</span>
      <span className="chat-activity-label">{retry ? t('chatMessages.modelRetrying') : t('chatMessages.modelFailover')}</span>
      {retry && fb.attempt ? <span className="chat-activity-arg">({fb.attempt})</span> : null}
      {!retry && fb.to ? <span className="chat-activity-arg">{'\u2192'} {fb.to}</span> : null}
      {fb.modelName ? <span className="chat-activity-arg">({fb.modelName})</span> : null}
    </div>
  )
}

/**
 * 实时状态行 —— 每个阶段都有明确的文字状态,杜绝「批次完成后不知道在干什么」的黑箱:
 *   - modelActivity(model)       → Waiting for the model…
 *   - modelActivity(responding)  → Drafting response…
 *   - modelActivity(reviewing)   → Reviewing execution results…
 *   - 有工具在跑                  → 由 ToolCallTrace 时间线展示,这里不重复
 * 数据全部来自 turn 事件流(turnEventDispatch 写进 msg.meta)。
 */
export default function ActivityStream({ msg }) {
  const { t } = useT()
  const meta = msg?.meta || {}
  const toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls : []
  const running = [...toolCalls].reverse().find((call) => call.status === TOOL_CALL_STATUS.RUNNING) || null
  const fallback = fallbackNotice(meta, t)
  const connectionNeedsAttention = ['reconnecting', 'cancelling'].includes(meta.serverConnectionState)
  const hasReasoningSummary = Boolean(String(meta.reasoning || '').trim())

  if (running && !connectionNeedsAttention) {
    return fallback
      ? <div className="chat-activity-stream mb-2" role="status" aria-live="polite">{fallback}</div>
      : null
  }

  return (
    <>
      {fallback && <div className="chat-activity-stream mb-2" role="status" aria-live="polite">{fallback}</div>}
      <ReasoningTrace
        text={meta.reasoning || ''}
        streaming={!!meta.streaming}
        completed={!meta.streaming && hasReasoningSummary}
        label={meta.streaming ? activityLabel(meta, toolCalls, t) : t('chatMessages.reasoningCompleted')}
        testId="model-activity"
      />
    </>
  )
}

function activityLabel(meta, toolCalls, t) {
  if (meta?.serverConnectionState === 'reconnecting') return t('chatMessages.reconnectingTask')
  if (meta?.serverConnectionState === 'cancelling') return t('chatMessages.cancellingTask')
  const activity = meta?.modelActivity
  if (activity?.kind === 'tool_call_ready') {
    return t('chatMessages.toolCallReady', { name: activity.toolName || t('chatMessages.toolUnknown') })
  }
  if (activity?.kind === 'reasoning') return t('chatMessages.activityReasoning')
  if (activity?.kind === 'model' && activity.phase === 'started') return t('chatMessages.activityModelConnecting')
  if (activity?.kind === 'model' && activity.phase === 'waiting_first_token') return t('chatMessages.activityWaitingFirstOutput')
  if (activity?.kind === 'model' && activity.phase === 'idle') return t('chatMessages.activityModelPaused')
  if (activity?.kind === 'model' && activity.phase === 'retrying') return t('chatMessages.activityModelRetrying')
  if (activity?.kind === 'model') return t('chatMessages.activityModelWorking')
  if (activity?.kind === 'responding') return t('chatMessages.activityReceivingOutput')
  if (activity?.kind === 'reviewing') return t('chatMessages.reviewingResults')
  // Progress events describe the last completed batch. A newer model/tool
  // activity is the current work and must win, otherwise the UI can remain on
  // a stale "batch_completed" label while the next model call is running.
  const progress = meta?.progress
  if (progress?.phase) return t('chatMessages.activityWorkingPhase', { phase: progress.phase })
  if (Number.isFinite(progress?.completed) && Number.isFinite(progress?.total) && progress.total > 0) {
    return t('chatMessages.activityProcessing', { completed: progress.completed, total: progress.total })
  }
  if (toolCalls.length > 0) return t('chatMessages.continuingTask')
  return t('chatMessages.preparingTask')
}
