import { Bot, ChevronDown, CheckCircle2, CircleStop, Loader2, XCircle } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}') } catch { return fallback }
}

function formatValue(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

export default function SubagentCard({ call, stepNumber }) {
  const { t } = useT()
  const args = parseJson(call.arguments)
  const result = parseJson(call.result, null)
  const label = args.description || args.prompt || t('chatMessages.subagentFallback')

  let StatusIcon = Loader2
  let statusText = t('chatMessages.toolRunning')
  if (call.status === 'success') {
    StatusIcon = CheckCircle2
    statusText = t('chatMessages.toolCompleted')
  } else if (call.status === 'error') {
    StatusIcon = XCircle
    statusText = t('chatMessages.toolFailed')
  } else if (call.status === 'cancelled') {
    StatusIcon = CircleStop
    statusText = t('chatMessages.toolStopped')
  }

  const resultValue = call.status === 'error'
    ? (call.error || t('chatMessages.toolUnknownError'))
    : (result?.result ?? call.result)

  return (
    <article className="chat-tool-step chat-subagent-step" data-testid="tool-call-step" data-status={call.status || 'running'} role="listitem">
      <div className="chat-tool-step-marker" aria-label={t('chatMessages.stepNumber', { number: stepNumber })}>{stepNumber}</div>
      <div className="chat-tool-step-body">
        <header className="chat-tool-step-header">
          <span className="chat-tool-icon"><Bot aria-hidden="true" /></span>
          <span className="chat-tool-label">{t('chatMessages.subagentType', { type: args.subagent_type || t('chatMessages.subagentGeneral') })}</span>
          <span className="chat-tool-summary" title={label}>{label}</span>
          <span className="chat-tool-status">
            <StatusIcon className={call.status === 'running' ? 'animate-spin' : ''} aria-hidden="true" />
            <span>{statusText}</span>
          </span>
        </header>

        <div className="chat-tool-details-row">
          <details className="chat-tool-details">
            <summary><ChevronDown aria-hidden="true" /><span>{t('chatMessages.subagentPrompt')}</span></summary>
            <pre tabIndex="0">{formatValue(args.prompt, t('chatMessages.toolEmptyResult'))}</pre>
          </details>
          {(call.status === 'success' || call.status === 'error') && (
            <details className="chat-tool-details" open={call.status === 'error'}>
              <summary><ChevronDown aria-hidden="true" /><span>{t('chatMessages.subagentResult')}</span></summary>
              <pre tabIndex="0">{formatValue(resultValue, t('chatMessages.toolEmptyResult'))}</pre>
            </details>
          )}
        </div>
      </div>
    </article>
  )
}
