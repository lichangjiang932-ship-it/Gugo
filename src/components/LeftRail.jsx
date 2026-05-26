import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { MessageSquare, Wrench, Shield, History, Settings, Sparkles, ListChecks, X, Search, BookOpen, Webhook, Plug, Users, MoreHorizontal, Archive, ArchiveRestore, CalendarClock } from 'lucide-react'
import { useAppContext } from '../store/AppContext'
import {
  LOGIN_CODE_COUNTDOWN_SECONDS,
  formatLoginCodeCountdownLabel,
  shouldDisableLoginCodeButton,
} from '../lib/loginCountdown.js'
import { getAuthToken, loginWithPassword, sendLoginCode, verifyLoginCode } from '../lib/accountClient.js'
import { archiveSessionRemote, unarchiveSessionRemote } from '../lib/sessionClient.js'
import { useT } from '../i18n/I18nProvider.jsx'
import { useToast } from './Toast.jsx'

// ★ #21: 提取会话最后消息的纯文本预览 (剥 markdown / 多模态 array / 工具卡)
function getSessionPreview(session) {
  const msgs = session?.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return ''
  // 从尾向前找第一条有可视文本的消息 (跳过 tool_call / 纯 meta 卡)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    let text = ''
    if (typeof m?.content === 'string') text = m.content
    else if (Array.isArray(m?.content)) {
      // multimodal: 取所有 text 段
      text = m.content
        .filter((p) => p?.type === 'text' || typeof p?.text === 'string')
        .map((p) => p.text || '')
        .join(' ')
    }
    text = text.replace(/```[\s\S]*?```/g, '〔代码〕').replace(/[#*`>_~|]+/g, '').replace(/\s+/g, ' ').trim()
    if (text) {
      const prefix = m.role === 'user' ? '你: ' : (m.role === 'assistant' ? '' : '')
      return prefix + text.slice(0, 60)
    }
  }
  return ''
}

// ★ #22: 是否未读 — updatedAt > lastViewedAt 且不是当前会话
function isSessionUnread(session, activeId) {
  if (!session || session.id === activeId) return false
  if (!session.updatedAt) return false
  if (!session.lastViewedAt) return false  // 老数据无标记,不显示未读
  return session.updatedAt > session.lastViewedAt
}

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
  const [sessionFilter, setSessionFilter] = useState('active')
  const [openMenuId, setOpenMenuId] = useState(null)

  // ★ #25: 监听全局 Esc 清空搜索框 (preview 不开时才会派发)
  useEffect(() => {
    const onEsc = () => setOpenMenuId(null)
    window.addEventListener('app:escape', onEsc)
    return () => window.removeEventListener('app:escape', onEsc)
  }, [])

  useEffect(() => {
    if (loginCodeCountdown <= 0) return undefined
    const timer = window.setInterval(() => {
      setLoginCodeCountdown((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [loginCodeCountdown])

  const navItems = [
    { path: '/', icon: Sparkles, label: t('nav.home') },
    { path: '/chat', icon: MessageSquare, label: t('nav.chat') },
    { path: '/task', icon: ListChecks, label: t('nav.task') },
    { path: '/skills', icon: Wrench, label: t('nav.skills') },
    { path: '/permissions', icon: Shield, label: t('nav.permissions') },
    { path: '/memory', icon: BookOpen, label: t('nav.memory'), requiresLogin: true },
    { path: '/agents', icon: Users, label: t('nav.agents'), requiresLogin: true },
    { path: '/mcp', icon: Plug, label: t('nav.mcp'), requiresLogin: true },
    { path: '/hooks', icon: Webhook, label: t('nav.hooks'), requiresLogin: true },
    { path: '/cron', icon: CalendarClock, label: t('nav.cron'), requiresLogin: true },
    { path: '/history', icon: History, label: t('nav.history') },
    { path: '/settings', icon: Settings, label: t('nav.settings'), requiresLogin: true },
  ]

  const sessions = state.sessions.filter((session) => {
    if (sessionFilter === 'archived') return !!session.archivedAt
    if (sessionFilter === 'all') return true
    return !session.archivedAt
  })
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const startOfWeek = startOfToday - ((new Date().getDay() + 6) % 7) * 86400000
  const todaySessions = sessions.filter((s) => s.createdAt >= startOfToday)
  const weekSessions = sessions.filter((s) => s.createdAt >= startOfWeek && s.createdAt < startOfToday)
  const earlierSessions = sessions.filter((s) => s.createdAt < startOfWeek)

  const handleNewChat = () => {
    dispatch({ type: 'NEW_SESSION', payload: '新对话' })
    navigate('/chat')
  }

  const handleNav = (item) => {
    if (item.requiresLogin && !getAuthToken()) {
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
      if (archived) await unarchiveSessionRemote(session.id)
      else await archiveSessionRemote(session.id)
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
          plan: `${data.user.credits} 积分`,
        },
      })
      setShowLogin(false)
      setLoginCode('')
      setLoginPassword('')
      setLoginMessage('')
      navigate('/settings')
    } catch (error) {
      setLoginMessage(error.message)
      toast.error({ title: t('toast.loginFailed'), body: error.message })
    } finally {
      setLoginLoading(false)
    }
  }

  const renderSessionGroup = (title, items) => {
    if (!items.length) return null
    return (
      <div className="mt-2">
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{title}</span>
        <div className="flex flex-col gap-0.5 mt-1.5">
          {items.map((s, i) => {
            const preview = getSessionPreview(s)
            const unread = isSessionUnread(s, state.activeSessionId)
            const isActive = s.id === state.activeSessionId
            return (
            <div key={s.id ?? i} className="group relative flex items-center">
              <button
                onClick={() => {
                  dispatch({ type: 'SWITCH_SESSION', payload: s.id })
                  navigate('/chat')
                }}
                className={`flex-1 flex items-start gap-2 px-2 py-1.5 rounded-md text-[13px] transition-colors min-w-0 ${
                  isActive ? 'bg-paper-2 border border-ink-fade/40 text-ink' : 'text-ink-soft hover:bg-paper-2/50'
                }`}
              >
                {/* ★ #22: 未读用 ember 实心点;已读 ghost 点;当前会话 ember */}
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${
                  isActive ? 'bg-ember' : (unread ? 'bg-ember' : 'bg-ink-ghost')
                }`} />
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className={`truncate ${unread ? 'font-medium text-ink' : ''}`}>{s.title}</span>
                    {unread && (
                      <span
                        title="有新消息"
                        className="shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-ember"
                      />
                    )}
                  </div>
                  {preview && (
                    <span className="text-[11px] text-ink-fade truncate text-left">{preview}</span>
                  )}
                </div>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`删除会话“${s.title}”？`)) {
                    dispatch({ type: 'DELETE_SESSION', payload: s.id })
                  }
                }}
                title="删除会话"
                className="opacity-0 group-hover:opacity-100 ml-1 p-1 rounded hover:bg-paper-2 text-ink-fade hover:text-ink transition-opacity shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenMenuId(openMenuId === s.id ? null : s.id)
                }}
                title={t('nav.sessionMenu')}
                className="opacity-0 group-hover:opacity-100 ml-1 p-1 rounded hover:bg-paper-2 text-ink-fade hover:text-ink transition-opacity shrink-0"
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
                </div>
              )}
            </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <>
      <aside role="navigation" aria-label="主导航" className="w-[240px] h-full border-r border-dashed border-ink-fade/50 flex flex-col gap-3 p-4 bg-paper shrink-0 overflow-y-auto">
        <button onClick={() => navigate('/chat')} aria-label="回到首页" className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-full border border-ink flex items-center justify-center bg-paper">
            <Sparkles className="w-3.5 h-3.5 text-ember" />
          </div>
          <span className="font-display italic text-lg text-ink">your model</span>
        </button>

        <button
          onClick={handleNewChat}
          className="flex items-center justify-between h-9 px-3 border border-ink/80 rounded-md bg-paper hover:bg-paper-2 transition-colors"
        >
          <span className="text-sm text-ink-soft">{t('nav.newChat')}</span>
          <span className="font-mono text-[10px] text-ink-fade tracking-wider">Ctrl N</span>
        </button>

        <button
          type="button"
          onClick={openSearch}
          className="flex items-center justify-between h-8 px-2.5 border border-ink-fade/40 rounded-md bg-paper text-xs text-ink-soft hover:bg-paper-2 transition-colors"
        >
          <span className="inline-flex items-center gap-2 min-w-0">
            <Search className="w-3.5 h-3.5 text-ink-fade" />
            <span className="truncate">{t('nav.searchPlaceholder')}</span>
          </span>
          <span className="font-mono text-[10px] text-ink-fade">Ctrl K</span>
        </button>

        <div className="flex flex-col gap-0.5 mt-1">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path
            return (
              <button
                key={item.path}
                onClick={() => handleNav(item)}
                className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-paper-2 border border-ink-fade/50 text-ink'
                    : 'text-ink-soft hover:bg-paper-2/60'
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </button>
            )
          })}
        </div>

        <div className="grid grid-cols-3 gap-1">
          {[
            ['active', t('nav.filterActive')],
            ['archived', t('nav.filterArchived')],
            ['all', t('nav.filterAll')],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSessionFilter(key)}
              className={`h-7 rounded-md text-[11px] transition-colors ${
                sessionFilter === key
                  ? 'bg-paper-2 border border-ink-fade/50 text-ink'
                  : 'border border-transparent text-ink-fade hover:bg-paper-2/60 hover:text-ink-soft'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {sessions.length ? (
          <>
            {renderSessionGroup(t('nav.groupToday'), todaySessions)}
            {renderSessionGroup(t('nav.groupWeek'), weekSessions)}
            {renderSessionGroup(t('nav.groupEarlier'), earlierSessions)}
          </>
        ) : (
          <div className="mt-4 px-2 py-6 border border-dashed border-ink-fade/40 rounded-md text-center">
            <p className="text-xs text-ink-fade">{t('nav.emptyTitle')}</p>
            <p className="text-[10px] text-ink-ghost mt-1">{t('nav.emptyHint')}</p>
          </div>
        )}

        <div className="flex-1" />

        <div className="border-t border-dashed border-ink-fade/50 pt-3">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-full border border-ink flex items-center justify-center bg-paper shrink-0">
              <span className="font-hand text-xs text-ink">{state.user.avatar || '本'}</span>
            </div>
            <div className="leading-tight flex-1 min-w-0">
              <span className="text-xs text-ink truncate block">{state.user.name || '本地工作台'}</span>
              <span className="font-mono text-[9px] tracking-wider text-ink-fade">LOCAL AI WORKBENCH</span>
            </div>
          </div>
        </div>
      </aside>

      {showLogin && (
        <div className="fixed inset-0 z-50 bg-ink/35 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-paper border border-ink rounded-md p-5 flex flex-col gap-4 shadow-xl">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">LOGIN REQUIRED</span>
                <h2 className="font-hand text-xl text-ink mt-1">登录账户</h2>
              </div>
              <button onClick={() => setShowLogin(false)} className="text-ink-fade hover:text-ink">
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
