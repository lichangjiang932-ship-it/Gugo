import { memo } from 'react'
import { Search, Globe, ChevronDown, CheckCircle2, XCircle, Loader2, FileText, Presentation, Table2, Code2, PieChart, Image, Bot, FolderOpen, FileEdit, Terminal, GitBranch, Diff, CheckSquare, Layers, Wrench } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import { findToolCallArtifacts } from '../lib/toolCallArtifacts.js'

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
  git_status: GitBranch,
  git_diff: Diff,
  run_project_check: CheckSquare,
  manage_todos: CheckSquare,
}

const LABEL_KEYS = {
  web_search: 'chatMessages.toolWebSearch',
  fetch_url: 'chatMessages.toolFetchUrl',
  create_pptx: 'chatMessages.toolCreatePptx',
  create_docx: 'chatMessages.toolCreateDocx',
  create_xlsx: 'chatMessages.toolCreateXlsx',
  create_react_component: 'chatMessages.toolCreateReactComponent',
  create_mermaid: 'chatMessages.toolCreateMermaid',
  create_chart: 'chatMessages.toolCreateChart',
  create_svg: 'chatMessages.toolCreateSvg',
  create_html_app: 'chatMessages.toolCreateHtmlApp',
  Agent: 'chatMessages.toolAgent',
  read_file: 'chatMessages.toolReadFile',
  write_file: 'chatMessages.toolWriteFile',
  edit_file: 'chatMessages.toolEditFile',
  multi_edit: 'chatMessages.toolMultiEdit',
  apply_patch: 'chatMessages.toolApplyPatch',
  list_directory: 'chatMessages.toolListDirectory',
  grep_code: 'chatMessages.toolGrepCode',
  find_symbol: 'chatMessages.toolFindSymbol',
  bash_exec: 'chatMessages.toolBashExec',
  git_status: 'chatMessages.toolGitStatus',
  git_diff: 'chatMessages.toolGitDiff',
  run_project_check: 'chatMessages.toolRunProjectCheck',
  manage_todos: 'chatMessages.toolManageTodos',
}

const FILE_PATH_SUMMARY_TOOLS = new Set(['read_file', 'write_file', 'edit_file'])
const COMMAND_ARTIFACT_TOOLS = new Set(['bash_exec', 'run_command'])

function parseArgs(argsJson) {
  if (argsJson && typeof argsJson === 'object' && !Array.isArray(argsJson)) return argsJson
  try {
    const parsed = JSON.parse(argsJson || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function summarizeArgs(name, args, t) {
  const empty = t('chatMessages.toolEmptyValue')
  if (name === 'web_search') return args.query || empty
  if (name === 'fetch_url') return args.url || empty
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return args.path || empty
  if (name === 'list_directory') return args.path || t('chatMessages.toolCurrentWorkspace')
  if (name === 'grep_code') return args.pattern || t('chatMessages.toolUnspecified')
  if (name === 'find_symbol') return args.name || t('chatMessages.toolUnspecified')
  if (name === 'multi_edit') return t('chatMessages.toolEditCount', { count: (args.edits || []).length })
  if (name === 'apply_patch') return t('chatMessages.toolFileCount', { count: String(args.patch || '').match(/^\*\*\* (?:Add|Update|Delete) File:/gm)?.length || 0 })
  if (name === 'bash_exec') return String(args.command || '').replace(/\s+/g, ' ').slice(0, 96) || empty
  if (name === 'Agent') return args.subagent_type ? `${args.subagent_type}: ${(args.description || '').slice(0, 40)}` : empty
  if (name && name.startsWith('create_')) return args.title || empty
  const compact = JSON.stringify(args)
  return compact === '{}' ? t('chatMessages.toolNoArguments') : compact.slice(0, 96)
}

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

function authorizationLabel(authorization, t) {
  if (!authorization || typeof authorization !== 'object') return ''
  if (authorization.kind === 'standing_rule') {
    return authorization.scope
      ? t('permissionsDashboard.authorizationStandingScope', { scope: authorization.scope })
      : t('permissionsDashboard.authorizationStanding')
  }
  return authorization.kind ? t('permissionsDashboard.authorizationKind', { kind: authorization.kind }) : ''
}

function ToolCallCard({ call, stepNumber, artifacts = [], onOpenArtifact }) {
  const { t } = useT()
  const Icon = ICONS[call.name] || Wrench
  const label = LABEL_KEYS[call.name] ? t(LABEL_KEYS[call.name]) : (call.name || t('chatMessages.toolUnknown'))
  const args = parseArgs(call.arguments)
  const summary = summarizeArgs(call.name, args, t)
  const matchedArtifacts = findToolCallArtifacts(call, artifacts).filter(isManagedArtifact)
  const summaryArtifact = exactSummaryArtifact(call.name, args, matchedArtifacts)
  const summaryCanOpen = Boolean(summaryArtifact && typeof onOpenArtifact === 'function')
  const commandArtifacts = COMMAND_ARTIFACT_TOOLS.has(call.name) && typeof onOpenArtifact === 'function'
    ? matchedArtifacts
    : []
  const authorization = authorizationLabel(call.approvalAuthorization, t)
  const errorFacts = call.status === 'error'
    ? [...new Set([
        call.errorCode,
        Number.isInteger(Number(call.errorStatus)) ? `HTTP ${Number(call.errorStatus)}` : '',
        Number.isInteger(Number(call.attempts)) && Number(call.attempts) > 0 ? `${Number(call.attempts)}×` : '',
        call.retryable ? t('taskCenter.retry') : '',
      ].filter(Boolean))]
    : []

  let StatusIcon = Loader2
  let statusText = t('chatMessages.toolRunning')
  if (call.status === 'success') {
    StatusIcon = CheckCircle2
    statusText = t('chatMessages.toolCompleted')
  } else if (call.status === 'error') {
    StatusIcon = XCircle
    statusText = t('chatMessages.toolFailed')
  }

  const resultValue = call.status === 'error' ? (call.result || call.error) : call.result
  const resultFallback = call.status === 'error' ? t('chatMessages.toolUnknownError') : t('chatMessages.toolEmptyResult')

  return (
    <article
      className="chat-tool-step"
      data-testid="tool-call-step"
      data-status={call.status || 'running'}
      role="listitem"
    >
      <div className="chat-tool-step-marker" aria-label={t('chatMessages.stepNumber', { number: stepNumber })}>
        {stepNumber}
      </div>
      <div className="chat-tool-step-body">
        <header className="chat-tool-step-header">
          <span className="chat-tool-icon"><Icon aria-hidden="true" /></span>
          <span className="chat-tool-label">{label}</span>
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
                className="inline-flex max-w-full items-center gap-1 rounded border border-ink-fade/25 bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-soft transition-colors hover:border-ember/45 hover:text-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/45"
                title={artifact.filename || artifact.title}
                onClick={() => onOpenArtifact(artifact, call)}
              >
                <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{artifact.filename || artifact.title}</span>
              </button>
            ))}
          </div>
        )}

        <div className="chat-tool-details-row">
          <details className="chat-tool-details">
            <summary>
              <ChevronDown aria-hidden="true" />
              <span>{t('chatMessages.toolArguments')}</span>
            </summary>
            <pre tabIndex="0">{formatDetails(call.arguments, t('chatMessages.toolNoArguments'))}</pre>
          </details>

          {call.status !== 'running' && (
            <details className="chat-tool-details" open={call.status === 'error'}>
              <summary>
                <ChevronDown aria-hidden="true" />
                <span>{call.status === 'error' ? t('chatMessages.toolError') : t('chatMessages.toolResult')}</span>
              </summary>
              <pre tabIndex="0">{formatDetails(resultValue, resultFallback)}</pre>
            </details>
          )}
        </div>

        {call.status === 'running' && call.liveOutput && (
          <pre className="chat-tool-live-output" data-testid="tool-live-output">{call.liveOutput}</pre>
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
