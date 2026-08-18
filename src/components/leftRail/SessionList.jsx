import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown, MoreHorizontal, Pin, PinOff, Search, X } from 'lucide-react'
import {
  formatRelativeSessionTime,
  groupSessionsByProject,
  sessionProjectLabel,
  sessionSummaryLabel,
  timestampOf,
} from './sessionListUtils.js'

const CONTEXT_MENU_WIDTH = 176
const CONTEXT_MENU_HEIGHT = 122
const VIEWPORT_MARGIN = 8

function contextMenuPosition(event) {
  const bounds = event.currentTarget.getBoundingClientRect()
  const desiredLeft = event.clientX || bounds.left + 12
  const desiredTop = event.clientY || bounds.top + 12
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(desiredLeft, window.innerWidth - CONTEXT_MENU_WIDTH - VIEWPORT_MARGIN)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(desiredTop, window.innerHeight - CONTEXT_MENU_HEIGHT - VIEWPORT_MARGIN)),
  }
}

function moveMenuFocus(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]:not(:disabled)')]
  if (!items.length) return
  event.preventDefault()
  const current = items.indexOf(document.activeElement)
  if (event.key === 'Home') items[0].focus()
  else if (event.key === 'End') items.at(-1).focus()
  else if (event.key === 'ArrowDown') items[(current + 1 + items.length) % items.length].focus()
  else items[(current - 1 + items.length) % items.length].focus()
}

export default function SessionList({
  sessions,
  activeSessionId,
  openMenuId,
  onMenuOpen,
  onMenuToggle,
  onMenuClose,
  onSearch,
  onOpen,
  onPinToggle,
  onArchiveToggle,
  onDelete,
  lang = 'zh-CN',
  t,
}) {
  const menuRef = useRef(null)
  const menuOriginRef = useRef(null)
  const [contextMenu, setContextMenu] = useState(null)
  const [expanded, setExpanded] = useState(true)
  const groupedSessions = useMemo(() => groupSessionsByProject(sessions), [sessions])

  useEffect(() => {
    if (openMenuId == null) return undefined
    const closeOutside = (event) => {
      if (menuRef.current?.contains(event.target) || menuOriginRef.current?.contains(event.target)) return
      onMenuClose()
    }
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onMenuClose()
      menuOriginRef.current?.focus?.()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [onMenuClose, openMenuId])

  useEffect(() => {
    if (openMenuId == null) return
    menuRef.current?.querySelector('[role="menuitem"]')?.focus()
  }, [openMenuId, contextMenu])

  const renderSession = (session, index) => {
    const isActive = session.id === activeSessionId
    const isMenuOpen = openMenuId === session.id
    const contextPosition = contextMenu?.sessionId === session.id ? contextMenu : null
    const menuId = `session-actions-${session.id}`
    const timestamp = timestampOf(session)
    return <div
      key={session.id ?? index}
      className={`group relative flex min-h-14 items-stretch rounded-card transition-colors ${isActive ? 'bg-ink/[0.055]' : 'hover:bg-ink/[0.04]'}`}
      onContextMenu={(event) => {
        if (menuRef.current?.contains(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        menuOriginRef.current = event.currentTarget.querySelector('[data-session-open]')
        setContextMenu({ sessionId: session.id, ...contextMenuPosition(event) })
        onMenuOpen(session.id)
      }}
    >
      <button
        type="button"
        data-session-open
        onClick={() => { onMenuClose(); onOpen(session.id) }}
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          event.stopPropagation()
          menuOriginRef.current = event.currentTarget
          setContextMenu({ sessionId: session.id, ...contextMenuPosition(event) })
          onMenuOpen(session.id)
        }}
        aria-current={isActive ? 'page' : undefined}
        aria-keyshortcuts="Shift+F10"
        className="min-w-0 flex-1 rounded-card py-2.5 pl-2.5 pr-9 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
      >
        <span className={`block break-words text-[13px] font-medium leading-5 ${isActive ? 'text-ink' : 'text-ink-soft'}`}>{sessionSummaryLabel(session)}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-5 text-ink-fade">
          <span className="min-w-0 truncate">{sessionProjectLabel(session)}</span>
          <span aria-hidden="true">·</span>
          <time className="shrink-0 tabular-nums" dateTime={timestamp ? new Date(timestamp).toISOString() : undefined}>{formatRelativeSessionTime(session, { locale: lang })}</time>
        </span>
      </button>
      <button
        type="button"
        ref={isMenuOpen && !contextPosition ? menuOriginRef : null}
        onClick={(event) => {
          event.stopPropagation()
          setContextMenu(null)
          menuOriginRef.current = event.currentTarget
          onMenuToggle(session.id)
        }}
        title={t('nav.sessionMenu')}
        aria-label={t('nav.sessionMenu')}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        aria-controls={isMenuOpen ? menuId : undefined}
        className={`absolute right-1.5 top-1.5 rounded-md p-1 text-ink-fade transition-opacity hover:bg-paper hover:text-ink focus:opacity-100 focus:outline-none ${isMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {isMenuOpen && <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-label={t('nav.sessionMenu')}
        onKeyDown={moveMenuFocus}
        style={contextPosition ? { left: contextPosition.left, top: contextPosition.top } : undefined}
        className={`${contextPosition ? 'fixed' : 'absolute right-0 top-9'} z-50 min-w-44 rounded-lg border border-ink/10 bg-paper p-1.5 shadow-xl`}
      >
        <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); onPinToggle(session) }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-ink-soft hover:bg-paper-2 focus:bg-paper-2 focus:outline-none">
          {session.pinnedAt ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          {session.pinnedAt ? t('nav.unpinSession') : t('nav.pinSession')}
        </button>
        <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); onArchiveToggle(session) }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-ink-soft hover:bg-paper-2 focus:bg-paper-2 focus:outline-none">
          {session.archivedAt ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          {session.archivedAt ? t('nav.unarchiveSession') : t('nav.archiveSession')}
        </button>
        <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); onDelete(session) }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-xs text-ink-soft hover:bg-paper-2 focus:bg-paper-2 focus:outline-none">
          <X className="h-3.5 w-3.5" />{t('nav.deleteSession')}
        </button>
      </div>}
    </div>
  }

  return <section aria-label={t('nav.history')}>
    <div className="mb-1 flex h-7 items-center gap-0.5">
      <button type="button" onClick={() => { onMenuClose(); setExpanded((value) => !value) }} aria-expanded={expanded} className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-ink-fade hover:bg-ink/[0.035] hover:text-ink-soft">
        <ChevronDown className={`h-[18px] w-[18px] transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <span className="flex-1 text-left">{t('nav.history')}</span>
      </button>
      <button type="button" onClick={() => { onMenuClose(); onSearch?.() }} title={t('nav.searchPlaceholder')} aria-label={t('nav.searchPlaceholder')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-fade hover:bg-ink/[0.035] hover:text-ink-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/30">
        <Search className="h-[18px] w-[18px]" />
      </button>
    </div>
    {expanded && (groupedSessions.length ? <div className="flex flex-col gap-3">{groupedSessions.map((group) => <div key={group.project} className="min-w-0"><div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-ghost">{group.project}</div><div className="flex flex-col gap-1">{group.sessions.map((session, index) => renderSession(session, index))}</div></div>)}</div> : <div className="px-3 py-8 text-center"><p className="text-xs text-ink-fade">{t('nav.emptyTitle')}</p><p className="mt-1 text-[11px] leading-5 text-ink-ghost">{t('nav.emptyHint')}</p></div>)}
  </section>
}
