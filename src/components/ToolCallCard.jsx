import { useState } from 'react'
import { Search, Globe, ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, FileText, Presentation, Table2, Code2, PieChart, Image, Bot, FolderOpen, FileEdit, Terminal, GitBranch, Diff, CheckSquare, Layers } from 'lucide-react'

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

export default function ToolCallCard({ call }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[call.name] || Search
  const label = LABELS[call.name] || call.name
  const summary = summarizeArgs(call.name, call.arguments)

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
    <div className="my-2 border border-ink-fade/30 rounded-md bg-paper text-xs overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-paper-2 transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3 text-ink-fade shrink-0" /> : <ChevronRight className="w-3 h-3 text-ink-fade shrink-0" />}
        <Icon className="w-3.5 h-3.5 text-ember shrink-0" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember shrink-0">{label}</span>
        <span className="text-ink-soft truncate flex-1 text-left" title={summary}>{summary}</span>
        <span className={`flex items-center gap-1 shrink-0 ${statusColor}`}>
          {statusIcon}
          <span className="text-[11px]">{statusText}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-dashed border-ink-fade/30 bg-paper-2/60 p-2.5 space-y-2">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-wider text-ink-fade mb-1">参数</div>
            <pre className="text-[11px] leading-snug whitespace-pre-wrap break-all bg-paper p-2 rounded border border-ink-fade/20">
              {(() => {
                try { return JSON.stringify(JSON.parse(call.arguments || '{}'), null, 2) }
                catch { return call.arguments || '(无)' }
              })()}
            </pre>
          </div>
          {call.status !== 'running' && (
            <div>
              <div className="font-mono text-[9px] uppercase tracking-wider text-ink-fade mb-1">{call.status === 'error' ? '错误' : '结果'}</div>
              <pre className="text-[11px] leading-snug whitespace-pre-wrap break-all bg-paper p-2 rounded border border-ink-fade/20 max-h-60 overflow-auto">
                {call.status === 'error' ? (call.error || '未知错误') : (call.result || '(空)')}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
