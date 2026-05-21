import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Globe, ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2,
  FileText, Database, Presentation, Image, FileCode, Pencil, Terminal,
  BarChart3, GitBranch, Wrench, Sparkles
} from 'lucide-react'

const ICONS = {
  web_search: Search,
  fetch_url: Globe,
  create_pptx: Presentation,
  create_docx: FileText,
  create_xlsx: Database,
  create_react_component: FileCode,
  create_mermaid: GitBranch,
  analyze_data: BarChart3,
  read_file: FileText,
  write_file: Pencil,
  edit_file: Pencil,
  bash_exec: Terminal,
  git_status: GitBranch,
  git_diff: GitBranch,
  run_project_check: Wrench,
}

const LABELS = {
  web_search: '网页搜索',
  fetch_url: '抓取链接',
  create_pptx: '生成PPT',
  create_docx: '生成Word',
  create_xlsx: '生成Excel',
  create_react_component: 'React组件',
  create_mermaid: 'Mermaid图表',
  analyze_data: '数据分析',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  bash_exec: '执行命令',
  git_status: 'Git状态',
  git_diff: 'Git差异',
  run_project_check: '项目检查',
}

const COLORS = {
  web_search: '#6B8BA3',
  fetch_url: '#5B8B6B',
  create_pptx: '#8B7BA3',
  create_docx: '#7B8B6B',
  create_xlsx: '#5B7FA3',
  create_react_component: '#7B6BA3',
  create_mermaid: '#6B8B7A',
  analyze_data: '#5B7FA3',
  read_file: '#8B8B6B',
  write_file: '#8B7B5B',
  edit_file: '#8B7B5B',
  bash_exec: '#6B6B6B',
  git_status: '#7B6B8B',
  git_diff: '#7B6B8B',
  run_project_check: '#6B7B8B',
}

function summarizeArgs(name, argsJson) {
  let args = {}
  try { args = JSON.parse(argsJson || '{}') } catch { /* noop */ }
  if (name === 'web_search') return args.query || '(空)'
  if (name === 'fetch_url') return args.url || '(空)'
  if (name === 'create_pptx') return args.title || '(空)'
  if (name === 'create_docx') return args.title || '(空)'
  if (name === 'create_xlsx') return args.sheets?.[0]?.sheet_name || args.title || '(空)'
  if (name === 'create_react_component') return args.title || '(空)'
  if (name === 'create_mermaid') return args.title || '(空)'
  if (name === 'analyze_data') return args.analysis_type || '全部分析'
  return JSON.stringify(args).slice(0, 80)
}

export default function ToolCallCard({ call }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[call.name] || Wrench
  const label = LABELS[call.name] || call.name
  const summary = summarizeArgs(call.name, call.arguments)
  const color = COLORS[call.name] || '#8A7B68'

  let statusIcon = <Loader2 className="w-3.5 h-3.5 animate-spin text-ember" />
  let statusText = '执行中'
  let statusColor = 'text-ember'
  let bgColor = 'bg-ember-soft/20'
  let borderColor = 'border-ember/20'

  if (call.status === 'success') {
    statusIcon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
    statusText = '成功'
    statusColor = 'text-emerald-700'
    bgColor = 'bg-emerald-50/40'
    borderColor = 'border-emerald-400/30'
  } else if (call.status === 'error') {
    statusIcon = <XCircle className="w-3.5 h-3.5 text-red-500" />
    statusText = '失败'
    statusColor = 'text-red-600'
    bgColor = 'bg-red-50/40'
    borderColor = 'border-red-400/30'
  }

  return (
    <div className={`my-1.5 border rounded-xl overflow-hidden transition-all duration-200 ${borderColor} ${bgColor}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-paper/50 transition-colors"
      >
        <span className="shrink-0 transition-transform duration-150">
          {open ? <ChevronDown className="w-3 h-3 text-ink-fade" /> : <ChevronRight className="w-3 h-3 text-ink-fade" />}
        </span>
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${color}15`, border: `1px solid ${color}25` }}
        >
          <Icon className="w-3.5 h-3.5" style={{ color }} />
        </div>
        <span className="font-mono text-[9px] uppercase tracking-[0.15em] shrink-0" style={{ color }}>{label}</span>
        <span className="text-[11px] text-ink-soft truncate flex-1 text-left" title={summary}>{summary}</span>
        <span className={`flex items-center gap-1 shrink-0 ${statusColor}`}>
          {statusIcon}
          <span className="text-[11px] font-medium">{statusText}</span>
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-dashed border-ink-fade/20 p-3 space-y-3">
              <div>
                <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-ink-fade/80 mb-1.5">参数</div>
                <pre className="text-[11px] leading-snug whitespace-pre-wrap break-all bg-paper/70 p-2.5 rounded-lg border border-ink-fade/15 font-mono text-ink-soft">
                  {(() => {
                    try { return JSON.stringify(JSON.parse(call.arguments || '{}'), null, 2) }
                    catch { return call.arguments || '(无)' }
                  })()}
                </pre>
              </div>
              {call.status !== 'running' && (
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-ink-fade/80 mb-1.5">{call.status === 'error' ? '错误信息' : '执行结果'}</div>
                  <pre className="text-[11px] leading-snug whitespace-pre-wrap break-all bg-paper/70 p-2.5 rounded-lg border border-ink-fade/15 max-h-52 overflow-auto font-mono text-ink-soft">
                    {call.status === 'error' ? (call.error || '未知错误') : (call.result || '(空)')}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
