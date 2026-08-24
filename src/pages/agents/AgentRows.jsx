import { Download, Package, Sparkles, Star, Trash2 } from 'lucide-react'

export default function AgentRows({ agents, loading, onDelete, onEdit, onExport, onExportZip, t }) {
  if (loading) return <div className="py-12 text-center text-ink-fade">{t('common.loading')}</div>
  if (agents.length === 0) return <div className="py-12 text-center text-ink-fade">{t('agents.emptyHint')}</div>
  return (
    <ul className="divide-y divide-ink/10 border-y border-ink/10">
      {agents.map((agent) => (
        <li key={agent.id} className="-mx-2 flex items-center justify-between rounded px-2 py-4 hover:bg-ink/5">
          <button onClick={() => onEdit(agent)} className="flex-1 text-left">
            <div className="flex items-center gap-2">
              <span className="font-medium">{agent.name}</span>
              {agent.isDefault && <span className="inline-flex items-center gap-1 rounded bg-warning/50 px-2 py-0.5 text-xs text-warning"><Star size={10} />{t('agents.defaultBadge')}</span>}
              {agent.personaTemplate && <span className="inline-flex items-center gap-1 rounded bg-ink/5 px-2 py-0.5 text-xs text-ink-fade"><Sparkles size={10} />{agent.personaTemplate}</span>}
              {(agent.personaManifest?.capabilityIds || []).slice(0, 2).map((id) => <span key={id} className="inline-flex rounded bg-accent/5 px-2 py-0.5 text-xs text-accent-ink">{id}</span>)}
            </div>
            <div className="mt-1 line-clamp-1 text-xs text-ink-fade">{(agent.soulMd || '').slice(0, 120) || t('agents.noSoul')}</div>
          </button>
          <IconButton onClick={() => onExport(agent)} label={t('agents.export')} title=".agent.md"><Download size={16} /></IconButton>
          <IconButton onClick={() => onExportZip(agent)} label={t('agents.exportZip')} title={t('agents.exportZip')}><Package size={16} /></IconButton>
          <IconButton onClick={() => onDelete(agent)} label={t('common.delete')} danger><Trash2 size={16} /></IconButton>
        </li>
      ))}
    </ul>
  )
}

function IconButton({ children, danger = false, label, onClick, title }) {
  return <button onClick={onClick} className={`ml-2 p-2 text-ink-fade ${danger ? 'hover:text-danger' : 'hover:text-ink'}`} aria-label={label} title={title}>{children}</button>
}
