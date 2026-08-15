import { memo, useId } from 'react'
import { Search, Globe, ChevronDown, CheckCircle2, XCircle, CircleStop, Loader2, FileText, Presentation, Table2, Code2, PieChart, Image, Bot, FolderOpen, FileEdit, Terminal, GitBranch, Diff, CheckSquare, Layers, Wrench, FolderKey, ListRestart, RotateCcw, ListTree, MessageCircleQuestion, PackageCheck, SquareTerminal, Copy, CircleStop as StopProcess } from 'lucide-react'
import { findToolCallArtifacts } from '../lib/toolCallArtifacts.js'
import { parseToolArgs, summarizeToolArgsEn, toolCallLabelEn } from '../lib/toolCallPresentation.js'
import { copyTextToClipboard } from '../lib/clipboard.js'
import LiveElapsed from './LiveElapsed.jsx'

const ICONS = {
  web_search: Search, fetch_url: Globe, create_pptx: Presentation, create_docx: FileText,
  create_xlsx: Table2, create_react_component: Code2, create_mermaid: PieChart,
  create_chart: PieChart, create_svg: Image, create_html_app: Code2, Agent: Bot,
  read_file: FolderOpen, write_file: FileEdit, edit_file: FileEdit, multi_edit: Layers,
  apply_patch: Diff, list_directory: FolderOpen, grep_code: Search, find_symbol: Search,
  bash_exec: Terminal, run_command: Terminal, run_test: CheckSquare, docker_exec: SquareTerminal,
  bash_background: SquareTerminal, process_list: ListTree, process_kill: StopProcess,
  git_status: GitBranch, git_diff: Diff, run_project_check: CheckSquare, manage_todos: CheckSquare,
  request_directory: FolderKey, request_clarification: MessageCircleQuestion,
  set_deliverables: PackageCheck, rewind_files: RotateCcw, list_imports: ListRestart,
}

const FILE_PATH_SUMMARY_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])
const COMMAND_ARTIFACT_TOOLS = new Set(['bash_exec', 'run_command'])

function isManagedArtifact(artifact) {
  return Boolean(artifact && typeof artifact === 'object' && String(artifact.id || '').trim() && String(artifact.url || '').trim())
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
    try { return JSON.stringify(value, null, 2).slice(0, 12000) } catch { return String(value).slice(0, 12000) }
  }
  try { return JSON.stringify(JSON.parse(value), null, 2).slice(0, 12000) } catch { return value.slice(0, 12000) }
}

function authorizationLabel(authorization) {
  if (!authorization || typeof authorization !== 'object') return ''
  if (authorization.kind === 'standing_rule') return authorization.scope ? `Standing rule: ${authorization.scope}` : 'Standing rule'
  return authorization.kind ? String(authorization.kind) : ''
}

function DetailSection({ kind, label, value, live = false }) {
  const copy = (event) => {
    event.stopPropagation()
    void copyTextToClipboard(value)
  }
  return (
    <div className="chat-tool-detail-section" data-testid={`tool-detail-${kind}`}>
      <div className="chat-tool-detail-heading">
        <span>{label}</span>
        <button type="button" data-testid={`tool-detail-copy-${kind}`} aria-label={`Copy ${label.toLowerCase()}`} onClick={copy}><Copy aria-hidden="true" /></button>
      </div>
      <pre className={live ? 'chat-tool-live-output' : undefined} data-testid={live ? 'tool-live-output' : undefined} tabIndex="0">{value}</pre>
    </div>
  )
}

function ToolCallCard({ call, stepNumber, artifacts = [], onOpenArtifact, expanded = false, onToggle }) {
  const detailsId = `tool-step-details-${useId().replace(/:/g, '')}`
  const Icon = ICONS[call.name] || Wrench
  const label = toolCallLabelEn(call.name)
  const args = parseToolArgs(call.arguments)
  const summary = summarizeToolArgsEn(call.name, args)
  const matchedArtifacts = findToolCallArtifacts(call, artifacts).filter(isManagedArtifact)
  const summaryArtifact = exactSummaryArtifact(call.name, args, matchedArtifacts)
  const summaryCanOpen = Boolean(summaryArtifact && typeof onOpenArtifact === 'function')
  const commandArtifacts = COMMAND_ARTIFACT_TOOLS.has(call.name) && typeof onOpenArtifact === 'function' ? matchedArtifacts : []
  const authorization = authorizationLabel(call.approvalAuthorization)
  const errorFacts = call.status === 'error'
    ? [...new Set([
        call.errorCode,
        Number.isInteger(Number(call.errorStatus)) ? `HTTP ${Number(call.errorStatus)}` : '',
        Number.isInteger(Number(call.attempts)) && Number(call.attempts) > 0 ? `${Number(call.attempts)}x` : '',
        call.retryable ? 'Retry' : '',
      ].filter(Boolean))]
    : []

  let StatusIcon = Loader2
  let statusText = 'Running'
  if (call.status === 'success') { StatusIcon = CheckCircle2; statusText = 'Completed' }
  else if (call.status === 'error') { StatusIcon = XCircle; statusText = 'Failed' }
  else if (call.status === 'cancelled') { StatusIcon = CircleStop; statusText = 'Stopped' }

  const resultValue = call.status === 'error' ? (call.result || call.error) : call.result
  const argumentsText = formatDetails(call.arguments, '(empty)')
  const resultText = formatDetails(resultValue, call.status === 'error' ? 'Unknown error' : '(empty)')

  return (
    <article className="chat-tool-step" data-testid="tool-call-step" data-status={call.status || 'running'} role="listitem">
      <div className="chat-tool-step-marker" aria-label={`Step ${stepNumber}`}>{stepNumber}</div>
      <div className="chat-tool-step-body">
        <header className="chat-tool-step-header chat-tool-step-header-compact" data-expanded={expanded ? 'true' : 'false'} onClick={() => onToggle?.()}>
          <span className="chat-tool-icon"><Icon aria-hidden="true" /><span className="sr-only">{label}</span></span>
          {summaryCanOpen ? (
            <button type="button" className="chat-tool-summary chat-tool-summary-button text-left underline decoration-current/30 underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/45" title={summary} data-testid="tool-summary-open" onClick={(event) => { event.stopPropagation(); onOpenArtifact(summaryArtifact, call) }}>{summary}</button>
          ) : <span className="chat-tool-summary" title={summary}>{summary}</span>}
          <span className="chat-tool-status"><StatusIcon className={call.status === 'running' ? 'animate-spin' : ''} aria-hidden="true" /><span>{statusText}</span>{call.status === 'running' && <LiveElapsed className="chat-tool-elapsed" />}</span>
          <button type="button" className="chat-tool-step-toggle" data-testid="tool-step-toggle" aria-expanded={expanded} aria-controls={detailsId} aria-label={expanded ? 'Collapse details' : 'Expand details'} onClick={(event) => { event.stopPropagation(); onToggle?.() }}><ChevronDown aria-hidden="true" /></button>
        </header>

        {commandArtifacts.length > 0 && (
          <div className="chat-tool-artifact-links" data-testid="tool-artifact-links">
            {commandArtifacts.map((artifact) => (
              <button key={artifact.id} type="button" data-testid="tool-artifact-open" className="chat-tool-artifact-link" title={artifact.filename || artifact.title} onClick={(event) => { event.stopPropagation(); onOpenArtifact(artifact, call) }}>
                <FileText aria-hidden="true" /><span className="chat-output-file-name">{artifact.filename || artifact.title}</span>
              </button>
            ))}
          </div>
        )}

        {expanded && (
          <section id={detailsId} className="chat-tool-details-card" data-testid="tool-step-details">
            {authorization && <div className="chat-tool-authorization" title={authorization}>{authorization}</div>}
            <DetailSection kind="arguments" label="Arguments" value={argumentsText} />
            {(call.status === 'success' || call.status === 'error') && <DetailSection kind="result" label={call.status === 'error' ? 'Error' : 'Result'} value={resultText} />}
            {call.status === 'running' && call.liveOutput && <DetailSection kind="live" label="Live output" value={call.liveOutput} live />}
            {call.status === 'error' && (errorFacts.length > 0 || call.errorHint) && (
              <div className="chat-tool-error-context">
                {errorFacts.length > 0 && <div className="chat-tool-error-facts">{errorFacts.map((fact) => <span key={fact}>{fact}</span>)}</div>}
                {call.errorHint && <div className="chat-tool-error-hint">{call.errorHint}</div>}
              </div>
            )}
          </section>
        )}
      </div>
    </article>
  )
}

export default memo(ToolCallCard)
