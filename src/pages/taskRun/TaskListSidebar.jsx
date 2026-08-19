import { filterJob, formatTime } from './taskRunUtils.js'

export default function TaskListSidebar({ jobs, loading, filters, activeFilter, setActiveFilter, selectedJobId, onSelect, statusLabel, t }) {
  const visibleJobs = jobs.filter((job) => filterJob(job, activeFilter))
  return (
    <aside className="border-r border-dashed border-ink-fade/40 p-4 overflow-y-auto">
      <div className="flex flex-wrap gap-2 mb-4">{filters.map((filter) => <button type="button" key={filter.key} onClick={() => setActiveFilter(filter.key)} className={`h-7 px-3 rounded-full border text-xs ${activeFilter === filter.key ? 'bg-ink text-paper border-ink' : 'border-ink-fade/60 text-ink-soft'}`}>{filter.label}</button>)}</div>
      {loading ? <p className="text-sm text-ink-fade">{t('taskCenter.loading')}</p> : visibleJobs.length === 0 ? <div className="rounded-md border border-dashed border-ink-fade/40 p-4 text-sm text-ink-fade">{t('taskCenter.empty')}</div> : (
        <div className="flex flex-col gap-2">{visibleJobs.map((job) => <button type="button" key={job.id} onClick={() => onSelect(job.id)} className={`text-left rounded-md border p-3 transition-colors ${selectedJobId === job.id ? 'border-accent bg-accent-soft' : 'border-ink/20 hover:border-ink/40'}`}><div className="flex items-center justify-between gap-2"><span className="text-sm text-ink line-clamp-2">{job.title}</span><span className="text-[10px] text-ink-fade shrink-0">{job.progress}%</span></div><div className="mt-2 flex items-center justify-between text-xs text-ink-soft"><span>{statusLabel(job.status)}</span><span>{formatTime(job.updatedAt)}</span></div></button>)}</div>
      )}
    </aside>
  )
}
