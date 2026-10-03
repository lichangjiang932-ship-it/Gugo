import { ChevronDown } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'

/**
 * A subagent run is one step kind among the others, so it renders in the same
 * vocabulary as every other row: the timeline says 子代理, shows what it was asked
 * to do, and reports the state in words.
 *
 * This card used to be an English-only second track with its own icons, labels
 * and native details styling — two visual languages for one timeline. It no
 * longer is; the only thing it keeps of its own is the prompt/result drawers,
 * because a subagent's request is worth reading in full.
 */
function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}') } catch { return fallback }
}

function formatValue(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

export default function SubagentCard({ call }) {
  const { t } = useT()
  const args = parseJson(call.arguments)
  const result = parseJson(call.result, null)
  const summary = String(args.description || args.prompt || args.subagent_type || '').trim()

  let statusText = t('chatMessages.toolRunning')
  if (call.status === 'success') statusText = t('chatMessages.toolCompleted')
  else if (call.status === 'error') statusText = t('chatMessages.toolFailed')
  else if (call.status === 'cancelled') statusText = t('chatMessages.toolStopped')

  const resultValue = call.status === 'error'
    ? (call.error || t('chatMessages.toolUnknownError'))
    : (result?.result ?? call.result)

  return (
    <article className="chat-tool-step chat-subagent-step" data-testid="tool-call-step" data-status={call.status || 'running'} data-kind="delegate" role="listitem">
      <div className="chat-tool-step-body">
        <header className="chat-tool-step-header chat-tool-step-header-compact">
          <span className="chat-tool-label">{t('toolActivity.kindDelegate')}</span>
          <span className="chat-tool-summary" title={summary}>{summary}</span>
          <span className="chat-tool-status" data-status={call.status || 'running'}>
            {call.status === 'success' ? <span className="sr-only">{statusText}</span> : <span>{statusText}</span>}
          </span>
        </header>

        <div className="chat-tool-details-row">
          <details className="chat-tool-details">
            <summary><ChevronDown aria-hidden="true" /><span>{t('chatMessages.toolArguments')}</span></summary>
            <pre tabIndex="0">{formatValue(args.prompt, t('chatMessages.toolEmptyValue'))}</pre>
          </details>
          {(call.status === 'success' || call.status === 'error') && (
            <details className="chat-tool-details">
              <summary><ChevronDown aria-hidden="true" /><span>{call.status === 'error' ? t('chatMessages.toolError') : t('chatMessages.toolResult')}</span></summary>
              <pre tabIndex="0">{formatValue(resultValue, t('chatMessages.toolEmptyResult'))}</pre>
            </details>
          )}
        </div>
      </div>
    </article>
  )
}
