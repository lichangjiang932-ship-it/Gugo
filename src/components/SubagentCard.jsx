import { useState } from 'react'
import { Bot, ChevronDown, ChevronRight, CheckCircle2, Loader2, XCircle } from 'lucide-react'

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}') } catch { return fallback }
}

export default function SubagentCard({ call }) {
  const [open, setOpen] = useState(false)
  const args = parseJson(call.arguments)
  const result = parseJson(call.result, null)
  const label = args.description || args.prompt || 'Sub-agent'

  let statusIcon = <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-600" />
  let statusText = 'running'
  if (call.status === 'success') {
    statusIcon = <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
    statusText = 'completed'
  } else if (call.status === 'error') {
    statusIcon = <XCircle className="w-3.5 h-3.5 text-red-600" />
    statusText = 'failed'
  }

  return (
    <div className="my-2 border border-violet-200/70 rounded-md bg-gradient-to-br from-violet-50 to-paper text-xs overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-white/45 transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3 text-ink-fade shrink-0" /> : <ChevronRight className="w-3 h-3 text-ink-fade shrink-0" />}
        <Bot className="w-3.5 h-3.5 text-violet-600 shrink-0" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-violet-700 shrink-0">
          Agent · {args.subagent_type || 'general'}
        </span>
        <span className="text-ink-soft truncate flex-1 text-left" title={label}>{label}</span>
        <span className="flex items-center gap-1 shrink-0 text-ink-soft">
          {statusIcon}
          <span className="text-[11px]">{statusText}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-dashed border-violet-200/70 bg-white/55 p-2.5 space-y-2">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-wider text-ink-fade mb-1">Prompt</div>
            <pre className="text-[11px] leading-snug whitespace-pre-wrap break-all bg-paper p-2 rounded border border-ink-fade/20">
              {args.prompt || ''}
            </pre>
          </div>
          {call.status !== 'running' && (
            <div>
              <div className="font-mono text-[9px] uppercase tracking-wider text-ink-fade mb-1">Result</div>
              <pre className="text-[11px] leading-snug whitespace-pre-wrap break-all bg-paper p-2 rounded border border-ink-fade/20 max-h-60 overflow-auto">
                {call.status === 'error' ? (call.error || 'Unknown error') : (result?.result || call.result || '')}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
