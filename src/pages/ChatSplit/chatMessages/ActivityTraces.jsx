import { useId, useState } from 'react'
import { CheckCircle2, ChevronDown, Loader2, XCircle } from 'lucide-react'
import ToolCallCard from '../../../components/ToolCallCard.jsx'
import SubagentCard from '../../../components/SubagentCard.jsx'
import { useT } from '../../../i18n/I18nProvider.jsx'

export function ReasoningTrace({ text = '', streaming = false }) {
  const { t } = useT()
  const [expanded, setExpanded] = useState(false)
  const panelId = useId()
  if (!text) return null
  const detail = streaming ? t('chatMessages.reasoningActive') : t('chatMessages.characters', { count: text.length })
  return <div className="chat-activity-panel mb-2 overflow-hidden"><button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={panelId} aria-label={`${t('chatMessages.reasoning')} · ${detail}`} className="group/reasoning flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-paper-2/55"><ChevronDown className={`w-3 h-3 text-cyan transition-transform ${expanded ? '' : '-rotate-90'}`} /><span className="font-mono text-[10px] tracking-wider uppercase text-ink-fade">{t('chatMessages.reasoning')}</span><span aria-hidden="true" className="text-xs text-ink-soft opacity-0 transition-opacity group-hover/reasoning:opacity-100 group-focus-visible/reasoning:opacity-100">{detail}</span>{streaming && <span className="inline-flex items-center gap-1" role="status" aria-live="polite"><span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan animate-pulse" aria-hidden="true" /><span className="sr-only">{t('chatMessages.reasoningActive')}</span></span>}</button>{expanded && <div id={panelId} className="border-t border-ink/10 px-3 py-2"><pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-5 text-ink-soft">{text}</pre></div>}</div>
}

export function ToolCallTrace({ calls = [] }) {
  const { t } = useT()
  const [expanded, setExpanded] = useState(() => calls.some((call) => call.status === 'running'))
  const panelId = useId()
  const failed = calls.filter((call) => call.status === 'error').length
  const running = calls.filter((call) => call.status === 'running').length
  const completed = calls.length - running
  const StatusIcon = running > 0 ? Loader2 : failed > 0 ? XCircle : CheckCircle2
  const statusClass = running > 0 ? 'text-ember animate-spin' : failed > 0 ? 'text-red-600' : 'text-emerald-600'
  return <div className="chat-activity-panel mb-2 overflow-hidden"><button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={panelId} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-paper-2/55"><StatusIcon className={`h-3.5 w-3.5 shrink-0 ${statusClass}`} /><span className="text-xs font-medium text-ink-soft">{t('chatMessages.execution')}</span><span className="min-w-0 flex-1 truncate text-xs text-ink-fade">{running > 0 ? t('chatMessages.runningSteps', { count: calls.length }) : t('chatMessages.steps', { count: calls.length })}{failed > 0 && <span className="ml-1.5 text-red-600">{t('chatMessages.failedSteps', { count: failed })}</span>}</span><span className="text-[10px] tabular-nums text-ink-fade">{completed}/{calls.length}</span><ChevronDown className={`h-3 w-3 shrink-0 text-ink-fade transition-transform ${expanded ? '' : '-rotate-90'}`} /></button>{expanded && <div id={panelId} className="chat-tool-list px-1 py-1">{calls.map((call) => call.name === 'Agent' ? <SubagentCard key={call.id} call={call} /> : <ToolCallCard key={call.id} call={call} />)}</div>}</div>
}
