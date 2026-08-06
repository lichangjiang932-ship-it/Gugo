import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from '../lib/router.jsx'
import { Archive, ArchiveRestore, ChevronUp, Link2, MoreHorizontal, Plus, Search, Settings, Wrench, X } from 'lucide-react'
import { useAppContext } from '../store/AppContext'
import {
  LOGIN_CODE_COUNTDOWN_SECONDS,
  formatLoginCodeCountdownLabel,
  shouldDisableLoginCodeButton,
} from '../lib/loginCountdown.js'
import { getAuthToken, loginWithPassword, sendLoginCode, verifyLoginCode } from '../lib/accountClient.js'
import { settingsPathAfterLogin } from '../lib/settingsNavigation.js'
import { archiveSessionRemote, unarchiveSessionRemote } from '../lib/sessionClient.js'
import { useT } from '../i18n/I18nProvider.jsx'
import { useToast } from './Toast.jsx'
import BrandMark from './BrandMark.jsx'
import { fetchPendingCount } from '../lib/approvalClient.js'
import DesktopUpdateCard from './DesktopUpdateCard.jsx'

export default function LeftRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, dispatch } = useAppContext()
  const { t } = useT()
  const toast = useToast()
  const [showLogin, setShowLogin] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginMode, setLoginMode] = useState('password')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginCodeCountdown, setLoginCodeCountdown] = useState(0)
  const [loginTarget, setLoginTarget] = useState(null)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef(null)

  // ★ #25: 监听全局 Esc 清空搜索框 (preview 不开时才会派发)
  useEffect(() => {
    const onEsc = () => {
      setOpenMenuId(null)
      setAccountMenuOpen(false)
    }
    window.addEventListener('app:escape', onEsc)
    return () => window.removeEventListener('app:escape', onEsc)
  }, [])

  useEffect(() => {
    if (!accountMenuOpen) return undefined
    const closeOutside = (event) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target)) {
        setAccountMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', closeOutside)
    return () => document.removeEventListener('mousedown', closeOutside)
  }, [accountMenuOpen])

  useEffect(() => {
    const openLogin = (event) => {
      if (state.authMode === 'local') return
      setLoginTarget(event.detail?.path || null)
      setLoginMessage(event.detail?.message || '请先登录账户')
      setShowLogin(true)
    }
    window.addEventListener('auth:required', openLogin)
    return () => window.removeEventListener('auth:required', openLogin)
  }, [state.authMode])

  useEffect(() => {
    if (loginCodeCountdown <= 0) return undefined
    const timer = window.setInterval(() => {
      setLoginCodeCountdown((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [loginCodeCountdown])

  // 待审批数角标:登录后拉一次,并订阅 SSE 增量刷新(SSE 不可用则退化为静态)
  const [pendingApprovals, setPendingApprovals] = useState(0)
  useEffect(() => {
    let alive = true
    if (!getAuthToken()) {
      // 未登录:异步清零,避免在 effect 体里同步 setState 触发级联渲染
      Promise.resolve().then(() => { if (alive) setPendingApprovals(0) })
      return () => { alive = false }
    }
    const refresh = () => {
      fetchPendingCount()
        .then((count) => { if (alive) setPendingApprovals(count) })
        .catch(() => { /* 角标失败不该打断导航 */ })
    }
    refresh()
    let source
    try {
      source = new EventSource('/api/approvals/stream')
      source.addEventListener('approval', refresh)
    } catch {
      /* 环境不支持 SSE 时忽略 */
    }
    return () => {
      alive = false
      try { source?.close() } catch { /* noop */ }
    }
  }, [location.pathname])

  const sessions = state.sessions.filter((session) => !session.archivedAt)

  const handleNewChat = () => {
    dispatch({ type: 'START_NEW_DRAFT' })
    navigate('/chat')
  }

  const handleNav = (item) => {
    setAccountMenuOpen(false)
    if (item.requiresLogin && !getAuthToken() && state.authMode !== 'local') {
      setLoginTarget(item.path)
      setShowLogin(true)
      setLoginMessage('请先登录账户')
      return
    }
    navigate(item.path)
  }

  const openSearch = () => {
    window.dispatchEvent(new CustomEvent('session-search:open'))
  }

  const handleArchiveToggle = async (session) => {
    setOpenMenuId(null)
    const archived = !!session.archivedAt
    dispatch({ type: archived ? 'UNARCHIVE_SESSION' : 'ARCHIVE_SESSION', payload: session.id })
    if (!getAuthToken()) return
    try {
      const result = archived
        ? await unarchiveSessionRemote(session.id)
        : await archiveSessionRemote(session.id)
      if (result?.session) {
        dispatch({
          type: 'APPLY_SERVER_SESSION_METADATA',
          payload: { sessionId: session.id, session: result.session },
        })
      }
    } catch (error) {
      if (/session not found/i.test(error.message || '')) return
      dispatch({ type: archived ? 'ARCHIVE_SESSION' : 'UNARCHIVE_SESSION', payload: session.id })
      toast.error({ title: t('errors.saveFailed'), body: error.message })
    }
  }

  const handleSendCode = async (event) => {
    event.preventDefault()
    if (loginCodeCountdown > 0) return
    setLoginLoading(true)
    setLoginMessage('')
    try {
      const result = await sendLoginCode(loginEmail)
      setLoginCodeCountdown(LOGIN_CODE_COUNTDOWN_SECONDS)
      setLoginMessage(result.devCode ? `验证码：${result.devCode}` : '验证码已发送，请查看邮箱。')
    } catch (error) {
      setLoginMessage(error.message)
      toast.error({ title: t('toast.sendCodeFailed'), body: error.message })
    } finally {
      setLoginLoading(false)
    }
  }

  const handleVerify = async (event) => {
    event.preventDefault()
    setLoginLoading(true)
    setLoginMessage('')
    try {
      const data = loginMode === 'password'
        ? await loginWithPassword({ email: loginEmail, password: loginPassword })
        : await verifyLoginCode({ email: loginEmail, code: loginCode })
      dispatch({
        type: 'LOGIN',
        payload: {
          name: data.user.email.split('@')[0],
          email: data.user.email,
          avatar: '本',
        },
      })
      setShowLogin(false)
      setLoginCode('')
      setLoginPassword('')
      setLoginMessage('')
      const defaultPath = settingsPathAfterLogin(data.user)
      navigate(data.user.hasPassword === false ? defaultPath : (loginTarget || defaultPath))
      setLoginTarget(null)
    } catch (error) {
      setLoginMessage(error.message)
      toast.error({ title: t('toast.loginFailed'), body: error.message })
    } finally {
      setLoginLoading(false)
    }
  }

  const renderSessions = (items) => {
    if (!items.length) return null
    return (
      <div className="flex flex-col gap-0.5">
          {items.map((s, i) => {
            const isActive = s.id === state.activeSessionId
            return (
            <div key={s.id ?? i} className="group relative flex items-center">
              <button
                onClick={() => {
                  dispatch({ type: 'SWITCH_SESSION', payload: s.id })
                  navigate('/chat')
                }}
                className={`flex h-8 min-w-0 flex-1 items-center rounded-md px-2 text-left text-[13px] transition-colors ${
                  isActive ? 'bg-paper-2 text-ink' : 'text-ink-soft hover:bg-paper-2/60'
                }`}
              >
                <span className="truncate">{s.title}</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenMenuId(openMenuId === s.id ? null : s.id)
                }}
                title={t('nav.sessionMenu')}
                className="absolute right-1 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-paper text-ink-fade hover:text-ink transition-opacity shrink-0"
              >
                <MoreHorizontal className="w-3 h-3" />
              </button>
              {openMenuId === s.id && (
                <div className="absolute right-0 top-7 z-20 min-w-32 bg-paper border border-ink-fade/40 rounded-md shadow-lg p-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleArchiveToggle(s)
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-ink-soft hover:bg-paper-2"
                  >
                    {s.archivedAt ? <ArchiveRestore className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
                    {s.archivedAt ? t('nav.unarchiveSession') : t('nav.archiveSession')}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenMenuId(null)
                      if (confirm(t('nav.confirmDeleteSession', { title: s.title }))) {
                        dispatch({ type: 'DELETE_SESSION', payload: s.id })
                      }
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-ink-soft hover:bg-paper-2"
                  >
                    <X className="w-3 h-3" />
                    {t('nav.deleteSession')}
                  </button>
                </div>
              )}
            </div>
            )
          })}
      </div>
    )
  }

  return (
    <>
      <aside role="navigation" aria-label="主导航" className="flex h-full w-[248px] shrink-0 flex-col border-r border-ink/10 bg-paper p-3">
        <div className="flex h-10 items-center px-1.5">
          <button onClick={() => navigate('/chat')} aria-label="回到首页" className="flex items-center gap-2">
            <BrandMark className="h-7 w-7 text-ember" />
            <span className="font-display italic text-lg text-ink">Gugo</span>
          </button>
        </div>

        <div className="mt-2 flex flex-col gap-0.5">
          <button onClick={handleNewChat} className="flex h-9 items-center gap-2.5 rounded-lg bg-ink px-3 text-sm text-paper transition-colors hover:bg-ink-soft">
            <Plus className="h-4 w-4" />
            <span>{t('nav.newChat')}</span>
          </button>
          <button
            type="button"
            onClick={() => handleNav({ path: '/skills' })}
            className={`flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors ${location.pathname === '/skills' ? 'bg-paper-2 text-ink' : 'text-ink-soft hover:bg-paper-2/70'}`}
          >
            <Wrench className="h-4 w-4" />
            <span>{t('nav.skills')}</span>
          </button>
          <button type="button" onClick={openSearch} className="flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm text-ink-soft transition-colors hover:bg-paper-2/70">
            <Search className="h-4 w-4" />
            <span className="truncate">{t('nav.searchPlaceholder')}</span>
          </button>
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-0.5">
          {sessions.length ? renderSessions(sessions) : (
            <div className="px-3 py-8 text-center">
              <p className="text-xs text-ink-fade">{t('nav.emptyTitle')}</p>
              <p className="mt-1 text-[10px] text-ink-ghost">{t('nav.emptyHint')}</p>
            </div>
          )}
        </div>

        <div ref={accountMenuRef} className="relative border-t border-ink/10 pt-2">
          {accountMenuOpen && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-ink/15 bg-paper p-1.5 shadow-xl">
              <button type="button" onClick={() => handleNav({ path: '/access', requiresLogin: true })} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-paper-2">
                <Link2 className="h-4 w-4" />
                <span>{t('access.title')}</span>
              </button>
              <button type="button" onClick={() => handleNav({ path: '/settings', requiresLogin: true })} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-paper-2">
                <Settings className="h-4 w-4" />
                <span className="flex-1 text-left">{t('nav.settings')}</span>
                {pendingApprovals > 0 && <span className="rounded-full bg-ember px-1.5 text-[10px] text-paper">{pendingApprovals > 99 ? '99+' : pendingApprovals}</span>}
              </button>
              <button type="button" onClick={() => handleNav({ path: '/skills' })} className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-paper-2">
                <Wrench className="h-4 w-4" />
                <span>{t('nav.skills')}</span>
              </button>
            </div>
          )}
          <DesktopUpdateCard />
          <button type="button" onClick={() => setAccountMenuOpen((open) => !open)} aria-expanded={accountMenuOpen} className="flex h-12 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-paper-2">
            <BrandMark className="h-8 w-8 shrink-0 text-ember" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{state.user.name || t('settings.account')}</span>
              {state.user.email && <span className="block truncate text-[10px] text-ink-fade">{state.user.email}</span>}
            </span>
            <ChevronUp className={`h-4 w-4 text-ink-fade transition-transform ${accountMenuOpen ? '' : 'rotate-180'}`} />
          </button>
        </div>
      </aside>

      {showLogin && state.authMode !== 'local' && (
        <div className="fixed inset-0 z-50 bg-ink/35 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-paper border border-ink rounded-md p-5 flex flex-col gap-4 shadow-xl">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">LOGIN REQUIRED</span>
                <h2 className="font-hand text-xl text-ink mt-1">登录账户</h2>
              </div>
              <button onClick={() => { setShowLogin(false); setLoginTarget(null) }} className="text-ink-fade hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex gap-2 border-b border-ink-fade/30 -mt-1">
              <button
                type="button"
                onClick={() => { setLoginMode('password'); setLoginMessage('') }}
                className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${loginMode === 'password' ? 'border-ember text-ink' : 'border-transparent text-ink-fade hover:text-ink-soft'}`}
              >
                密码登录
              </button>
              <button
                type="button"
                onClick={() => { setLoginMode('code'); setLoginMessage('') }}
                className={`px-3 py-1.5 text-sm border-b-2 transition-colors ${loginMode === 'code' ? 'border-ember text-ink' : 'border-transparent text-ink-fade hover:text-ink-soft'}`}
              >
                邮件验证码
              </button>
            </div>

            {loginMode === 'code' ? (
              <form onSubmit={handleSendCode} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-ink-fade">邮箱</span>
                  <input
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink"
                  />
                </label>
                <button
                  disabled={shouldDisableLoginCodeButton({
                    accountLoading: loginLoading,
                    loginEmail,
                    countdown: loginCodeCountdown,
                  })}
                  className="h-9 px-4 bg-ink text-paper rounded-md text-sm hover:bg-ink-soft transition-colors self-start disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {formatLoginCodeCountdownLabel(loginCodeCountdown)}
                </button>
              </form>
            ) : null}

            <form onSubmit={handleVerify} className="flex flex-col gap-3">
              {loginMode === 'password' ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-ink-fade">邮箱</span>
                  <input
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink"
                  />
                </label>
              ) : null}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-fade">{loginMode === 'password' ? '密码' : '验证码'}</span>
                {loginMode === 'password' ? (
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="输入密码"
                    autoComplete="current-password"
                    className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink"
                  />
                ) : (
                  <input
                    value={loginCode}
                    onChange={(e) => setLoginCode(e.target.value)}
                    placeholder="6 位数字"
                    className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink"
                  />
                )}
              </label>
              <button
                disabled={loginLoading || !loginEmail.trim() || (loginMode === 'password' ? !loginPassword : !loginCode.trim())}
                className="h-9 px-4 bg-ember text-paper rounded-md text-sm hover:bg-ember/90 transition-colors self-start disabled:opacity-50"
              >
                登录并进入设置
              </button>
            </form>

            {loginMessage && (
              <div className="p-3 border border-ink-fade/40 rounded-md text-sm text-ink-soft bg-paper-2">
                {loginMessage}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
