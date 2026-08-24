import { Pin, Users } from 'lucide-react'

export default function MemoryList({ agentNameById, editingId, error, items, loading, onEdit, t }) {
  return <div className="w-[360px] overflow-auto border-r border-ink/10">
    {loading && <div className="p-4 text-sm text-ink-fade">{t('memory.loading')}</div>}
    {error && <div className="p-4 text-sm text-danger">{error}</div>}
    {!loading && items.length === 0 && <div className="p-6 text-center text-sm text-ink-fade">{t('memory.empty')}</div>}
    {items.map((memory) => <button key={memory.id} type="button" onClick={() => onEdit(memory)} className={`w-full border-b border-ink/5 px-4 py-3 text-left transition-colors hover:bg-paper-2 ${editingId === memory.id ? 'bg-accent/10' : ''}`}>
      <div className="flex items-center gap-2"><span className="font-mono text-[9px] uppercase tracking-wider text-accent-ink">{memory.type}</span>{memory.pinned && <Pin className="h-3 w-3 text-accent-ink" />}{memory.agentId && <span className="inline-flex items-center gap-0.5 rounded bg-ink/5 px-1.5 py-0.5 text-[9px] text-ink-fade"><Users className="h-2.5 w-2.5" />{agentNameById.get(memory.agentId) || memory.agentId.slice(0, 6)}</span>}<span className="truncate text-sm text-ink">{memory.title}</span></div>
      <div className="mt-1 truncate text-xs text-ink-fade">{(memory.body || '').split('\n')[0]}</div>
    </button>)}
  </div>
}
