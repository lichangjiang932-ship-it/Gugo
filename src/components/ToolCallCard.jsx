import { memo } from 'react'
import { Search, Globe, ChevronDown, CheckCircle2, XCircle, CircleStop, Loader2, FileText, Presentation, Table2, Code2, PieChart, Image, Bot, FolderOpen, FileEdit, Terminal, GitBranch, Diff, CheckSquare, Layers, Wrench, FolderKey, ListRestart, RotateCcw, ListTree, MessageCircleQuestion, PackageCheck, SquareTerminal, CircleStop as StopProcess } from 'lucide-react'
import { findToolCallArtifacts } from '../lib/toolCallArtifacts.js'
import { parseToolArgs, summarizeToolArgsEn, toolCallLabelEn } from '../lib/toolCallPresentation.js'
import LiveElapsed from './LiveElapsed.jsx'

const ICONS = {
  web_search: Search,
  fetch_url: Globe,
  create_pptx: Presentation,
  create_docx: FileText,
  create_xlsx: Table2,
  create_react_component: Code2,
  create_mermaid: PieChart,
  create_chart: PieChart,
  create_svg: Image,
  create_html_app: Code2,
  Agent: Bot,
  read_file: FolderOpen,
  write_file: FileEdit,
  edit_file: FileEdit,
  multi_edit: Layers,
  apply_patch: Diff,
  list_directory: FolderOpen,
  grep_code: Search,
  find_symbol: Search,
  bash_exec: Terminal,
  run_command: Terminal,
  run_test: CheckSquare,
  docker_exec: SquareTerminal,
  bash_background: SquareTerminal,
  process_list: ListTree,
  process_kill: StopProcess,
  git_status: GitBranch,
  git_diff: Diff,
  run_project_check: CheckSquare,
  manage_todos: CheckSquare,
  request_directory: FolderKey,
  request_clarification: MessageCircleQuestion,
  set_deliverables: PackageCheck,
  rewind_files: RotateCcw,
  list_imports: ListRestart,
}

const FILE_PATH_SUMMARY_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])
const COMMAND_ARTIFACT_TOOLS = new Set(['bash_exec', 'run_command'])

function isManagedArtifact(artifact) {
  return Boolean(
    artifact
      && typeof artifact === 'object'
      && String(artifact.id || '').trim()
      && String(artifact.url || '').trim(),
  )
}

function normalizedFilename(value) {
  const name = String(value || '').trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  return name.toLocaleLowerCase()
}

function exactSummaryArtifact(name, args, artifacts) {
  if (!FILE_PATH_SUMMARY_TOOLS.has(name) || typeof args.path !== 'string') return null
  const expectedFilename = normalizedFilename(args.path)
  if (!expectedFilename) return null
  const matches = artifacts.filter((artifact) => (
    normalizedFilename(artifact.filename || artifact.title) === expectedFilename
  ))
  return matches.length === 1 ? matches[0] : null
}

function formatDetails(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') {
    try { return JSON.stringify(value, null, 2).slice(0, 12000) } catch { return String(value).slice(0, 12000) }
  }
  try { return JSON.stringify(JSON.parse(value), null, 2).slice(0, 12000) } catch { return value.slice(0, 12000) }
}

function liveOutputTail(value) {
  const tail = String(value || '').replace(/\r/g, '').slice(-4000)
  const line = tail.split('\n').reverse().find((item) => item.trim())?.trim() || ''
  return line.length <= 220 ? line : `…${line.slice(-219)}`
}

function authorizationLabel(authorization) {
  if (!authorization || typeof authorization !== 'object') return ''
  if (authorization.kind === 'standing_rule') {
    return authorization.scope
      ? `Standing rule: ${authorization.scope}`
      : 'Standing rule'
  }
  return authorization.kind ? String(authorization.kind) : ''
}

function ToolCallCard({ call, stepNumber, artifacts = [], onOpenArtifact }) {
  const Icon = ICONS[call.name] || Wrench
  const label = toolCallLabelEn(call.name)
  const args = parseToolArgs(call.arguments)
  const summary = summarizeToolArgsEn(call.name, args)
  const matchedArtifacts = findToolCallArtifacts(call, artifacts).filter(isManagedArtifact)
  const summaryArtifact = exactSummaryArtifact(call.name, args, matchedArtifacts)
  const summaryCanOpen = Boolean(summaryArtifact && typeof onOpenArtifact === 'function')
  const commandArtifacts = COMMAND_ARTIFACT_TOOLS.has(call.name) && typeof onOpenArtifact === 'function'
    ? matchedArtifacts
    : []
  const authorization = authorizationLabel(call.approvalAuthorization)
  const errorFacts = call.status === 'error'
    ? [...new Set([
        call.errorCode,
        Number.isInteger(Number(call.errorStatus)) ? `HTTP ${Number(call.errorStatus)}` : '',
        Number.isInteger(Number(call.attempts)) && Number(call.attempts) > 0 ? `${Number(call.attempts)}×` : '',
        call.retryable ? 'Retry' : '',
      ].filter(Boolean))]
    : []

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

  const resultValue = call.status === 'error' ? (call.result || call.error) : call.result
  const resultFallback = call.status === 'error' ? 'Unknown error' : '(empty)'

  return (
    <article
      className="chat-tool-step"
      data-testid="tool-call-step"
      data-status={call.status || 'running'}
      role="listitem"
    >
      <div className="chat-tool-step-marker" aria-label={`Step ${stepNumber}`}>
        {stepNumber}
      </div>
      <div className="chat-tool-step-body">
        <header className="chat-tool-step-header chat-tool-step-header-compact">
          <span className="chat-tool-icon">
            <Icon aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </span>
          {summaryCanOpen ? (
            <button
              type="button"
              className="chat-tool-summary chat-tool-summary-button text-left underline decoration-current/30 underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/45"
              title={summary}
              data-testid="tool-summary-open"
              onClick={() => onOpenArtifact(summaryArtifact, call)}
            >
              {summary}
            </button>
          ) : (
            <span className="chat-tool-summary" title={summary}>{summary}</span>
          )}
          <span className="chat-tool-status">
            <StatusIcon className={call.status === 'running' ? 'animate-spin' : ''} aria-hidden="true" />
            <span>{statusText}</span>
            {call.status === 'running' && <LiveElapsed className="chat-tool-elapsed" />}
          </span>
        </header>

        {authorization && <div className="chat-tool-authorization" title={authorization}>{authorization}</div>}

        {commandArtifacts.length > 0 && (
          <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5" data-testid="tool-artifact-links">
            {commandArtifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                data-testid="tool-artifact-open"
                className="inline-flex max-w-full items-center gap-1 rounded border border-ink-fade/25 bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition-colors hover:border-ink-fade/50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-fade/45"
                title={artifact.filename || artifact.title}
                onClick={() => onOpenArtifact(artifact, call)}
              >
                <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="chat-output-file-name truncate">{artifact.filename || artifact.title}</span>
              </button>
            ))}
          </div>
        )}

        <div className="chat-tool-details-row">
          <details className="chat-tool-details">
            <summary>
              <ChevronDown aria-hidden="true" />
              <span>Arguments</span>
            </summary>
            <pre tabIndex="0">{formatDetails(call.arguments, '(empty)')}</pre>
          </details>

          {(call.status === 'success' || call.status === 'error') && (
            <details className="chat-tool-details">
              <summary>
                <ChevronDown aria-hidden="true" />
                <span>{call.status === 'error' ? 'Error' : 'Result'}</span>
              </summary>
              <pre tabIndex="0">{formatDetails(resultValue, resultFallback)}</pre>
            </details>
          )}
        </div>

        {call.status === 'running' && call.liveOutput && (
          <details className="chat-tool-live-details">
            <summary title="Live output">
              <ChevronDown aria-hidden="true" />
              <span>Live output</span>
              <span className="chat-tool-live-tail" data-testid="tool-live-output-tail">
                {liveOutputTail(call.liveOutput)}
              </span>
            </summary>
            <pre className="chat-tool-live-output" data-testid="tool-live-output" tabIndex="0">{call.liveOutput}</pre>
          </details>
        )}

        {call.status === 'error' && (errorFacts.length > 0 || call.errorHint) && (
          <div className="chat-tool-error-context">
            {errorFacts.length > 0 && (
              <div className="chat-tool-error-facts">
                {errorFacts.map((fact) => <span key={fact}>{fact}</span>)}
              </div>
            )}
            {call.errorHint && <div className="chat-tool-error-hint">{call.errorHint}</div>}
          </div>
        )}
      </div>
    </article>
  )
}

export default memo(ToolCallCard)
