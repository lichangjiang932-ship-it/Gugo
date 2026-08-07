import { Plus, Search, Wrench } from 'lucide-react'
import { useLocation, useNavigate } from '../lib/router.jsx'
import { useAppContext } from '../store/AppContext'
import { archiveSessionRemote, unarchiveSessionRemote } from '../lib/sessionClient.js'
import { getAuthToken } from '../lib/accountClient.js'
import { useT } from '../i18n/I18nProvider.jsx'
import { useToast } from './Toast.jsx'
import BrandMark from './BrandMark.jsx'
import AccountArea from './leftRail/AccountArea.jsx'
import LoginModal from './leftRail/LoginModal.jsx'
import SessionList from './leftRail/SessionList.jsx'
import useLeftRailController from './leftRail/useLeftRailController.js'

export default function LeftRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, dispatch } = useAppContext()
  const { t } = useT()
  const toast = useToast()
  const controller = useLeftRailController({ authMode: state.authMode, dispatch, location, navigate, t, toast })
  const sessions = state.sessions.filter((session) => !session.archivedAt)

  const handleNewChat = () => { dispatch({ type: 'START_NEW_DRAFT' }); navigate('/chat') }
  const handleOpenSession = (sessionId) => { dispatch({ type: 'SWITCH_SESSION', payload: sessionId }); navigate('/chat') }
  const handleDelete = (session) => {
    controller.setOpenMenuId(null)
    if (confirm(t('nav.confirmDeleteSession', { title: session.title }))) dispatch({ type: 'DELETE_SESSION', payload: session.id })
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

  return <>
    <aside role="navigation" aria-label={t('nav.newChat')} className="flex h-full w-[248px] shrink-0 flex-col border-r border-ink/10 bg-paper p-3">
      <div className="flex h-10 items-center px-1.5"><button onClick={() => navigate('/chat')} aria-label="Gugo" className="flex items-center gap-2"><BrandMark className="h-7 w-7 text-ember" /><span className="font-display text-lg italic text-ink">Gugo</span></button></div>
      <div className="mt-2 flex flex-col gap-0.5">
        <button onClick={handleNewChat} className="flex h-9 items-center gap-2.5 rounded-lg bg-ink px-3 text-sm text-paper transition-colors hover:bg-ink-soft"><Plus className="h-4 w-4" /><span>{t('nav.newChat')}</span></button>
        <button type="button" onClick={() => controller.navigateItem({ path: '/skills' })} className={`flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors ${location.pathname === '/skills' ? 'bg-paper-2 text-ink' : 'text-ink-soft hover:bg-paper-2/70'}`}><Wrench className="h-4 w-4" /><span>{t('nav.skills')}</span></button>
        <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('session-search:open'))} className="flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-ink-soft transition-colors hover:bg-paper-2/70"><Search className="h-4 w-4" /><span className="truncate">{t('nav.searchPlaceholder')}</span></button>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-0.5"><SessionList sessions={sessions} activeSessionId={state.activeSessionId} openMenuId={controller.openMenuId} onMenuToggle={(id) => controller.setOpenMenuId(controller.openMenuId === id ? null : id)} onOpen={handleOpenSession} onArchiveToggle={handleArchiveToggle} onDelete={handleDelete} t={t} /></div>
      <AccountArea accountMenuOpen={controller.accountMenuOpen} accountMenuRef={controller.accountMenuRef} user={state.user} pendingApprovals={controller.pendingApprovals} onToggle={() => controller.setAccountMenuOpen((open) => !open)} onNavigate={controller.navigateItem} t={t} />
    </aside>
    {state.authMode !== 'local' && <LoginModal login={controller.login} onChange={controller.updateLogin} onClose={() => controller.updateLogin({ open: false, target: null })} onSendCode={controller.sendCode} onVerify={controller.verify} t={t} />}
  </>
}
