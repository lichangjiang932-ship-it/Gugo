import { useState, useMemo, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, Sparkles, X, Search } from 'lucide-react'
import { useAppContext } from '../store/AppContext'
import {
  LOGIN_CODE_COUNTDOWN_SECONDS,
  formatLoginCodeCountdownLabel,
  shouldDisableLoginCodeButton,
} from '../lib/loginCountdown.js'
import { loginWithPassword, sendLoginCode, verifyLoginCode } from '../lib/accountClient.js'
import { useT } from '../i18n/I18nProvider.jsx'

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

export default function LeftRail({ onOpenSettings } = {}) {
  const navigate = useNavigate()
  // P0: location 不再需要（原用于 nav active 检查）。
  const { state, dispatch } = useAppContext()
  const { t } = useT()
  const [showLogin, setShowLogin] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginMode, setLoginMode] = useState('password')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginCodeCountdown, setLoginCodeCountdown] = useState(0)
  // ★ #13: 全局会话搜索 — 标题 + 消息内容
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const searchTimerRef = useRef(null)

  useEffect(() => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current)
    searchTimerRef.current = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery)
    }, 150)
    return () => {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current)
    }
  }, [searchQuery])

  // ★ #25: 监听全局 Esc 清空搜索框 (preview 不开时才会派发)
  useEffect(() => {
    const onEsc = () => setSearchQuery('')
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

  // P0 重做: 顶部 nav tabs 全部收进“设置抽屉”。
  // 原 navItems / handleNav 已移除。路由仍然可通过 SettingsDrawer / 直接 URL 进入。

  const sessions = state.sessions
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const startOfWeek = startOfToday - ((new Date().getDay() + 6) % 7) * 86400000
  const todaySessions = sessions.filter((s) => s.createdAt >= startOfToday)
  const weekSessions = sessions.filter((s) => s.createdAt >= startOfWeek && s.createdAt < startOfToday)
  const earlierSessions = sessions.filter((s) => s.createdAt < startOfWeek)

  // ★ #13: 搜索结果 — 标题命中 OR 任一消息 content 命中
  const searchTrim = debouncedSearchQuery.trim().toLowerCase()
  const searchResults = useMemo(() => {
    if (!searchTrim) return null
    return sessions
      .map((s) => {
        const titleHit = String(s.title || '').toLowerCase().includes(searchTrim)
        let snippet = null
        if (Array.isArray(s.messages)) {
          for (const m of s.messages) {
            const c = String(m.content || '')
            const idx = c.toLowerCase().indexOf(searchTrim)
            if (idx >= 0) {
              snippet = c.slice(Math.max(0, idx - 20), idx + searchTrim.length + 30)
              break
            }
          }
        }
        if (!titleHit && !snippet) return null
        return { session: s, snippet }
      })
      .filter(Boolean)
      .slice(0, 50)
  }, [sessions, searchTrim])

  const handleNewChat = () => {
    dispatch({ type: 'NEW_SESSION', payload: '新对话' })
    navigate('/chat')
  }

  // P0: handleNav 与 navItems 数据已移除；navigate 仍保留给 search 跳转。

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
    } finally {
      setLoginLoading(false)
    }
  }

  const renderSessionGroup = (title, items) => {
    if (!items.length) return null
    return (
      <div className="mt-2">
        <span
          style={{
            fontSize: 11,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--p0-text-secondary)',
            padding: '0 4px',
          }}
        >{title}</span>
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
                className="flex-1 flex items-start gap-2 px-2 py-1.5 transition-colors min-w-0 text-left"
                style={{
                  borderRadius: 'var(--p0-radius-btn)',
                  fontSize: 13,
                  background: isActive ? 'var(--p0-accent-soft)' : 'transparent',
                  color: isActive ? 'var(--p0-text-primary)' : 'var(--p0-text-secondary)',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--p0-accent-soft)' }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
              >
                {/* ★ #22: 未读用 accent 实心点;已读 ghost 点;当前会话 accent */}
                <div
                  className="shrink-0 mt-1.5"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: isActive ? 'var(--p0-accent)' : (unread ? 'var(--p0-accent)' : 'var(--p0-border-strong)'),
                  }}
                />
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="truncate"
                      style={{
                        fontWeight: unread ? 500 : 400,
                        color: isActive || unread ? 'var(--p0-text-primary)' : 'var(--p0-text-primary)',
                      }}
                    >{s.title}</span>
                    {unread && (
                      <span
                        title="有新消息"
                        className="shrink-0 inline-block"
                        style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--p0-accent)' }}
                      />
                    )}
                  </div>
                  {preview && (
                    <span
                      className="truncate text-left"
                      style={{ fontSize: 11, color: 'var(--p0-text-tertiary)' }}
                    >{preview}</span>
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
                className="opacity-0 group-hover:opacity-100 ml-1 p-1 transition-opacity shrink-0"
                style={{ borderRadius: 'var(--p0-radius-btn)', color: 'var(--p0-text-tertiary)' }}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <>
      <aside role="navigation" aria-label="主导航" className="w-[240px] h-full flex flex-col gap-3 p-4 shrink-0 overflow-y-auto" style={{ background: 'var(--p0-card)', borderRight: '1px solid var(--p0-border)', fontFamily: 'var(--p0-font-sans)' }}>
        <button onClick={() => navigate('/chat')} aria-label="回到首页" className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ border: '1px solid var(--p0-border-strong)', background: 'var(--p0-card)' }}>
            <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--p0-accent)' }} />
          </div>
          <span style={{ fontSize: 15, fontWeight: 500, color: 'var(--p0-text-primary)' }}>your model</span>
        </button>

        <button
          onClick={handleNewChat}
          className="flex items-center justify-between h-10 px-3 transition-colors"
          style={{
            background: 'var(--p0-card)',
            border: '1px solid var(--p0-border)',
            borderRadius: 'var(--p0-radius-card)',
            color: 'var(--p0-accent)',
            fontSize: 13,
            fontWeight: 500,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--p0-accent-soft)'; e.currentTarget.style.borderColor = 'var(--p0-accent-line)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--p0-card)'; e.currentTarget.style.borderColor = 'var(--p0-border)' }}
        >
          <span className="inline-flex items-center gap-1.5">
            <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
            {t('nav.newChat')}
          </span>
        </button>

        {/* ★ #13: 全局搜索 */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none" style={{ color: 'var(--p0-text-tertiary)' }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('nav.searchPlaceholder')}
            className="w-full h-8 pl-7 pr-7 outline-none"
            style={{
              background: 'var(--p0-card)',
              border: '1px solid var(--p0-border)',
              borderRadius: 'var(--p0-radius-btn)',
              fontSize: 12,
              color: 'var(--p0-text-primary)',
            }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded"
              style={{ color: 'var(--p0-text-tertiary)' }}
              title="清除搜索"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* P0 重做: 顶部 nav tabs 已收纳到“设置抽屉”(齿轮按钮)。 */}

        {searchResults ? (
          searchResults.length ? (
            <div className="mt-2">
              <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">
                {t('nav.searchResults')} ({searchResults.length})
              </span>
              <div className="flex flex-col gap-0.5 mt-1.5">
                {searchResults.map(({ session: s, snippet }) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      dispatch({ type: 'SWITCH_SESSION', payload: s.id })
                      navigate('/chat')
                    }}
                    className={`flex flex-col items-start gap-0.5 px-2 py-1.5 rounded-md text-[13px] transition-colors min-w-0 text-left ${
                      s.id === state.activeSessionId ? 'bg-paper-2 border border-ink-fade/40 text-ink' : 'text-ink-soft hover:bg-paper-2/50'
                    }`}
                  >
                    <span className="truncate w-full">{s.title}</span>
                    {snippet && (
                      <span className="text-[10px] text-ink-fade truncate w-full">…{snippet}…</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-4 px-2 py-4 text-center">
              <p className="text-xs text-ink-fade">{t('nav.searchNoMatch')}</p>
            </div>
          )
        ) : sessions.length ? (
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

        {/* P0 footer: 用户区 + 齿轮入口 */}
        <div className="pt-3 flex items-center gap-2" style={{ borderTop: '1px solid var(--p0-border)' }}>
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
              style={{ border: '1px solid var(--p0-border-strong)', background: 'var(--p0-card)' }}
            >
              <span style={{ fontSize: 11, color: 'var(--p0-text-primary)' }}>{state.user.avatar || '本'}</span>
            </div>
            <div className="leading-tight flex-1 min-w-0">
              <span className="truncate block" style={{ fontSize: 12, color: 'var(--p0-text-primary)' }}>{state.user.name || '本地工作台'}</span>
              <span style={{ fontFamily: 'var(--p0-font-mono)', fontSize: 9, letterSpacing: '0.08em', color: 'var(--p0-text-tertiary)' }}>LOCAL AI WORKBENCH</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenSettings?.()}
            aria-label="打开设置"
            title="设置"
            className="w-7 h-7 inline-flex items-center justify-center transition-colors"
            style={{ borderRadius: 'var(--p0-radius-btn)', color: 'var(--p0-text-secondary)' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--p0-accent-soft)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
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
