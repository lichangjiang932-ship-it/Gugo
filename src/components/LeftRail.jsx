import { useState, useMemo, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { MessageSquare, Wrench, Shield, History, Settings, Sparkles, ListChecks, X, Search } from 'lucide-react'
import { useAppContext } from '../store/AppContext'
import { getAuthToken, sendLoginCode, verifyLoginCode } from '../lib/accountClient.js'

function getSessionPreview(session) {
  const msgs = session?.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return ''
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    let text = ''
    if (typeof m?.content === 'string') text = m.content
    else if (Array.isArray(m?.content)) {
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

function isSessionUnread(session, activeId) {
  if (!session || session.id === activeId) return false
  if (!session.updatedAt || !session.lastViewedAt) return false
  return session.updatedAt > session.lastViewedAt
}

export default function LeftRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, dispatch } = useAppContext()
  const [showLogin, setShowLogin] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
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

  useEffect(() => {
    const onEsc = () => setSearchQuery('')
    window.addEventListener('app:escape', onEsc)
    return () => window.removeEventListener('app:escape', onEsc)
  }, [])

  const navItems = [
    { path: '/chat', icon: MessageSquare, label: '对话' },
    { path: '/task', icon: ListChecks, label: '任务' },
    { path: '/skills', icon: Wrench, label: '技能库' },
    { path: '/permissions', icon: Shield, label: '权限中心' },
    { path: '/history', icon: History, label: '历史' },
    { path: '/settings', icon: Settings, label: '设置', requiresLogin: true },
  ]

  const sessions = state.sessions
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const startOfWeek = startOfToday - ((new Date().getDay() + 6) % 7) * 86400000
  const todaySessions = sessions.filter((s) => s.createdAt >= startOfToday)
  const weekSessions = sessions.filter((s) => s.createdAt >= startOfWeek && s.createdAt < startOfToday)
  const earlierSessions = sessions.filter((s) => s.createdAt < startOfWeek)

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

  const handleNav = (item) => {
    if (item.requiresLogin && !getAuthToken()) {
      setShowLogin(true)
      setLoginMessage('请先登录账户')
      return
    }
    navigate(item.path)
  }

  const handleSendCode = async (event) => {
    event.preventDefault()
    setLoginLoading(true)
    setLoginMessage('')
    try {
      const result = await sendLoginCode(loginEmail)
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
      const data = await verifyLoginCode({ email: loginEmail, code: loginCode })
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
      <div className="mt-3">
        <span className="section-label px-2">{title}</span>
        <div className="flex flex-col gap-0.5 mt-1.5 stagger-children">
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
                  className={`flex-1 flex items-start gap-2 px-2.5 py-2 rounded-lg text-[13px] transition-all duration-200 min-w-0 ${
                    isActive
                      ? 'bg-paper-2/80 text-ink shadow-sm nav-active-indicator'
                      : 'text-ink-soft hover:bg-paper-2/40 hover:text-ink'
                  }`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 transition-colors ${
                    isActive ? 'bg-ember' : (unread ? 'bg-ember' : 'bg-ink-ghost/60')
                  }`} />
                  <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`truncate transition-all ${unread ? 'font-medium text-ink' : ''}`}>{s.title}</span>
                      {unread && (
                        <span className="shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-ember animate-pulse" />
                      )}
                    </div>
                    {preview && (
                      <span className="text-[11px] text-ink-fade truncate text-left leading-tight">{preview}</span>
                    )}
                  </div>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`删除会话"${s.title}"？`)) {
                      dispatch({ type: 'DELETE_SESSION', payload: s.id })
                    }
                  }}
                  title="删除会话"
                  className="opacity-0 group-hover:opacity-100 ml-1 p-1.5 rounded-md hover:bg-paper-2 text-ink-fade hover:text-ink transition-all duration-150 shrink-0"
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
      <aside className="w-[240px] h-full border-r border-ink-fade/20 flex flex-col gap-3 p-4 bg-paper/80 backdrop-blur-xl shrink-0 overflow-y-auto">
        {/* Brand */}
        <button onClick={() => navigate('/chat')} className="flex items-center gap-2.5 mb-1 group">
          <div className="w-8 h-8 rounded-xl border border-ink/80 flex items-center justify-center bg-paper shadow-sm group-hover:shadow-md group-hover:border-ember/60 transition-all duration-300">
            <Sparkles className="w-4 h-4 text-ember" />
          </div>
          <span className="font-display italic text-lg text-ink tracking-tight group-hover:tracking-normal transition-all duration-300">
            your model
          </span>
        </button>

        {/* New Chat Button */}
        <button
          onClick={handleNewChat}
          className="flex items-center justify-between h-10 px-4 border border-ink/60 rounded-xl bg-paper hover:bg-paper-2 hover:border-ink/80 hover:shadow-sm transition-all duration-200 group"
        >
          <span className="text-sm text-ink-soft group-hover:text-ink transition-colors">新对话</span>
          <span className="font-mono text-[10px] text-ink-fade tracking-wider group-hover:text-ember transition-colors">Ctrl N</span>
        </button>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-fade pointer-events-none" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话…"
            className="w-full h-9 pl-8 pr-8 border border-ink-fade/30 rounded-xl bg-paper/60 text-xs text-ink outline-none focus:border-ember/60 focus:bg-paper transition-all duration-200 placeholder:text-ink-fade/60"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-ink-fade/10 text-ink-fade transition-colors"
              title="清除搜索"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Navigation */}
        <div className="flex flex-col gap-0.5 mt-1">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path
            return (
              <button
                key={item.path}
                onClick={() => handleNav(item)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all duration-200 ${
                  isActive
                    ? 'bg-paper-2/80 text-ink shadow-sm font-medium nav-active-indicator'
                    : 'text-ink-soft hover:bg-paper-2/40 hover:text-ink'
                }`}
              >
                <item.icon className={`w-4 h-4 transition-colors ${isActive ? 'text-ember' : ''}`} />
                {item.label}
              </button>
            )
          })}
        </div>

        {/* Sessions */}
        <div className="flex-1 min-h-0 overflow-y-auto mt-1">
          {searchResults ? (
            searchResults.length ? (
              <div className="mt-2">
                <span className="section-label px-2">搜索结果 ({searchResults.length})</span>
                <div className="flex flex-col gap-0.5 mt-1.5 stagger-children">
                  {searchResults.map(({ session: s, snippet }) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        dispatch({ type: 'SWITCH_SESSION', payload: s.id })
                        navigate('/chat')
                      }}
                      className={`flex flex-col items-start gap-0.5 px-2.5 py-2 rounded-xl text-[13px] transition-all duration-200 min-w-0 text-left ${
                        s.id === state.activeSessionId
                          ? 'bg-paper-2/80 text-ink shadow-sm nav-active-indicator'
                          : 'text-ink-soft hover:bg-paper-2/40'
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
              <div className="mt-6 px-2 py-6 text-center">
                <p className="text-xs text-ink-fade">未找到匹配会话</p>
              </div>
            )
          ) : sessions.length ? (
            <>
              {renderSessionGroup('今天', todaySessions)}
              {renderSessionGroup('本周', weekSessions)}
              {renderSessionGroup('更早', earlierSessions)}
            </>
          ) : (
            <div className="mt-6 px-4 py-8 border border-dashed border-ink-fade/30 rounded-xl text-center bg-paper-2/20">
              <p className="text-xs text-ink-fade">还没有对话</p>
              <p className="text-[10px] text-ink-ghost mt-1.5">点击"新对话"开始</p>
            </div>
          )}
        </div>

        {/* User */}
        <div className="border-t border-ink-fade/15 pt-3 mt-auto">
          <div className="flex items-center gap-2.5 px-1">
            <div className="w-7 h-7 rounded-full border border-ink/60 flex items-center justify-center bg-paper-2 shrink-0 shadow-sm">
              <span className="font-hand text-[11px] text-ink">{state.user.avatar || '本'}</span>
            </div>
            <div className="leading-tight flex-1 min-w-0">
              <span className="text-xs text-ink truncate block font-medium">{state.user.name || '本地工作台'}</span>
              <span className="font-mono text-[8px] tracking-[0.15em] text-ink-fade/70">LOCAL AI WORKBENCH</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Login Modal */}
      <AnimatePresence>
        {showLogin && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-ink/35 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.96 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="w-full max-w-md bg-paper border border-ink/20 rounded-2xl p-6 flex flex-col gap-4 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="section-label">LOGIN REQUIRED</span>
                  <h2 className="font-hand text-2xl text-ink mt-1">登录账户</h2>
                </div>
                <button onClick={() => setShowLogin(false)} className="text-ink-fade hover:text-ink p-1 rounded-lg hover:bg-paper-2 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleSendCode} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-fade font-medium">邮箱</span>
                  <input
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="h-10 px-4 border border-ink/30 rounded-xl bg-paper outline-none focus:border-ember/60 focus:ring-2 focus:ring-ember/10 transition-all text-sm text-ink"
                  />
                </label>
                <button
                  disabled={loginLoading || !loginEmail.trim()}
                  className="h-10 px-5 bg-ink text-paper rounded-xl text-sm hover:bg-ink-soft transition-colors self-start disabled:opacity-40 font-medium"
                >
                  发送验证码
                </button>
              </form>

              <form onSubmit={handleVerify} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs text-ink-fade font-medium">验证码</span>
                  <input
                    value={loginCode}
                    onChange={(e) => setLoginCode(e.target.value)}
                    placeholder="6 位数字"
                    className="h-10 px-4 border border-ink/30 rounded-xl bg-paper outline-none focus:border-ember/60 focus:ring-2 focus:ring-ember/10 transition-all text-sm text-ink"
                  />
                </label>
                <button
                  disabled={loginLoading || !loginEmail.trim() || !loginCode.trim()}
                  className="h-10 px-5 bg-ember text-paper rounded-xl text-sm hover:bg-ember/90 transition-colors self-start disabled:opacity-40 font-medium"
                >
                  登录并进入设置
                </button>
              </form>

              {loginMessage && (
                <div className="p-3 border border-ink-fade/30 rounded-xl text-sm text-ink-soft bg-paper-2/60">
                  {loginMessage}
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
