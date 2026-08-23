import { Play, Trash2 } from 'lucide-react'

function formatTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
}

function compactPayload(job) {
  const payload = job.execPayload || {}
  if (job.execType === 'agent_session') return payload.prompt || ''
  if (job.execType === 'direct_notify') return [payload.title, payload.body].filter(Boolean).join(' / ')
  if (job.execType === 'plugin_action') return [payload.pluginId, payload.actionId].filter(Boolean).join(' / ')
  return ''
}

export default function CronJobTable({ controller, t }) {
  const columns = ['job', 'kind', 'schedule', 'lastRun', 'status', 'nextRun', 'actions']
  return (
    <section className="overflow-hidden rounded-md border border-ink-fade/30">
      <div className="grid grid-cols-[1.3fr_0.8fr_1fr_0.9fr_0.9fr_0.9fr_1.1fr] gap-3 bg-paper-2 px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink-fade">{columns.map((key, index) => <span key={key} className={index === columns.length - 1 ? 'text-right' : ''}>{t(`cron.${key}`)}</span>)}</div>
      {controller.loading ? <div className="p-8 text-sm text-ink-fade">{t('common.loading')}</div> : controller.jobs.length ? <div className="divide-y divide-ink-fade/20">{controller.jobs.map((job) => <JobRow key={job.id} agentName={controller.agentName} job={job} onRemove={controller.remove} onRun={controller.runNow} onToggle={controller.toggleEnabled} t={t} />)}</div> : <div className="p-8 text-sm text-ink-fade">{t('cron.empty')}</div>}
    </section>
  )
}

function JobRow({ agentName, job, onRemove, onRun, onToggle, t }) {
  const summary = compactPayload(job)
  return <div className="grid grid-cols-[1.3fr_0.8fr_1fr_0.9fr_0.9fr_0.9fr_1.1fr] items-center gap-3 px-4 py-3 text-sm"><div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><button type="button" onClick={() => onToggle(job)} className={`h-4 w-8 rounded-full border transition-colors ${job.enabled ? 'border-accent bg-accent' : 'border-ink-fade/50 bg-paper'}`} aria-label={job.enabled ? t('cron.disable') : t('cron.enable')}><span className={`block h-3 w-3 rounded-full bg-paper transition-transform ${job.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} /></button><span className="truncate font-medium text-ink">{job.title}</span></div><div className="mt-1 truncate text-xs text-ink-fade">{job.agentId ? agentName.get(job.agentId) || job.agentId : t('cron.allAgents')}{summary ? ` · ${summary}` : ''}</div></div><span className="text-ink-soft">{t(`cron.kind_${job.kind}`)}</span><span className="truncate font-mono text-xs text-ink-soft">{job.scheduleType}: {job.scheduleValue}</span><span className="text-xs text-ink-fade">{formatTime(job.lastRunAt)}</span><span className={`min-w-0 text-xs ${job.lastStatus === 'error' ? 'text-red-600' : 'text-ink-soft'}`}><span>{job.lastStatus || '-'}</span>{job.lastError && <span className="mt-1 block truncate" title={job.lastError}>{job.lastError}</span>}</span><span className="text-xs text-ink-fade">{formatTime(job.nextRunAt)}</span><div className="flex justify-end gap-1"><IconButton title={t('cron.runNow')} onClick={() => onRun(job)}><Play className="h-4 w-4" /></IconButton><IconButton title={t('common.delete')} onClick={() => onRemove(job)}><Trash2 className="h-4 w-4" /></IconButton></div></div>
}

function IconButton({ children, onClick, title }) {
  return <button type="button" onClick={onClick} title={title} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-ink-fade/30 text-ink-soft hover:bg-paper-2">{children}</button>
}
