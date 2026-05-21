import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Clock, Search, X, MessageSquare, ChevronRight, Calendar, Trash2 } from 'lucide-react'
import ThemeWrapper from '../components/ThemeWrapper.jsx'
import { useAppContext } from '../store/AppContext.jsx'

export default function HistoryView() {
  const { state, dispatch } = useAppContext()
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState('')

  const sessions = useMemo(() => {
    let items = [...state.sessions]
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      items = items.filter((s) => {
        if (String(s.title || '').toLowerCase().includes(q)) return true
        if (Array.isArray(s.messages)) {
          return s.messages.some((m) => String(m.content || '').toLowerCase().includes(q))
        }
        return false
      })
    }
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return items
  }, [state.sessions, searchQuery])

  // Group by date
  const grouped = useMemo(() => {
    const groups = {}
    const today = new Date()
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    const yesterdayStart = todayStart - 86400000
    const weekStart = todayStart - ((today.getDay() + 6) % 7) * 86400000

    sessions.forEach((s) => {
      const t = s.createdAt || 0
      let label
      if (t >= todayStart) label = '今天'
      else if (t >= yesterdayStart) label = '昨天'
      else if (t >= weekStart) label = '本周'
      else {
        const d = new Date(t)
        label = `${d.getFullYear()}年${d.getMonth() + 1}月`
      }
      if (!groups[label]) groups[label] = []
      groups[label].push(s)
    })
    return groups
  }, [sessions])

  const groupOrder = Object.keys(grouped)

  return (
    <ThemeWrapper headerName="历史" headerPath="/history">
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-[720px] mx-auto">
          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8"
          >
            <span className="section-label">CONVERSATION HISTORY</span>
            <h1 className="font-hand text-3xl text-ink mt-1">历史会话</h1>
            <p className="text-sm text-ink-fade mt-2">{sessions.length} 个会话</p>
          </motion.div>

          {/* Search */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="mb-6 relative"
          >
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-fade pointer-events-none" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索会话内容…"
              className="w-full h-11 pl-11 pr-10 border border-ink-fade/20 rounded-xl bg-paper/60 text-sm text-ink outline-none focus:border-ember/50 focus:ring-2 focus:ring-ember/10 transition-all placeholder:text-ink-fade/50"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-paper-2/50 text-ink-fade transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </motion.div>

          {/* Timeline */}
          {groupOrder.length > 0 ? (
            <div className="space-y-6">
              {groupOrder.map((label) => (
                <div key={label}>
                  {/* Date Group Header */}
                  <div className="flex items-center gap-3 mb-3">
                    <Calendar className="w-3.5 h-3.5 text-ink-fade" />
                    <span className="section-label">{label}</span>
                    <div className="flex-1 h-px bg-ink-fade/10" />
                    <span className="text-[10px] text-ink-fade/50 font-mono">{grouped[label].length}</span>
                  </div>

                  {/* Sessions */}
                  <div className="space-y-1 stagger-children">
                    {grouped[label].map((s, i) => {
                      const msgCount = Array.isArray(s.messages) ? s.messages.length : 0
                      const lastMsg = Array.isArray(s.messages) ? s.messages[s.messages.length - 1] : null
                      const preview = lastMsg?.role === 'assistant'
                        ? String(lastMsg.content || '').slice(0, 60)
                        : ''

                      return (
                        <motion.div
                          key={s.id}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: i * 0.03 }}
                          onClick={() => {
                            dispatch({ type: 'SWITCH_SESSION', payload: s.id })
                            navigate('/chat')
                          }}
                          className="group flex items-center gap-3 p-3.5 rounded-xl cursor-pointer hover:bg-paper-2/60 border border-transparent hover:border-ink-fade/15 transition-all duration-200"
                        >
                          <div className="w-9 h-9 rounded-lg bg-paper-2 border border-ink-fade/15 flex items-center justify-center shrink-0">
                            <MessageSquare className="w-4 h-4 text-ink-fade" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-ink truncate font-medium">{s.title}</div>
                            {preview && (
                              <div className="text-[11px] text-ink-fade truncate mt-0.5">{preview}</div>
                            )}
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[10px] text-ink-fade/60 font-mono">{msgCount} 消息</span>
                              {s.createdAt && (
                                <span className="text-[10px] text-ink-fade/40 font-mono">
                                  {new Date(s.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                if (confirm('删除此会话?')) dispatch({ type: 'DELETE_SESSION', payload: s.id })
                              }}
                              className="p-2 rounded-lg hover:bg-red-50/40 text-ink-fade hover:text-red-500 transition-colors"
                              title="删除"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            <ChevronRight className="w-4 h-4 text-ink-fade" />
                          </div>
                        </motion.div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-16 text-center">
              <Clock className="w-10 h-10 text-ink-fade/30 mx-auto mb-3" />
              <p className="text-sm text-ink-fade">{searchQuery ? '没有匹配的会话' : '还没有历史会话'}</p>
            </div>
          )}
        </div>
      </div>
    </ThemeWrapper>
  )
}
