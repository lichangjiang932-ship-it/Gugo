import { useT } from '../../../i18n/I18nProvider.jsx'
import { TOOL_CALL_STATUS } from '../../../store/taskStatus.js'
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
 * 实时交错文本流 —— 把「正在做什么」以文字行呈现，替代纯 spinner / 呼吸点这类
 * 微表情。数据全部来自 turn 事件流（turnEventDispatch 已经把它们写进 msg.meta）：
 *
 *   - modelFallback                    → provider 重试/切换降级提示
 *   - modelActivity(tool_call_ready)   → 「正在准备运行 {tool}…」就绪态
 *   - 无工具调用、纯推理                 → 复用 ReasoningTrace 的紧凑「思考中…」状态
 *   - 有工具调用                        → 已完成的一行 ✓、正在跑的一行 →，下面跟 liveOutput 尾巴
 *
 * 只在 streaming 时由 MessageRow 挂载；消息完成后 ToolCallTrace 卡片接管详情，
 * 这里不重复渲染。reasoning 原文仍不外露（见 ActivityTraces.ReasoningTrace 的约定）。
 */
export default function ActivityStream({ msg }) {
  const { t } = useT()
  const meta = msg?.meta || {}
  const toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls : []
  const running = [...toolCalls].reverse().find((call) => call.status === TOOL_CALL_STATUS.RUNNING) || null
  const fallback = fallbackNotice(meta, t)
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
        label={activityLabel(meta, toolCalls, t)}
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
  if (activity?.kind === 'model') return t('chatMessages.waitingForModel')
  if (activity?.kind === 'responding') return t('chatMessages.draftingResponse')
  if (activity?.kind === 'reviewing') return t('chatMessages.reviewingResults')
  if (toolCalls.length > 0) return t('chatMessages.continuingTask')
  return t('chatMessages.preparingTask')
}
