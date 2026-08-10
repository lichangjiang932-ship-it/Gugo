import { memo, useState } from 'react'
import { Search, Globe, ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, FileText, Presentation, Table2, Code2, PieChart, Image, Bot, FolderOpen, FileEdit, Terminal, GitBranch, Diff, CheckSquare, Layers, Wrench } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'

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

const LABELS = {
  web_search: '网页搜索',
  fetch_url: '抓取链接',
  create_pptx: '生成 PPT',
  create_docx: '生成 Word',
  create_xlsx: '生成 Excel',
  create_react_component: 'React 组件',
  create_mermaid: '流程图',
  create_chart: '图表',
  create_svg: 'SVG 图形',
  create_html_app: 'HTML 应用',
  Agent: '子代理',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  multi_edit: '批量编辑',
  bash_exec: '终端命令',
  git_status: 'Git 状态',
  git_diff: 'Git 差异',
  run_project_check: '项目检查',
  manage_todos: '任务管理',
}

const LABEL_KEYS = {
  apply_patch: 'chatMessages.toolApplyPatch',
  list_directory: 'chatMessages.toolListDirectory',
  grep_code: 'chatMessages.toolGrepCode',
  find_symbol: 'chatMessages.toolFindSymbol',
}

function summarizeArgs(name, argsJson, t) {
  let args = {}
  try { args = JSON.parse(argsJson || '{}') } catch { /* noop */ }
  if (name === 'web_search') return args.query || '(空)'
  if (name === 'fetch_url') return args.url || '(空)'
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return args.path || '(空)'
  if (name === 'list_directory') return args.path || t('chatMessages.toolCurrentWorkspace')
  if (name === 'grep_code') return args.pattern || t('chatMessages.toolUnspecified')
  if (name === 'find_symbol') return args.name || t('chatMessages.toolUnspecified')
  if (name === 'multi_edit') return `${(args.edits || []).length} 个编辑`
  if (name === 'apply_patch') return t('chatMessages.toolFileCount', { count: String(args.patch || '').match(/^\*\*\* (?:Add|Update|Delete) File:/gm)?.length || 0 })
  if (name === 'bash_exec') return String(args.command || '').replace(/\s+/g, ' ').slice(0, 96) || '(空)'
  if (name === 'Agent') return args.subagent_type ? `${args.subagent_type}: ${(args.description || '').slice(0, 40)}` : '(空)'
  if (name && name.startsWith('create_')) return args.title || '(空)'
  const compact = JSON.stringify(args)
  return compact === '{}' ? t('chatMessages.toolNoArguments') : compact.slice(0, 96)
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

function ToolCallCard({ call }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const Icon = ICONS[call.name] || Wrench
  const label = LABEL_KEYS[call.name] ? t(LABEL_KEYS[call.name]) : (LABELS[call.name] || call.name)
  const summary = summarizeArgs(call.name, call.arguments, t)
  const authorization = authorizationLabel(call.approvalAuthorization, t)
  const errorFacts = call.status === 'error'
    ? [...new Set([
        call.errorCode,
        Number.isInteger(Number(call.errorStatus)) ? `HTTP ${Number(call.errorStatus)}` : '',
        Number.isInteger(Number(call.attempts)) && Number(call.attempts) > 0 ? `${Number(call.attempts)}×` : '',
        call.retryable ? t('taskCenter.retry') : '',
      ].filter(Boolean))]
    : []

  let statusIcon = <Loader2 className="w-3.5 h-3.5 animate-spin text-ember" />
  let statusText = t('chatMessages.toolRunning')
  let statusColor = 'text-ember'
  if (call.status === 'success') {
    statusIcon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
    statusText = t('chatMessages.toolCompleted')
    statusColor = 'text-emerald-700'
  } else if (call.status === 'error') {
    statusIcon = <XCircle className="w-3.5 h-3.5 text-red-600" />
    statusText = t('chatMessages.toolFailed')
    statusColor = 'text-red-700'
  }

  return (
    <div className="my-1 text-xs" data-testid="tool-call-step" data-status={call.status || 'running'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-paper-2/70"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-ink/[0.05]"><Icon className="h-3 w-3 text-ink-fade" /></span>
        <span className={`shrink-0 text-[11px] font-medium ${statusColor}`}>{statusText}</span>
        <span className="shrink-0 text-[11px] text-ink-soft">{label}</span>
        <span className="min-w-0 flex-1 truncate text-left text-[11px] text-ink-fade" title={summary}>{summary}</span>
        {statusIcon}
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-ink-fade" /> : <ChevronRight className="h-3 w-3 shrink-0 text-ink-fade opacity-60 group-hover:opacity-100" />}
      </button>
      {authorization && (
        <div className="ml-7 px-1 pb-1 text-[10px] text-emerald-700" title={authorization}>
          {authorization}
        </div>
      )}
      {open && (
        <div className="ml-7 space-y-2 border-l border-ink/10 py-1 pl-3 pr-1">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-wider text-ink-fade mb-1">{t('chatMessages.toolArguments')}</div>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink/[0.035] p-2 text-[10px] leading-4 text-ink-soft">
              {formatDetails(call.arguments, t('chatMessages.toolNoArguments'))}
            </pre>
          </div>
          {call.status !== 'running' && (
            <div>
              <div className="font-mono text-[9px] uppercase tracking-wider text-ink-fade mb-1">{call.status === 'error' ? t('chatMessages.toolError') : t('chatMessages.toolResult')}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink/[0.035] p-2 text-[10px] leading-4 text-ink-soft">
                {formatDetails(call.status === 'error' ? (call.result || call.error) : call.result, call.status === 'error' ? t('chatMessages.toolUnknownError') : t('chatMessages.toolEmptyResult'))}
              </pre>
            </div>
          )}
          {call.status === 'error' && (errorFacts.length > 0 || call.errorHint) && (
            <div className="space-y-1.5">
              {errorFacts.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {errorFacts.map((fact) => (
                    <span key={fact} className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-[9px] text-red-700">{fact}</span>
                  ))}
                </div>
              )}
              {call.errorHint && (
                <div className="rounded-md bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">{call.errorHint}</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default memo(ToolCallCard)
