import { useEffect, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen, Plus, Search } from 'lucide-react'
import { useLocation, useNavigate } from '../lib/router.jsx'
import { useAppContext } from '../store/AppContext'
import { archiveSessionRemote, forkSessionRemote, pinSessionRemote, unarchiveSessionRemote, unpinSessionRemote } from '../lib/sessionClient.js'
import { getAuthToken } from '../lib/accountClient.js'
import { useT } from '../i18n/I18nProvider.jsx'
import { useToast } from './Toast.jsx'
import BrandMark from './BrandMark.jsx'
import AccountArea from './leftRail/AccountArea.jsx'
import LoginModal from './leftRail/LoginModal.jsx'
import SessionList from './leftRail/SessionList.jsx'
import useLeftRailController from './leftRail/useLeftRailController.js'

const COLLAPSED_KEY = 'gugo:left-rail-collapsed'
const NARROW_RAIL_QUERY = '(max-width: 959px)'

function initialCollapsed() {
  try { return window.localStorage?.getItem(COLLAPSED_KEY) === '1' } catch { return false }
}

function initialNarrowViewport() {
  try { return window.matchMedia?.(NARROW_RAIL_QUERY).matches === true } catch { return false }
}

export default function LeftRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, dispatch } = useAppContext()
  const { t } = useT()
  const toast = useToast()
  const controller = useLeftRailController({ authMode: state.authMode, dispatch, location, navigate, t, toast })
  const [collapsedPreference, setCollapsedPreference] = useState(initialCollapsed)
  const [narrowViewport, setNarrowViewport] = useState(initialNarrowViewport)
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const collapsed = narrowViewport ? !mobileExpanded : collapsedPreference
  const railWidthClass = collapsed
    ? 'w-[60px] max-w-full px-2 py-2.5'
    : narrowViewport
      ? 'w-[min(320px,calc(100vw-60px))] min-w-0 max-w-[320px] px-2.5 py-2.5'
      : 'w-[clamp(280px,20vw,320px)] min-w-[280px] max-w-[320px] px-2.5 py-2.5'
  const sessions = state.sessions.filter((session) => !session.archivedAt)

  useEffect(() => {
    const media = window.matchMedia?.(NARROW_RAIL_QUERY)
    if (!media) return undefined
    const onChange = (event) => {
      setNarrowViewport(event.matches)
      setMobileExpanded(false)
    }
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])

  const closeMobileRail = () => { if (narrowViewport) setMobileExpanded(false) }
  const setRailCollapsed = (next) => {
    controller.closeSessionMenu()
    controller.setAccountMenuOpen(false)
    if (narrowViewport) { setMobileExpanded(!next); return }
    setCollapsedPreference(next)
    try { window.localStorage?.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch { /* storage is optional */ }
  }
  const handleNewChat = () => { controller.closeSessionMenu(); closeMobileRail(); dispatch({ type: 'START_NEW_DRAFT' }); navigate('/chat') }
  const handleSearch = () => { controller.closeSessionMenu(); closeMobileRail(); window.dispatchEvent(new CustomEvent('session-search:open')) }
  const handleOpenSession = (sessionId) => { controller.closeSessionMenu(); closeMobileRail(); dispatch({ type: 'SWITCH_SESSION', payload: sessionId }); navigate('/chat') }
  const handleDelete = (session) => {
    controller.setOpenMenuId(null)
    if (confirm(t('nav.confirmDeleteSession', { title: session.title }))) dispatch({ type: 'DELETE_SESSION', payload: session.id })
  }
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
    } catch (error) {
      if (/session not found/i.test(error.message || '')) return
      dispatch({ type: archived ? 'ARCHIVE_SESSION' : 'UNARCHIVE_SESSION', payload: session.id })
      toast.error({ title: t('errors.saveFailed'), body: error.message })
    }
  }
  const handlePinToggle = async (session) => {
    controller.setOpenMenuId(null)
    const previousPinnedAt = session.pinnedAt || null
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

  const navButton = (Icon, label, onClick, active = false) => <button type="button" onClick={onClick} title={collapsed ? label : undefined} aria-label={label} className={`flex h-9 w-full items-center rounded-control text-[13px] transition-colors ${collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5'} ${active ? 'bg-ink/[0.065] font-medium text-ink' : 'text-ink-soft hover:bg-ink/[0.045] hover:text-ink'}`}><Icon className="h-[18px] w-[18px] shrink-0" />{!collapsed && <span className="truncate">{label}</span>}</button>

  return <>
    {narrowViewport && mobileExpanded && <button type="button" aria-label={t('chatMessages.hideSidebar')} onClick={() => setMobileExpanded(false)} className="fixed inset-0 z-40 cursor-default bg-ink/20" />}
    <aside role="navigation" aria-label={`Gugo · ${t('nav.chat')}`} data-collapsed={collapsed ? 'true' : 'false'} className={`flex h-full shrink-0 flex-col border-r border-ink/[0.07] bg-paper transition-[width] duration-200 ${railWidthClass} ${narrowViewport && mobileExpanded ? 'fixed inset-y-0 left-0 z-50 shadow-2xl' : ''}`}>
      <header className={`flex h-10 items-center ${collapsed ? 'justify-center' : 'gap-2 px-1'}`}>
        {!collapsed && <button type="button" onClick={() => { controller.closeSessionMenu(); closeMobileRail(); navigate('/chat') }} aria-label="Gugo" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"><BrandMark className="h-7 w-7 shrink-0 text-accent-ink" /><span className="min-w-0"><span className="block truncate text-[14px] font-semibold leading-4 text-ink">Gugo</span><span className="block truncate text-xs leading-4 text-ink-fade">{t('nav.chat')}</span></span></button>}
        <button type="button" onClick={() => setRailCollapsed(!collapsed)} title={collapsed ? t('chatMessages.showSidebar') : t('chatMessages.hideSidebar')} aria-label={collapsed ? t('chatMessages.showSidebar') : t('chatMessages.hideSidebar')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30">{collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}</button>
      </header>

      <div className="mt-2 flex flex-col gap-0.5">
        <button type="button" onClick={handleNewChat} title={collapsed ? t('nav.newChat') : undefined} aria-label={t('nav.newChat')} className={`flex h-9 w-full items-center rounded-control bg-ink/[0.065] text-[13px] font-medium text-ink transition-colors hover:bg-ink/[0.1] ${collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5'}`}><Plus className="h-[18px] w-[18px] shrink-0" />{!collapsed && <span>{t('nav.newChat')}</span>}</button>
        {collapsed && navButton(Search, t('nav.searchPlaceholder'), handleSearch)}
      </div>

      {!collapsed && <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5"><SessionList sessions={sessions} activeSessionId={state.activeSessionId} openMenuId={controller.openMenuId} onMenuOpen={controller.setOpenMenuId} onMenuToggle={(id) => controller.setOpenMenuId(controller.openMenuId === id ? null : id)} onMenuClose={controller.closeSessionMenu} onSearch={handleSearch} onOpen={handleOpenSession} onFork={handleFork} onPinToggle={handlePinToggle} onArchiveToggle={handleArchiveToggle} onDelete={handleDelete} t={t} /></div>}
      {collapsed && <div className="min-h-0 flex-1" />}
      <AccountArea compact={collapsed} accountMenuOpen={controller.accountMenuOpen} accountMenuRef={controller.accountMenuRef} user={state.user} pendingApprovals={controller.pendingApprovals} onToggle={() => { controller.closeSessionMenu(); controller.setAccountMenuOpen((open) => !open) }} onNavigate={(item) => { closeMobileRail(); controller.navigateItem(item) }} t={t} />
    </aside>
    {state.authMode !== 'local' && <LoginModal login={controller.login} onChange={controller.updateLogin} onClose={() => controller.updateLogin({ open: false, target: null })} onSendCode={controller.sendCode} onVerify={controller.verify} t={t} />}
  </>
}
