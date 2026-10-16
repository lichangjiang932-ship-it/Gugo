import { useCallback, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import NewChatGlyph from './leftRail/NewChatGlyph.jsx'
import { useLocation, useNavigate } from '../lib/router.jsx'
import { useAppContext } from '../store/AppContext'
import { archiveSessionRemote, forkSessionRemote, pinSessionRemote, unarchiveSessionRemote, unpinSessionRemote } from '../lib/sessionClient.js'
import { getAuthToken } from '../lib/accountClient.js'
import { normalizeSessionMutationFailure, sessionMutationFailureKey } from '../lib/sessionMutationFailure.js'
import useStoredChatProjects from '../lib/useStoredChatProjects.js'
import { chatWorkspaceName } from '../lib/chatWorkspaceSelection.js'
import { useT } from '../i18n/I18nProvider.jsx'
import { useToast } from './Toast.jsx'
import Modal from './Modal.jsx'
import ActionButton from './ui/ActionButton.jsx'
import BrandMark from './BrandMark.jsx'
import AccountArea from './leftRail/AccountArea.jsx'
import LoginModal from './leftRail/LoginModal.jsx'
import SessionList from './leftRail/SessionList.jsx'
import RailDisclosureIcon from './leftRail/RailDisclosureIcon.jsx'
import { pinnedTimestampOf } from './leftRail/sessionListUtils.js'
import useLeftRailController from './leftRail/useLeftRailController.js'
import useSessionRename from './leftRail/useSessionRename.js'
import useLeftRailDisclosure from './leftRail/useLeftRailDisclosure.js'
import useLeftRailWidth, { MAX_RAIL_WIDTH, MIN_RAIL_WIDTH } from './leftRail/useLeftRailWidth.js'
import './leftRail/LeftRail.css'

const NARROW_RAIL_QUERY = '(max-width: 959px)'

export default function LeftRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, dispatch } = useAppContext()
  const { t, lang } = useT()
  const toast = useToast()
  // The conversation awaiting a delete confirmation, or null. Held here rather
  // than inside SessionList because the dialog is not the list's to own: the
  // list closes its menu and hands the row over.
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleteOperations, setDeleteOperations] = useState({})
  const deleteInFlightRef = useRef(new Map())
  const deleteOperation = deleteOperations[pendingDelete?.id]
  const deleteBusy = deleteOperation?.pending === true
  const deleteError = deleteOperation?.failure
    ? t(sessionMutationFailureKey(deleteOperation.failure, state.authMode)) : ''
  const controller = useLeftRailController({ authMode: state.authMode, dispatch, location, navigate, t, toast })
  const { closeSessionMenu, setAccountMenuOpen } = controller
  const closeRailMenus = useCallback(() => {
    closeSessionMenu()
    setAccountMenuOpen(false)
  }, [closeSessionMenu, setAccountMenuOpen])
  const {
    collapsed, closeMobileRail, mobileExpanded, narrowViewport, railRef, setRailCollapsed, toggleRef,
  } = useLeftRailDisclosure({
    mediaQuery: NARROW_RAIL_QUERY,
    onCollapse: closeRailMenus,
    hasOpenMenu: controller.openMenuId !== null || controller.accountMenuOpen,
  })
  const rail = useLeftRailWidth()
  // Collapsed and the narrow-viewport overlay keep their own widths — one is a
  // 60px strip, the other is a dialog over the conversation. Only the ordinary
  // rail answers to the edge, and it drops its width transition while a drag is
  // in flight so the edge tracks the pointer instead of chasing it.
  const resizableRail = !collapsed && !narrowViewport
  const railWidthClass = collapsed
    ? 'w-[60px] max-w-full px-2 py-2.5'
    : narrowViewport
      ? 'w-[min(320px,calc(100vw-60px))] min-w-0 max-w-[320px] px-2.5 py-2.5'
      : `min-w-[220px] max-w-[480px] px-2.5 py-2.5 ${rail.resizing ? 'transition-none' : 'transition-[width] duration-200'}`
  const sessions = state.sessions.filter((session) => !session.archivedAt)
  const savedProjects = useStoredChatProjects(state.authMode === 'local')
  const draftWorkspacePath = state.authMode === 'local' && !state.activeSessionId ? state.draftWorkspacePath : ''
  const storedProjects = useMemo(() => draftWorkspacePath
    ? [...savedProjects, { path: draftWorkspacePath, name: chatWorkspaceName(draftWorkspacePath), usedAt: 0 }]
    : savedProjects, [draftWorkspacePath, savedProjects])

  const handleNewChat = () => { controller.closeSessionMenu(); closeMobileRail(); dispatch({ type: 'START_NEW_DRAFT' }); navigate('/chat') }
  const handleNewChatInProject = (project) => {
    controller.closeSessionMenu()
    closeMobileRail()
    dispatch({
      type: 'START_NEW_DRAFT',
      payload: { workspacePath: project.path },
    })
    navigate('/chat')
  }
  const handleSearch = () => { controller.closeSessionMenu(); closeMobileRail(); window.dispatchEvent(new CustomEvent('session-search:open')) }
  const handleOpenSession = (sessionId) => { controller.closeSessionMenu(); closeMobileRail(); dispatch({ type: 'SWITCH_SESSION', payload: sessionId }); navigate('/chat') }
  const handleDelete = (session) => {
    controller.setOpenMenuId(null)
    // Not `confirm()`: it cannot be styled, it cannot be reached from the menu
    // that asked for it, and the desktop shell can block it outright — a blocked
    // dialog reads as a button that does nothing.
    setPendingDelete(session)
  }
  const closeDelete = () => setPendingDelete(null)
  const confirmDelete = async () => {
    const session = pendingDelete
    if (!session || deleteInFlightRef.current.has(session.id)) return
    const token = Symbol(session.id)
    deleteInFlightRef.current.set(session.id, token)
    setDeleteOperations((current) => ({ ...current, [session.id]: { token, pending: true } }))
    let failure = null
    try {
      const deleted = await dispatch({ type: 'DELETE_SESSION', payload: session.id }, {
        onFailure: (value) => { failure = value },
      })
      if (deleted === false) throw failure || new Error('Session mutation outcome unavailable')
      setDeleteOperations((current) => {
        const next = { ...current }
        if (next[session.id]?.token === token) delete next[session.id]
        return next
      })
      setPendingDelete((current) => current?.id === session.id ? null : current)
      toast.success(t('nav.deletedSession', { title: session.title }))
    } catch (error) {
      const normalized = normalizeSessionMutationFailure(error)
      setDeleteOperations((current) => current[session.id]?.token === token
        ? { ...current, [session.id]: { token, pending: false, failure: normalized } } : current)
      toast.error({ title: t('nav.deleteFailedFor', { title: session.title }),
        body: t(sessionMutationFailureKey(normalized, state.authMode)) })
    } finally {
      if (deleteInFlightRef.current.get(session.id) === token) deleteInFlightRef.current.delete(session.id)
    }
  }
  const handleRename = useSessionRename({ state, dispatch, toast, t })
  const handleFork = async (session) => {
    controller.setOpenMenuId(null)
    try {
      const result = await forkSessionRemote(session.id)
      if (!result?.session?.id) throw new Error(t('nav.forkFailed'))
      dispatch({ type: 'ADD_SERVER_FORK', payload: { session: result.session } })
      dispatch({ type: 'SWITCH_SESSION', payload: result.session.id })
      closeMobileRail()
      navigate('/chat')
    } catch (error) {
      toast.error({
        title: t('nav.forkFailed'),
        body: error?.code === 'SESSION_ACTIVE' ? t('nav.forkActive') : error.message,
      })
    }
  }
  const handleArchiveToggle = async (session) => {
    controller.setOpenMenuId(null)
    const archived = !!session.archivedAt
    dispatch({ type: archived ? 'UNARCHIVE_SESSION' : 'ARCHIVE_SESSION', payload: session.id })
    if (!getAuthToken()) return
    try {
      const result = archived ? await unarchiveSessionRemote(session.id) : await archiveSessionRemote(session.id)
      if (result?.session) dispatch({ type: 'APPLY_SERVER_SESSION_METADATA', payload: { sessionId: session.id, session: result.session } })
      // The row leaves the list either way; saying where it went is the only
      // thing that distinguishes a deliberate archive from a mistake.
      toast.success(archived ? t('nav.unarchivedSession') : t('nav.archivedSession'))
    } catch (error) {
      if (/session not found/i.test(error.message || '')) return
      dispatch({ type: archived ? 'ARCHIVE_SESSION' : 'UNARCHIVE_SESSION', payload: session.id })
      toast.error({ title: t('errors.saveFailed'), body: error.message })
    }
  }
  const handlePinToggle = async (session) => {
    controller.setOpenMenuId(null)
    const previousPinnedAt = pinnedTimestampOf(session) > 0 ? session.pinnedAt : null
    const nextPinnedAt = previousPinnedAt ? null : Date.now()
    dispatch({ type: 'SET_SESSION_PIN', payload: { sessionId: session.id, pinnedAt: nextPinnedAt } })
    if (!getAuthToken()) return
    try {
      const result = previousPinnedAt ? await unpinSessionRemote(session.id) : await pinSessionRemote(session.id)
      if (result?.session) dispatch({ type: 'APPLY_SERVER_SESSION_METADATA', payload: { sessionId: session.id, session: result.session } })
    } catch (error) {
      if (/session not found/i.test(error.message || '')) return
      dispatch({ type: 'SET_SESSION_PIN', payload: { sessionId: session.id, pinnedAt: previousPinnedAt } })
      toast.error({ title: t('errors.saveFailed'), body: error.message })
    }
  }

  const isMac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '')
  const searchShortcut = isMac ? '⌘ K' : 'Ctrl K'
  const newChatShortcut = isMac ? '⌥ N' : 'Alt N'

  return <>
    {narrowViewport && mobileExpanded && <button type="button" data-left-rail-backdrop aria-hidden="true" tabIndex={-1} aria-label={t('chatMessages.hideSidebar')} onClick={() => closeMobileRail({ restoreFocus: true })} className="fixed inset-0 z-40 cursor-default bg-ink/20" />}
    <aside ref={railRef} role={narrowViewport && mobileExpanded ? 'dialog' : 'navigation'} aria-modal={narrowViewport && mobileExpanded ? true : undefined} aria-label={`Gugo · ${t('nav.chat')}`} tabIndex={-1} data-collapsed={collapsed ? 'true' : 'false'} style={resizableRail ? { width: `${rail.width}px` } : undefined} className={`left-rail relative flex h-full shrink-0 flex-col border-r border-ink/[0.055] bg-sidebar ${railWidthClass} ${narrowViewport && mobileExpanded ? 'fixed inset-y-0 left-0 z-50 shadow-2xl' : ''}`}>
      {/* Inside the rail, not straddling its edge: a handle hung on the outside is
          at the mercy of whatever clips the parent, and the sliver left behind is
          not something a reader can grab. Double-click restores the width the
          rail would have chosen for itself. */}
      {resizableRail && (
        <button
          type="button"
          data-testid="left-rail-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('nav.resizeSidebar')}
          aria-valuemin={MIN_RAIL_WIDTH}
          aria-valuemax={MAX_RAIL_WIDTH}
          aria-valuenow={Math.round(rail.width)}
          title={t('nav.resizeSidebar')}
          onPointerDown={rail.beginResize}
          onKeyDown={rail.resizeWithKeyboard}
          onDoubleClick={rail.clearWidth}
          className="absolute inset-y-0 right-0 z-30 w-2 cursor-col-resize touch-none bg-transparent outline-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-transparent hover:after:bg-accent/50 focus-visible:after:bg-focus"
        />
      )}
      <header className={`flex h-10 items-center ${collapsed ? 'justify-center' : 'gap-2 px-1'}`}>
        {!collapsed && <button type="button" onClick={() => { controller.closeSessionMenu(); closeMobileRail(); navigate('/chat') }} aria-label="Gugo" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"><BrandMark className="h-7 w-7 shrink-0 text-accent-ink" /><span className="truncate text-ui font-semibold leading-5 text-ink">Gugo</span></button>}
        <button ref={toggleRef} type="button" onClick={() => setRailCollapsed(!collapsed)} title={collapsed ? t('chatMessages.showSidebar') : t('chatMessages.hideSidebar')} aria-label={collapsed ? t('chatMessages.showSidebar') : t('chatMessages.hideSidebar')} aria-expanded={!collapsed} aria-controls="left-rail-history" className="left-rail-toggle flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"><RailDisclosureIcon collapsed={collapsed} /></button>
      </header>

      <div className="mt-2 flex flex-col gap-0.5">
        <button type="button" onClick={handleNewChat} data-sidebar-new-chat title={t('nav.newChatShortcut', { shortcut: newChatShortcut })} aria-label={t('nav.newChat')} aria-keyshortcuts="Alt+n" className={`left-rail-nav-button group flex h-9 w-full items-center rounded-control bg-ink/[0.045] text-ui font-medium text-ink transition-colors hover:bg-ink/[0.075] ${collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5'}`}><NewChatGlyph className="h-[18px] w-[18px] shrink-0" />{!collapsed && <><span className="min-w-0 flex-1 truncate text-left">{t('nav.newChat')}</span><kbd className="left-rail-shortcut opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true">{newChatShortcut}</kbd></>}</button>
        <button type="button" onClick={handleSearch} data-sidebar-search aria-label={t('nav.searchPlaceholder')}
          aria-haspopup="dialog" aria-keyshortcuts="Control+k Meta+k" title={t('nav.searchShortcut', { shortcut: searchShortcut })}
          className={`left-rail-nav-button flex h-9 w-full items-center rounded-control text-ui text-ink-soft transition-colors hover:bg-ink/[0.045] hover:text-ink ${collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5'}`}>
          <Search className="h-[18px] w-[18px] shrink-0" strokeWidth={1.65} aria-hidden="true" />
          {!collapsed && <><span className="min-w-0 flex-1 truncate text-left">{t('nav.searchPlaceholder')}</span><kbd className="left-rail-shortcut" aria-hidden="true">{searchShortcut}</kbd></>}
        </button>
      </div>

      <div id="left-rail-history" hidden={collapsed} className="left-rail-history mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5"><SessionList sessions={sessions} storedProjects={storedProjects} activeWorkspacePath={draftWorkspacePath} activeSessionId={state.activeSessionId} openMenuId={controller.openMenuId} onMenuOpen={controller.setOpenMenuId} onMenuToggle={(id) => controller.setOpenMenuId(controller.openMenuId === id ? null : id)} onMenuClose={controller.closeSessionMenu} onNewInProject={handleNewChatInProject} onNewRecent={handleNewChat} onSearch={handleSearch} showSearchAction={false} locale={lang} onOpen={handleOpenSession} onFork={handleFork} onPinToggle={handlePinToggle} onArchiveToggle={handleArchiveToggle} onDelete={handleDelete} onRename={handleRename} t={t} /></div>
      {collapsed && <div className="min-h-0 flex-1" />}
      <AccountArea compact={collapsed} accountMenuOpen={controller.accountMenuOpen} accountMenuRef={controller.accountMenuRef} user={state.user} localWorkspace={state.authMode !== 'multi_user'} onToggle={() => { controller.closeSessionMenu(); controller.setAccountMenuOpen((open) => !open) }} onNavigate={(item) => { closeMobileRail(); controller.navigateItem(item) }} t={t} />
    </aside>
    {state.authMode === 'multi_user' && <LoginModal login={controller.login} onChange={controller.updateLogin} onClose={() => controller.updateLogin({ open: false, target: null })} onSendCode={controller.sendCode} onVerify={controller.verify} t={t} />}
    {pendingDelete && <Modal
      onClose={closeDelete}
      closeOnBackdrop={false}
      ariaLabelledby="session-delete-title"
      className="flex w-[400px] max-w-[90vw] flex-col gap-3 p-5"
    >
      <div id="session-delete-title" className="text-base font-semibold text-ink">
        {t('nav.confirmDeleteSession', { title: pendingDelete.title })}
      </div>
      <p className="text-xs text-ink-soft">{t('nav.confirmDeleteSessionBody')}</p>
      {deleteBusy && <p role="status" className="text-xs text-ink-soft">{t('nav.deleteWaitingHint')}</p>}
      {deleteError && <p role="alert" className="text-xs text-danger">{deleteError}</p>}
      <div className="flex justify-end gap-2" aria-busy={deleteBusy}>
        <ActionButton data-testid="session-delete-cancel" onClick={closeDelete}>
          {t(deleteBusy ? 'nav.deleteWaitingClose' : 'common.cancel')}
        </ActionButton>
        <ActionButton data-testid="session-delete-confirm" busy={deleteBusy} onClick={confirmDelete} variant="danger">
          {t(deleteBusy ? 'nav.deletingSession' : 'nav.deleteSession')}
        </ActionButton>
      </div>
    </Modal>}
  </>
}
