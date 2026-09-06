import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Folder, FolderOpen, GitFork, MoreHorizontal, Pin, PinOff, Search, SquarePen, X } from 'lucide-react'
import { groupSessionsByProject, timestampOf } from './sessionListUtils.js'

const CONTEXT_MENU_WIDTH = 176
const CONTEXT_MENU_HEIGHT = 160
const VIEWPORT_MARGIN = 8

function clampMenuPosition(desiredLeft, desiredTop, measured = {}) {
  const width = Math.min(measured.width || CONTEXT_MENU_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
  const height = Math.min(measured.height || CONTEXT_MENU_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2)
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(desiredLeft, window.innerWidth - width - VIEWPORT_MARGIN)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(desiredTop, window.innerHeight - height - VIEWPORT_MARGIN)),
  }
}

function contextMenuPosition(event) {
  const bounds = event.currentTarget.getBoundingClientRect()
  return clampMenuPosition(event.clientX || bounds.left + 12, event.clientY || bounds.top + 12)
}

function triggerMenuPosition(element, measured = {}) {
  const bounds = element?.getBoundingClientRect()
  if (!bounds) return clampMenuPosition(VIEWPORT_MARGIN, VIEWPORT_MARGIN)
  const width = measured.width || CONTEXT_MENU_WIDTH
  const height = measured.height || CONTEXT_MENU_HEIGHT
  const below = bounds.bottom + 4
  const top = below + height <= window.innerHeight - VIEWPORT_MARGIN
    ? below : bounds.top - height - 4
  return clampMenuPosition(bounds.right - width, top, measured)
}

let timestampFormatter = null
function sessionTooltip(session) {
  const title = String(session.title || '')
  const timestamp = timestampOf(session)
  if (timestamp <= 0) return title
  try {
    timestampFormatter ||= new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    return `${title}\n${timestampFormatter.format(timestamp)}`
  } catch {
    return title
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
  onNewInProject,
  onNewRecent,
  onProjectToggle,
  onSearch,
  onOpen,
  onFork,
  onPinToggle,
  onArchiveToggle,
  onDelete,
  storedProjects = [],
  t,
}) {
  const menuRef = useRef(null)
  const menuOriginRef = useRef(null)
  const menuOriginIdRef = useRef(null)
  const menuTriggersRef = useRef(new Map())
  const [contextMenu, setContextMenu] = useState(null)
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState(() => new Set())
  const { projects, ungrouped: orderedSessions } = useMemo(
    () => groupSessionsByProject(sessions, storedProjects),
    [sessions, storedProjects],
  )

  useEffect(() => {
    if (openMenuId == null) return undefined
    const closeOutside = (event) => {
      if (menuRef.current?.contains(event.target) || menuOriginRef.current?.contains(event.target)) return
      onMenuClose()
    }
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onMenuClose()
      menuOriginRef.current?.focus?.({ preventScroll: true })
    }
    const closeOnViewportChange = (event) => {
      if (!menuRef.current?.contains(event.target)) onMenuClose()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    document.addEventListener('scroll', closeOnViewportChange, true)
    window.addEventListener('resize', closeOnViewportChange)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('scroll', closeOnViewportChange, true)
      window.removeEventListener('resize', closeOnViewportChange)
    }
  }, [onMenuClose, openMenuId])

  useLayoutEffect(() => {
    if (openMenuId == null) return
    if (menuOriginIdRef.current !== openMenuId) {
      menuOriginIdRef.current = openMenuId
      menuOriginRef.current = menuTriggersRef.current.get(openMenuId)
    }
    if (menuRef.current) {
      const measured = menuRef.current.getBoundingClientRect()
      const pointerPosition = contextMenu?.sessionId === openMenuId && !contextMenu.anchored
        ? contextMenu : null
      const position = pointerPosition
        ? clampMenuPosition(pointerPosition.left, pointerPosition.top, measured)
        : triggerMenuPosition(menuOriginRef.current, measured)
      menuRef.current.style.left = `${position.left}px`
      menuRef.current.style.top = `${position.top}px`
    }
    menuRef.current?.querySelector('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [openMenuId, contextMenu])

  const renderSession = (session, index) => {
    const isActive = session.id === activeSessionId
    const isMenuOpen = openMenuId === session.id
    const contextPosition = contextMenu?.sessionId === session.id ? contextMenu : null
    const menuId = `session-actions-${session.id}`
    return <div
      key={session.id ?? index}
      className="left-rail-session-row left-rail-action-scope"
      data-session-row={session.id}
      data-active={isActive ? 'true' : 'false'}
      onContextMenu={(event) => {
        if (menuRef.current?.contains(event.target)) return
        event.preventDefault()
        event.stopPropagation()
        menuOriginRef.current = event.currentTarget.querySelector('[data-session-open]')
        menuOriginIdRef.current = session.id
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
          menuOriginIdRef.current = session.id
          setContextMenu({ sessionId: session.id, ...contextMenuPosition(event) })
          onMenuOpen(session.id)
        }}
        aria-current={isActive ? 'page' : undefined}
        aria-keyshortcuts="Shift+F10"
        title={sessionTooltip(session)}
        className="left-rail-session-open"
      >
        <span className={`block min-w-0 flex-1 truncate text-[13px] leading-5 ${isActive ? 'font-medium text-ink' : 'text-ink-soft'}`}>{session.title}</span>
      </button>
      <button
        type="button"
        ref={(element) => {
          if (element) menuTriggersRef.current.set(session.id, element)
          else menuTriggersRef.current.delete(session.id)
        }}
        onClick={(event) => {
          event.stopPropagation()
          setContextMenu({ sessionId: session.id, anchored: true, ...triggerMenuPosition(event.currentTarget) })
          menuOriginRef.current = event.currentTarget
          menuOriginIdRef.current = session.id
          onMenuToggle(session.id)
        }}
        title={t('nav.sessionMenu')}
        aria-label={t('nav.sessionMenu')}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        aria-controls={isMenuOpen ? menuId : undefined}
        className="left-rail-action"
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
        className="left-rail-session-menu fixed z-50 rounded-card border border-ink/10 bg-paper p-1.5 shadow-xl"
      >
        <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); onPinToggle(session) }} className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-xs text-ink-soft hover:bg-paper-2 focus:bg-paper-2 focus:outline-none">
          {session.pinnedAt ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          {session.pinnedAt ? t('nav.unpinSession') : t('nav.pinSession')}
        </button>
        <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); onArchiveToggle(session) }} className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-xs text-ink-soft hover:bg-paper-2 focus:bg-paper-2 focus:outline-none">
          {session.archivedAt ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          {session.archivedAt ? t('nav.unarchiveSession') : t('nav.archiveSession')}
        </button>
        <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); onFork?.(session) }} className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-xs text-ink-soft hover:bg-paper-2 focus:bg-paper-2 focus:outline-none">
          <GitFork className="h-3.5 w-3.5" />{t('nav.forkSession')}
        </button>
        <button type="button" role="menuitem" onClick={(event) => { event.stopPropagation(); onDelete(session) }} className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-xs text-ink-soft hover:bg-paper-2 focus:bg-paper-2 focus:outline-none">
          <X className="h-3.5 w-3.5" />{t('nav.deleteSession')}
        </button>
      </div>}
    </div>
  }

  const projectSections = projects.map((project) => {
    const isCollapsed = collapsedProjectKeys.has(project.key)
    const ProjectIcon = isCollapsed ? Folder : FolderOpen
    const regionId = `session-project-${encodeURIComponent(project.key)}`
    return <section key={project.key} aria-label={project.name} data-session-project={project.path} className="mb-0.5">
      <div className="left-rail-project-header left-rail-action-scope">
        <button
          type="button"
          onClick={() => {
            onMenuClose()
            onProjectToggle?.(project, { expanded: isCollapsed })
            setCollapsedProjectKeys((current) => {
              const next = new Set(current)
              if (next.has(project.key)) next.delete(project.key)
              else next.add(project.key)
              return next
            })
          }}
          aria-expanded={!isCollapsed}
          aria-controls={regionId}
          className="left-rail-project-toggle"
          data-project-toggle={project.path}
        >
          <ProjectIcon data-project-state-icon={isCollapsed ? 'collapsed' : 'expanded'} className="h-4 w-4 shrink-0 text-ink-fade" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px] text-ink" title={project.path}>{project.name}</span>
        </button>
        <button
          type="button"
          onClick={() => { onMenuClose(); onNewInProject?.(project) }}
          title={t('nav.newChatInProject', { project: project.name })}
          aria-label={t('nav.newChatInProject', { project: project.name })}
          className="left-rail-action"
          data-new-project-chat={project.path}
        >
          <SquarePen className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {project.sessions.length > 0 && (
        <div id={regionId} hidden={isCollapsed} className="left-rail-project-sessions" data-project-sessions={project.path}>
          {project.sessions.map((session, index) => renderSession(session, index))}
        </div>
      )}
    </section>
  })

  return <div className="left-rail-session-list">
    {projects.length > 0 && <section aria-label={t('chatMessages.workspaceProjects')}>
      <div className="left-rail-section-heading">
        {t('chatMessages.workspaceProjects')}
      </div>
      {projectSections}
    </section>}
    <section aria-label={t('chatMessages.workspaceRecent')}>
      <div className="left-rail-section-heading left-rail-action-scope">
        <span className="min-w-0 flex-1">
          {t('chatMessages.workspaceRecent')}
        </span>
        <button type="button" onClick={() => { onMenuClose(); onSearch?.() }} title={t('nav.searchPlaceholder')} aria-label={t('nav.searchPlaceholder')} className="left-rail-action">
          <Search className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => { onMenuClose(); onNewRecent?.() }} title={t('nav.newChat')} aria-label={t('nav.newChat')} className="left-rail-action" data-new-recent-chat>
          <SquarePen className="h-3.5 w-3.5" />
        </button>
      </div>
      {orderedSessions.length
        ? <div>{orderedSessions.map((session, index) => renderSession(session, index))}</div>
        : <div className="px-2 py-1 text-[13px] leading-[18px] text-ink-fade">{t('nav.emptyTitle')}</div>}
    </section>
  </div>
}
