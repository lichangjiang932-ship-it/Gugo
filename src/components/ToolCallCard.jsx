import { memo, useId } from 'react'
import { ChevronDown, Copy, FileText } from 'lucide-react'
import { findToolCallArtifacts } from '../lib/toolCallArtifacts.js'
import { parseToolArgs, summarizeToolArgs, toolCallLabel } from '../lib/toolCallPresentation.js'
import { toolCallChangeStats } from '../lib/localFileReferences.js'
import { STEP_KIND, stepKindForTool, stepUsesVerbLabel } from '../lib/toolStepKinds.js'
import { toolFailureFacts, toolFailureSummary } from '../lib/toolFailurePresentation.js'
import { redactSensitiveText } from '../../shared/sensitiveText.js'
import { copyTextToClipboard } from '../lib/clipboard.js'
import { withDownloadToken } from '../lib/jobClient.js'
import { useT } from '../i18n/I18nProvider.jsx'
import LiveElapsed from './LiveElapsed.jsx'

const FILE_PATH_SUMMARY_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])
const COMMAND_ARTIFACT_TOOLS = new Set(['bash_exec', 'run_command'])

function stepKindLabelSuffix(kind) {
  const value = String(kind || 'other')
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

// Everyday tools read as the verb; the rest keep their own richer name — see
// STEP_VERB_TOOLS in lib/toolStepKinds.js.
function stepRowLabel(name, kind, t) {
  return stepUsesVerbLabel(name)
    ? t(`toolActivity.kind${stepKindLabelSuffix(kind)}`)
    : toolCallLabel(name, t)
}

/**
 * The command as it was run — a shell line, not its JSON envelope. It still goes
 * through the same redaction and length bound as any other detail: a credential
 * on the command line must not become visible just because the command is
 * presented without its envelope.
 */
function commandLine(args) {
  const raw = Array.isArray(args?.command) ? args.command.join(' ') : args?.command
  if (typeof raw !== 'string' || !raw.trim()) return ''
  return redactSensitiveText(raw.trim()).slice(0, 12000)
}

function isManagedArtifact(artifact) {
  return Boolean(artifact && typeof artifact === 'object' && String(artifact.id || '').trim() && managedArtifactHref(artifact))
}

function managedArtifactHref(artifact) {
  const raw = String(artifact?.url || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw, 'http://artifact.local')
    if (parsed.origin !== 'http://artifact.local' || !parsed.pathname.startsWith('/api/artifacts/')) return ''
    return withDownloadToken(`${parsed.pathname}${parsed.search}${parsed.hash}`)
  } catch {
    return ''
  }
}

function normalizedFilename(value) {
  return String(value || '').trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLocaleLowerCase() || ''
}

function exactSummaryArtifact(name, args, artifacts) {
  if (!FILE_PATH_SUMMARY_TOOLS.has(name) || typeof args.path !== 'string') return null
  const expectedFilename = normalizedFilename(args.path)
  if (!expectedFilename) return null
  const matches = artifacts.filter((artifact) => normalizedFilename(artifact.filename || artifact.title) === expectedFilename)
  return matches.length === 1 ? matches[0] : null
}

function formatDetails(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') {
    try { return redactSensitiveText(JSON.stringify(value, null, 2)).slice(0, 12000) } catch { return redactSensitiveText(value).slice(0, 12000) }
  }
  try { return redactSensitiveText(JSON.stringify(JSON.parse(value), null, 2)).slice(0, 12000) } catch { return redactSensitiveText(value).slice(0, 12000) }
}

function authorizationLabel(authorization, t) {
  if (!authorization || typeof authorization !== 'object') return ''
  if (authorization.kind === 'standing_rule') {
    return authorization.scope
      ? t('chatMessages.toolStandingRuleScope', { scope: authorization.scope })
      : t('chatMessages.toolStandingRule')
  }
  return authorization.kind ? String(authorization.kind) : ''
}

function openArtifactLink(event, onOpenArtifact, artifact, call) {
  event.stopPropagation()
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  onOpenArtifact(artifact, call)
}

function DetailSection({ kind, label, value, live = false, command = false }) {
  const { t } = useT()
  const copy = (event) => {
    event.stopPropagation()
    void copyTextToClipboard(value)
  }
  return (
    <div className="chat-tool-detail-section" data-testid={`tool-detail-${kind}`}>
      <div className="chat-tool-detail-heading">
        <span>{label}</span>
        <button type="button" data-testid={`tool-detail-copy-${kind}`} aria-label={t('chatMessages.toolCopyDetail', { label })} onClick={copy}><Copy aria-hidden="true" /></button>
      </div>
      <pre
        className={live ? 'chat-tool-live-output' : undefined}
        data-command={command ? 'true' : undefined}
        data-testid={live ? 'tool-live-output' : undefined}
        tabIndex="0"
      >
        {value}
      </pre>
    </div>
  )
}

function ToolCallCard({ call, artifacts = [], onOpenArtifact, expanded, onToggle, workspacePath = '' }) {
  const { t } = useT()
  const detailsId = `tool-step-details-${useId().replace(/:/g, '')}`
  // The row reads as what the agent was doing (终端 / 编辑 / 搜索 …), not as the
  // runtime's tool name; the step number is still handed to plugin contributions
  // by the trace, it is just no longer drawn on the row itself.
  const kind = stepKindForTool(call.name)
  const label = stepRowLabel(call.name, kind, t)
  const changeStats = toolCallChangeStats(call, { workspacePath })
  const args = parseToolArgs(call.arguments)
  const rawSummary = summarizeToolArgs(call.name, args, t)
  const summary = redactSensitiveText(rawSummary === t('chatMessages.toolEmptyValue') ? t('toolActivity.summaryUnavailable') : rawSummary)
  const matchedArtifacts = findToolCallArtifacts(call, artifacts).filter(isManagedArtifact)
  const summaryArtifact = exactSummaryArtifact(call.name, args, matchedArtifacts)
  const summaryCanOpen = Boolean(summaryArtifact && typeof onOpenArtifact === 'function')
  const commandArtifacts = COMMAND_ARTIFACT_TOOLS.has(call.name) && typeof onOpenArtifact === 'function' ? matchedArtifacts : []
  const authorization = authorizationLabel(call.approvalAuthorization, t)
  const errorFacts = toolFailureFacts(call, t)
  const failureSummary = toolFailureSummary(call, t)

  // A step reports itself with words and colour, not with a glyph: the mark is
  // reserved for the row's own status, and only when it is not a plain success.
  let statusText = t('chatMessages.toolRunning')
  if (call.status === 'success') statusText = t('chatMessages.toolCompleted')
  else if (call.status === 'error') statusText = t('chatMessages.toolFailed')
  else if (call.status === 'cancelled') statusText = t('chatMessages.toolStopped')

  const resultValue = call.status === 'error' ? (call.result || call.error) : call.result
  // A command step shows the command itself: the envelope adds nothing and the
  // line is what the reader came to read.
  const bareCommand = kind === STEP_KIND.COMMAND ? commandLine(args) : ''
  const argumentsText = bareCommand || formatDetails(call.arguments, t('chatMessages.toolNoArguments'))
  const resultText = formatDetails(resultValue, call.status === 'error' ? t('chatMessages.toolUnknownError') : t('chatMessages.toolEmptyResult'))
  const isExpanded = expanded === true

  return (
    <article className="chat-tool-step" data-testid="tool-call-step" data-status={call.status || 'running'} data-kind={stepKindForTool(call.name)} role="listitem">
      <div className="chat-tool-step-body">
        <header className="chat-tool-step-header chat-tool-step-header-compact" data-expanded={isExpanded ? 'true' : 'false'} onClick={() => onToggle?.()}>
          <span className="chat-tool-label">{label}</span>
          <span className="chat-tool-action">
            {summaryCanOpen ? (
              <a href={managedArtifactHref(summaryArtifact)} target="_blank" rel="noopener noreferrer" className="chat-tool-summary chat-tool-summary-button text-left underline decoration-current/30 underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/45" title={summary} data-testid="tool-summary-open" onClick={(event) => openArtifactLink(event, onOpenArtifact, summaryArtifact, call)}>{summary}</a>
            ) : <span className="chat-tool-summary" data-technical={FILE_PATH_SUMMARY_TOOLS.has(call.name) || COMMAND_ARTIFACT_TOOLS.has(call.name) || undefined} title={summary}>{summary}</span>}
          </span>
          {changeStats && (
            <span className="chat-tool-diffstat" data-testid="tool-diffstat" aria-label={t('chatMessages.progressChanges', changeStats)}>
              <span className="chat-tool-diffstat-add">+{changeStats.additions}</span>
              {changeStats.deletions > 0 && <span className="chat-tool-diffstat-del">-{changeStats.deletions}</span>}
            </span>
          )}
          <span className="chat-tool-status" data-status={call.status || 'running'}>
            {call.status === 'success' ? <span className="sr-only">{statusText}</span> : <span>{statusText}</span>}
            {call.status === 'running' && <LiveElapsed className="chat-tool-elapsed" startedAt={call.startedAt} />}
          </span>
          <button type="button" className="chat-tool-step-toggle" data-testid="tool-step-toggle" aria-expanded={isExpanded} aria-controls={detailsId} aria-label={isExpanded ? t('chatMessages.collapseToolDetails') : t('chatMessages.expandToolDetails')} onClick={(event) => { event.stopPropagation(); onToggle?.() }}><ChevronDown aria-hidden="true" /></button>
        </header>

        {failureSummary && (
          <p className="chat-tool-failure-summary" data-testid="tool-failure-summary">{failureSummary}</p>
        )}

        {commandArtifacts.length > 0 && (
          <div className="chat-tool-artifact-links" data-testid="tool-artifact-links">
            {commandArtifacts.map((artifact) => (
              <a key={artifact.id} href={managedArtifactHref(artifact)} target="_blank" rel="noopener noreferrer" data-testid="tool-artifact-open" className="chat-tool-artifact-link" title={artifact.filename || artifact.title} onClick={(event) => openArtifactLink(event, onOpenArtifact, artifact, call)}>
                <FileText aria-hidden="true" /><span className="chat-output-file-name">{artifact.filename || artifact.title}</span>
              </a>
            ))}
          </div>
        )}

        {isExpanded && (
          <section id={detailsId} className="chat-tool-details-card" data-testid="tool-step-details">
            <code className="chat-tool-raw-name">{call.name || label}</code>
            {authorization && <div className="chat-tool-authorization" title={authorization}>{authorization}</div>}
            <DetailSection kind="arguments" label={t('chatMessages.toolArguments')} value={argumentsText} command={kind === 'command'} />
            {call.status === 'running' && call.outputReplay === 'live_only' && (
              <div className="chat-tool-output-replay-note" data-testid="tool-output-replay-note">
                {t('chatMessages.toolLiveOutputReplayNote')}
              </div>
            )}
            {(call.status === 'success' || call.status === 'error') && <DetailSection kind="result" label={call.status === 'error' ? t('chatMessages.toolError') : t('chatMessages.toolResult')} value={resultText} />}
            {call.status === 'running' && call.liveOutput && <DetailSection kind="live" label={t('chatMessages.toolLiveOutput')} value={call.liveOutput} live />}
            {call.status === 'error' && (errorFacts.length > 0 || call.errorHint) && (
              <div className="chat-tool-error-context">
                {errorFacts.length > 0 && <div className="chat-tool-error-facts">{errorFacts.map((fact) => <span key={fact}>{fact}</span>)}</div>}
                {/* A schema rejection's hint is an instruction to the model; the
                    summary above already tells the reader what happened. */}
                {call.errorHint && call.errorCode !== 'tool_arguments_validation_failed' && <div className="chat-tool-error-hint">{call.errorHint}</div>}
              </div>
            )}
          </section>
        )}
      </div>
    </article>
  )
}

export default memo(ToolCallCard)
