import { Search, Users } from 'lucide-react'

export default function MemoryFilters({ agents, filterAgent, filterType, onAgentChange, onQueryChange, onTypeChange, query, t, types }) {
  return <div className="flex flex-wrap items-center gap-3 border-b border-ink/5 px-6 py-3">
    <div className="flex items-center gap-1.5 overflow-hidden rounded-md border border-ink/15 text-xs">
      <FilterChip active={filterType === 'all'} onClick={() => onTypeChange('all')}>{t('memory.all')}</FilterChip>
      {types.map((type) => <FilterChip key={type.id} active={filterType === type.id} onClick={() => onTypeChange(type.id)}>{type.label}</FilterChip>)}
    </div>
    <div className="flex items-center gap-1.5 text-xs"><Users className="h-3 w-3 text-ink-fade" /><select value={filterAgent} onChange={(event) => onAgentChange(event.target.value)} className="h-7 rounded-md border border-ink/15 bg-paper-2 px-2 text-xs outline-none focus:border-focus"><option value="all">{t('memory.allAgents')}</option><option value="__global__">{t('memory.globalOnly')}</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{t('memory.agentOnly', { name: agent.name })}</option>)}</select></div>
    <div className="relative max-w-[280px] flex-1"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-fade" /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={t('memory.search')} className="h-8 w-full rounded-md border border-ink/15 bg-paper-2 pl-8 pr-3 text-xs outline-none focus:border-focus" /></div>
  </div>
}

function FilterChip({ active, onClick, children }) {
  return <button type="button" onClick={onClick} className={`px-3 py-1 transition-colors ${active ? 'bg-accent text-accent-contrast' : 'text-ink-soft hover:bg-paper-2'}`}>{children}</button>
}
