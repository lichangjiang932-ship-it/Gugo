import { useState, useMemo, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { MessageSquare, Wrench, Shield, History, Settings, Sparkles, ListChecks, X, Search } from 'lucide-react'
import { useAppContext } from '../store/AppContext'
import { getAuthToken, sendLoginCode, verifyLoginCode } from '../lib/accountClient.js'
import {
  LOGIN_CODE_COUNTDOWN_SECONDS,
  formatLoginCodeCountdownLabel,
  shouldDisableLoginCodeButton,
} from '../lib/loginCountdown.js'

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
  const [showLogin, setShowLogin] = useState(false)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const [loginMessage, setLoginMessage] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
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

  const handleNav = (item) => {
    if (item.requiresLogin && !getAuthToken()) {
      setShowLogin(true)
      setLoginMessage('请先登录账户')
      return
    }
    navigate(item.path)
  }

  useEffect(() => {
    if (loginCodeCountdown <= 0) return undefined
    const timer = window.setInterval(() => {
      setLoginCodeCountdown((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [loginCodeCountdown])

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
            </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <>
      <aside className="w-[240px] h-full border-r border-dashed border-ink-fade/50 flex flex-col gap-3 p-4 bg-paper shrink-0 overflow-y-auto">
        <button onClick={() => navigate('/chat')} className="flex items-center gap-2 mb-1">
          <div className="w-7 h-7 rounded-full border border-ink flex items-center justify-center bg-paper">
            <Sparkles className="w-3.5 h-3.5 text-ember" />
          </div>
          <span className="font-display italic text-lg text-ink">your model</span>
        </button>

        <button
          onClick={handleNewChat}
          className="flex items-center justify-between h-9 px-3 border border-ink/80 rounded-md bg-paper hover:bg-paper-2 transition-colors"
        >
          <span className="text-sm text-ink-soft">新对话</span>
          <span className="font-mono text-[10px] text-ink-fade tracking-wider">Ctrl N</span>
        </button>

        {/* ★ #13: 全局搜索 */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-fade pointer-events-none" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话…"
            className="w-full h-7 pl-7 pr-7 border border-ink-fade/40 rounded-md bg-paper text-xs text-ink outline-none focus:border-ember"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-ink-fade/20 text-ink-fade"
              title="清除搜索"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

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

        {searchResults ? (
          searchResults.length ? (
            <div className="mt-2">
              <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">
                搜索结果 ({searchResults.length})
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
          <div className="mt-4 px-2 py-6 border border-dashed border-ink-fade/40 rounded-md text-center">
            <p className="text-xs text-ink-fade">还没有对话</p>
            <p className="text-[10px] text-ink-ghost mt-1">点击"新对话"开始</p>
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

            <form onSubmit={handleVerify} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-ink-fade">验证码</span>
                <input
                  value={loginCode}
                  onChange={(e) => setLoginCode(e.target.value)}
                  placeholder="6 位数字"
                  className="h-9 px-3 border border-ink/40 rounded-md bg-paper outline-none focus:border-ember text-sm text-ink"
                />
              </label>
              <button
                disabled={loginLoading || !loginEmail.trim() || !loginCode.trim()}
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
