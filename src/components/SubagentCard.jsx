import { Bot, ChevronDown, CheckCircle2, CircleStop, Loader2, XCircle } from 'lucide-react'

// ★ 执行过程(子代理卡片)按用户要求使用全英文技术标签,与界面语言无关。

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}') } catch { return fallback }
}

function formatValue(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

export default function SubagentCard({ call, stepNumber }) {
  const args = parseJson(call.arguments)
  const result = parseJson(call.result, null)
  const label = args.description || args.prompt || 'Subagent'

  let StatusIcon = Loader2
  let statusText = 'Running'
  if (call.status === 'success') {
    StatusIcon = CheckCircle2
    statusText = 'Completed'
  } else if (call.status === 'error') {
    StatusIcon = XCircle
    statusText = 'Failed'
  } else if (call.status === 'cancelled') {
    StatusIcon = CircleStop
    statusText = 'Stopped'
  }

  const resultValue = call.status === 'error'
    ? (call.error || 'Unknown error')
    : (result?.result ?? call.result)

  return (
    <article className="chat-tool-step chat-subagent-step" data-testid="tool-call-step" data-status={call.status || 'running'} role="listitem">
      <div className="chat-tool-step-marker" aria-label={`Step ${stepNumber}`}>{stepNumber}</div>
      <div className="chat-tool-step-body">
        <header className="chat-tool-step-header">
          <span className="chat-tool-icon"><Bot aria-hidden="true" /></span>
          <span className="chat-tool-label">{`Subagent: ${args.subagent_type || 'general'}`}</span>
          <span className="chat-tool-summary" title={label}>{label}</span>
          <span className="chat-tool-status">
            <StatusIcon className={call.status === 'running' ? 'animate-spin' : ''} aria-hidden="true" />
            <span>{statusText}</span>
          </span>
        </header>

        <div className="chat-tool-details-row">
          <details className="chat-tool-details">
            <summary><ChevronDown aria-hidden="true" /><span>Prompt</span></summary>
            <pre tabIndex="0">{formatValue(args.prompt, '(empty)')}</pre>
          </details>
          {(call.status === 'success' || call.status === 'error') && (
            <details className="chat-tool-details" open={call.status === 'error'}>
              <summary><ChevronDown aria-hidden="true" /><span>Result</span></summary>
              <pre tabIndex="0">{formatValue(resultValue, '(empty)')}</pre>
            </details>
          )}
        </div>
      </div>
    </article>
  )
}
