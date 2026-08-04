import { memo, useState } from 'react'
import { Search, Globe, ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, FileText, Presentation, Table2, Code2, PieChart, Image, Bot, FolderOpen, FileEdit, Terminal, GitBranch, Diff, CheckSquare, Layers } from 'lucide-react'
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

function summarizeArgs(name, argsJson) {
  let args = {}
  try { args = JSON.parse(argsJson || '{}') } catch { /* noop */ }
  if (name === 'web_search') return args.query || '(空)'
  if (name === 'fetch_url') return args.url || '(空)'
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') return args.path || '(空)'
  if (name === 'multi_edit') return `${(args.edits || []).length} 个编辑`
  if (name === 'bash_exec') return (args.command || '').slice(0, 60) || '(空)'
  if (name === 'Agent') return args.subagent_type ? `${args.subagent_type}: ${(args.description || '').slice(0, 40)}` : '(空)'
  if (name && name.startsWith('create_')) return args.title || '(空)'
  return JSON.stringify(args).slice(0, 80)
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
  const Icon = ICONS[call.name] || Search
  const label = LABELS[call.name] || call.name
  const summary = summarizeArgs(call.name, call.arguments)
  const authorization = authorizationLabel(call.approvalAuthorization, t)

  let statusIcon = <Loader2 className="w-3.5 h-3.5 animate-spin text-ember" />
  let statusText = '执行中'
  let statusColor = 'text-ember'
  if (call.status === 'success') {
    statusIcon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
    statusText = '成功'
    statusColor = 'text-emerald-700'
  } else if (call.status === 'error') {
    statusIcon = <XCircle className="w-3.5 h-3.5 text-red-600" />
    statusText = '失败'
    statusColor = 'text-red-700'
  }

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-ink/10 bg-paper/70 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 transition-colors hover:bg-paper-2/75"
      >
        {open ? <ChevronDown className="w-3 h-3 text-ink-fade shrink-0" /> : <ChevronRight className="w-3 h-3 text-ink-fade shrink-0" />}
        <Icon className="w-3.5 h-3.5 text-ember shrink-0" />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-fade shrink-0">{label}</span>
        <span className="text-ink-soft truncate flex-1 text-left" title={summary}>{summary}</span>
        <span className={`flex items-center gap-1 shrink-0 ${statusColor}`}>
          {statusIcon}
          <span className="text-[10px]">{statusText}</span>
        </span>
      </button>
      {authorization && (
        <div className="border-t border-emerald-600/15 bg-emerald-50/60 px-2.5 py-1 font-mono text-[9px] text-emerald-700" title={authorization}>
          {authorization}
        </div>
      )}
      {open && (
        <div className="space-y-1.5 border-t border-ink/10 bg-paper-2/40 p-2.5">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-wider text-ink-fade mb-1">参数</div>
            <pre className="whitespace-pre-wrap break-all rounded border border-ink-fade/20 bg-paper p-1.5 text-[10px] leading-snug">
              {(() => {
                try { return JSON.stringify(JSON.parse(call.arguments || '{}'), null, 2) }
                catch { return call.arguments || '(无)' }
              })()}
            </pre>
          </div>
          {call.status !== 'running' && (
            <div>
              <div className="font-mono text-[9px] uppercase tracking-wider text-ink-fade mb-1">{call.status === 'error' ? '错误' : '结果'}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-ink-fade/20 bg-paper p-1.5 text-[10px] leading-snug">
                {call.status === 'error' ? (call.error || '未知错误') : (call.result || '(空)')}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default memo(ToolCallCard)
