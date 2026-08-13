import { useT } from '../../../i18n/I18nProvider.jsx'
import { TOOL_CALL_STATUS } from '../../../store/taskStatus.js'
import { parseToolArgs, summarizeToolArgs, toolCallLabel } from '../../../lib/toolCallPresentation.js'
import { ReasoningTrace } from './ActivityTraces.jsx'

const LIVE_OUTPUT_TAIL_CHARS = 1200
const LIVE_OUTPUT_TAIL_LINES = 8
const COMPLETED_PREVIEW_COUNT = 2

function tailLines(text, chars, lines) {
  const value = String(text || '')
  if (!value) return ''
  const trimmed = value.length > chars ? value.slice(-chars) : value
  const byLines = trimmed.split(/\r?\n/)
  return byLines.slice(-lines).join('\n')
}

function callLine(call, t) {
  const label = toolCallLabel(call.name, t)
  const args = parseToolArgs(call.arguments)
  const summary = summarizeToolArgs(call.name, args, t)
  return { label, summary: summary || t('chatMessages.toolNoArguments') }
}

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

  if (meta.modelActivity?.kind === 'tool_call_ready' && !running) {
    return (
      <div data-testid="model-activity" role="status" aria-live="polite" className="chat-activity-stream mb-2">
        {fallback}
        <div className="chat-activity-line chat-activity-line-ready">
          <span>{t('chatMessages.toolCallReady', { name: meta.modelActivity.toolName })}</span>
        </div>
      </div>
    )
  }

  if (toolCalls.length === 0) {
    return (
      <>
        {fallback && <div className="chat-activity-stream mb-2" role="status" aria-live="polite">{fallback}</div>}
        <ReasoningTrace text={meta.reasoning || ''} streaming={!!meta.streaming && !msg.content} />
      </>
    )
  }

  const completed = toolCalls.filter((call) => call.status !== TOOL_CALL_STATUS.RUNNING)
  const recentCompleted = completed.slice(-COMPLETED_PREVIEW_COUNT)

  return (
    <div className="chat-activity-stream mb-2" role="status" aria-live="polite">
      {fallback}
      {recentCompleted.map((call) => {
        const { label, summary } = callLine(call, t)
        const failed = call.status === TOOL_CALL_STATUS.ERROR
        return (
          <div key={call.id} className={`chat-activity-line chat-activity-line-done ${failed ? 'chat-activity-line-error' : ''}`}>
            <span className="chat-activity-mark" aria-hidden="true">{failed ? '\u2717' : '\u2713'}</span>
            <span className="chat-activity-label">{label}</span>
            <span className="chat-activity-arg">{summary}</span>
          </div>
        )
      })}
      {running && (() => {
        const { label, summary } = callLine(running, t)
        const output = tailLines(running.liveOutput, LIVE_OUTPUT_TAIL_CHARS, LIVE_OUTPUT_TAIL_LINES)
        return (
          <div key={running.id}>
            <div className="chat-activity-line chat-activity-line-running">
              <span className="chat-activity-mark chat-activity-mark-running" aria-hidden="true">{'\u2192'}</span>
              <span className="chat-activity-label">{label}</span>
              <span className="chat-activity-arg">{summary}</span>
            </div>
            {output && <pre className="chat-activity-live-output" data-testid="activity-live-output">{output}</pre>}
          </div>
        )
      })()}
    </div>
  )
}
