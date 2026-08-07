import { Archive, ArchiveRestore, MoreHorizontal, X } from 'lucide-react'

export default function SessionList({ sessions, activeSessionId, openMenuId, onMenuToggle, onOpen, onArchiveToggle, onDelete, t }) {
  if (!sessions.length) {
    return <div className="px-3 py-8 text-center"><p className="text-xs text-ink-fade">{t('nav.emptyTitle')}</p><p className="mt-1 text-[10px] text-ink-ghost">{t('nav.emptyHint')}</p></div>
  }

  return <div className="flex flex-col gap-0.5">{sessions.map((session, index) => {
    const isActive = session.id === activeSessionId
    return <div key={session.id ?? index} className="group relative flex items-center">
      <button onClick={() => onOpen(session.id)} className={`flex h-8 min-w-0 flex-1 items-center rounded-md px-2 text-left text-[13px] transition-colors ${isActive ? 'bg-paper-2 text-ink' : 'text-ink-soft hover:bg-paper-2/60'}`}>
        <span className="truncate">{session.title}</span>
      </button>
      <button onClick={(event) => { event.stopPropagation(); onMenuToggle(session.id) }} title={t('nav.sessionMenu')} className="absolute right-1 shrink-0 rounded p-1 text-ink-fade opacity-0 transition-opacity hover:bg-paper hover:text-ink group-hover:opacity-100">
        <MoreHorizontal className="h-3 w-3" />
      </button>
      {openMenuId === session.id && <div className="absolute right-0 top-7 z-20 min-w-32 rounded-md border border-ink-fade/40 bg-paper p-1 shadow-lg">
        <button type="button" onClick={(event) => { event.stopPropagation(); onArchiveToggle(session) }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-ink-soft hover:bg-paper-2">
          {session.archivedAt ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
          {session.archivedAt ? t('nav.unarchiveSession') : t('nav.archiveSession')}
        </button>
        <button type="button" onClick={(event) => { event.stopPropagation(); onDelete(session) }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-ink-soft hover:bg-paper-2">
          <X className="h-3 w-3" />{t('nav.deleteSession')}
        </button>
      </div>}
    </div>
  })}</div>
}
