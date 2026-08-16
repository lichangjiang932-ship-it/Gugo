import { TOOL_CALL_STATUS } from '../../../store/taskStatus.js'
import { ReasoningTrace } from './ActivityTraces.jsx'

// ★ 执行过程(活动流)按用户要求使用全英文技术标签,与界面语言无关。

/**
 * 降级链路可视化:provider 重试 / 切换以一条 amber 文字行透出,
 * 让用户知道「模型没死,只是换了条路」,而不是只看到转圈。
 */
function fallbackNotice(meta) {
  const fb = meta?.modelFallback
  if (!fb) return null
  const retry = fb.kind === 'retry'
  return (
    <div className="chat-activity-line chat-activity-line-fallback" data-testid="model-fallback">
      <span className="chat-activity-mark chat-activity-mark-fallback" aria-hidden="true">{retry ? '\u21bb' : '\u21c4'}</span>
      <span className="chat-activity-label">{retry ? 'Retrying model' : 'Switched provider'}</span>
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
  const meta = msg?.meta || {}
  const toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls : []
  const running = [...toolCalls].reverse().find((call) => call.status === TOOL_CALL_STATUS.RUNNING) || null
  const fallback = fallbackNotice(meta)
  const connectionNeedsAttention = ['reconnecting', 'cancelling'].includes(meta.serverConnectionState)

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
        label={activityLabel(meta, toolCalls)}
        testId="model-activity"
      />
    </>
  )
}

function activityLabel(meta, toolCalls) {
  if (meta?.serverConnectionState === 'reconnecting') return 'Connection lost. Reconnecting…'
  if (meta?.serverConnectionState === 'cancelling') return 'Stopping task…'
  const activity = meta?.modelActivity
  if (activity?.kind === 'tool_call_ready') {
    return `Preparing ${activity.toolName || 'tool'}…`
  }
  if (activity?.kind === 'reasoning') return 'Model is reasoning through the next step…'
  if (activity?.kind === 'model' && activity.phase === 'started') return 'Connecting to the model…'
  if (activity?.kind === 'model' && activity.phase === 'waiting_first_token') return 'Request sent · waiting for the first model output…'
  if (activity?.kind === 'model' && activity.phase === 'idle') return 'Model output paused · task is still running…'
  if (activity?.kind === 'model' && activity.phase === 'retrying') return 'Retrying the model request…'
  if (activity?.kind === 'model') return 'Model is working on the next step…'
  if (activity?.kind === 'responding') return 'Receiving model output…'
  if (activity?.kind === 'reviewing') return 'Reviewing execution results…'
  // Progress events describe the last completed batch. A newer model/tool
  // activity is the current work and must win, otherwise the UI can remain on
  // a stale "batch_completed" label while the next model call is running.
  const progress = meta?.progress
  if (progress?.phase) return `Working: ${progress.phase}…`
  if (Number.isFinite(progress?.completed) && Number.isFinite(progress?.total) && progress.total > 0) {
    return `Processing ${progress.completed}/${progress.total}…`
  }
  if (toolCalls.length > 0) return 'Continuing the task…'
  return 'Preparing task…'
}
