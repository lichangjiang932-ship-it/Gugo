import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search, RefreshCw, ArrowUpRight, MessageSquare, LayoutList, Clock, Archive, ArchiveRestore } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useAppContext } from '../store/AppContext'
import { useT } from '../i18n/I18nProvider.jsx'
import { useToast } from '../components/Toast.jsx'
import { getAuthToken } from '../lib/accountClient'
import { archiveSessionRemote, unarchiveSessionRemote } from '../lib/sessionClient'
import { visibleTabs } from '../lib/tabVisibility.js'

const tabs = [
  { key: 'sessions', label: '会话', icon: MessageSquare },
  { key: 'tasks', label: '任务', icon: LayoutList },
]

function formatStatus(item) {
  const prefix = item.state === 'done' ? '[完成]' : item.state === 'active' ? '[进行中]' : '[失败]'
  return `${prefix} ${item.status || ''} · ${item.detail || ''}`
}

function getItemType(item) {
  if (item.type === 'session') return 'sessions'
  if (item.type === 'task') return 'tasks'
  if (item.state != null && item.state !== '') return 'tasks'
  return 'sessions'
}

function contentPreview(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.type === 'text' ? part.text : part?.type === 'image_url' ? '[图片]' : '')
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function groupByDate(items) {
  const groups = {}
  items.forEach((item) => {
    const dateStr =
      typeof item.date === 'number'
        ? new Date(item.date).toLocaleDateString()
        : item.date || '未知日期'
    if (!groups[dateStr]) groups[dateStr] = []
    groups[dateStr].push(item)
  })
  return Object.entries(groups).map(([date, items]) => ({ date, items }))
}

export default function HistoryView() {
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const { t } = useT()
  const toast = useToast()
  const [activeTab, setActiveTab] = useState('tasks')
  const [query, setQuery] = useState('')
  const [retryingId, setRetryingId] = useState(null)
  const [archiveFilter, setArchiveFilter] = useState('active')
  const [archivingId, setArchivingId] = useState(null)

  const rawHistory = [
    ...(state.sessions || []).map((session) => ({
      id: session.id,
      type: 'session',
      name: session.title || '未命名会话',
      skill: `${session.messages?.length || 0} 条消息`,
      status: '会话',
      detail: contentPreview(session.messages?.at(-1)?.content) || '空会话',
      date: session.updatedAt || session.createdAt,
      archivedAt: session.archivedAt || null,
    })),
    ...(state.history || []).map((item) => ({ ...item, type: 'task' })),
  ]

  // 计算 session 子集的 active / archived / all 数量，决定 archive filter tab 可见性
  const allSessionItems = rawHistory.filter((item) => getItemType(item) === 'sessions')
  const activeSessionItems = allSessionItems.filter((item) => !item.archivedAt)
  const archivedSessionItems = allSessionItems.filter((item) => !!item.archivedAt)
  const sessionTabsToShow = visibleTabs({
    active: activeSessionItems.length,
    archived: archivedSessionItems.length,
    all: allSessionItems.length,
  })
  const effectiveArchiveFilter = sessionTabsToShow.includes(archiveFilter) ? archiveFilter : 'active'

  const filtered = rawHistory.filter((item) => {
    const typeMatch = getItemType(item) === activeTab
    const searchMatch =
      !query.trim() ||
      (item.name && item.name.includes(query)) ||
      (item.skill && item.skill.includes(query)) ||
      (item.status && item.status.includes(query))
    if (activeTab === 'sessions') {
      const isArchived = !!item.archivedAt
      if (effectiveArchiveFilter === 'active' && isArchived) return false
      if (effectiveArchiveFilter === 'archived' && !isArchived) return false
    }
    return typeMatch && searchMatch
  })

  const grouped = groupByDate(filtered)
  const hasHistory = grouped.length > 0

  const handleStartChat = () => {
    dispatch({ type: 'NEW_SESSION' })
    navigate('/chat')
  }

  const handleOpen = (item) => {
    if (getItemType(item) === 'sessions' && item.id) {
      dispatch({ type: 'SWITCH_SESSION', payload: item.id })
      navigate('/chat')
    } else if (getItemType(item) === 'tasks') {
      navigate('/task')
    } else {
      navigate('/chat')
    }
  }

  const handleRetry = (item) => {
    setRetryingId(item.id)
    // 把这一条历史的 detail 推回 chat 输入框，跳转到 chat 让用户重新发送
    const text = item.detail || item.name || ''
    if (text) {
      dispatch({ type: 'SET_DRAFT_INPUT', payload: text })
    }
    setTimeout(() => {
      setRetryingId(null)
      navigate('/chat')
    }, 600)
  }

  const handleArchiveToggle = async (item) => {
    if (getItemType(item) !== 'sessions' || !item.id) return
    const isArchived = !!item.archivedAt
    const next = isArchived ? 'UNARCHIVE_SESSION' : 'ARCHIVE_SESSION'
    const rollback = isArchived ? 'ARCHIVE_SESSION' : 'UNARCHIVE_SESSION'
    setArchivingId(item.id)
    dispatch({ type: next, payload: item.id })
    try {
      if (getAuthToken()) {
        if (isArchived) await unarchiveSessionRemote(item.id)
        else await archiveSessionRemote(item.id)
      }
    } catch (error) {
      if (!/session not found/i.test(error?.message || '')) {
        dispatch({ type: rollback, payload: item.id })
        toast.error({ title: t('errors.saveFailed'), body: error?.message })
      }
    } finally {
      setArchivingId(null)
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <div className="flex-1 p-8 overflow-y-auto">
        {/* Header */}
        <div className="flex items-end justify-between mb-6">
          <div>
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">HISTORY · 你和模型的记录</span>
            <h1 className="font-hand text-[28px] text-ink mt-1.5">
              合作过的事 <span className="font-display italic text-[22px] opacity-70">/ a quiet log.</span>
            </h1>
          </div>
          <div className="flex gap-2">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`inline-flex items-center h-7 px-3 rounded-full text-xs border transition-colors gap-1.5 ${
                  activeTab === tab.key
                    ? 'bg-ink text-paper border-ink'
                    : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade'
                }`}
              >
                <tab.icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            ))}
            {activeTab === 'sessions' && (
              <div className="flex items-center gap-1 ml-1">
                {sessionTabsToShow.map((key) => {
                  const count =
                    key === 'active' ? activeSessionItems.length
                      : key === 'archived' ? archivedSessionItems.length
                        : allSessionItems.length
                  const showBadge = sessionTabsToShow.includes('archived')
                  return (
                    <button
                      key={key}
                      onClick={() => setArchiveFilter(key)}
                      className={`inline-flex items-center h-7 px-2.5 rounded-full text-[11px] border transition-colors ${
                        effectiveArchiveFilter === key
                          ? 'bg-ink text-paper border-ink'
                          : 'border-ink-fade/50 text-ink-soft hover:border-ink-fade'
                      }`}
                    >
                      {t(`nav.filter${key.charAt(0).toUpperCase()}${key.slice(1)}`)}{showBadge ? ` (${count})` : ''}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="h-8 px-3 border border-ink/70 rounded-md flex items-center gap-1.5 bg-paper">
              <Search className="w-4 h-4 text-ink-fade" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索"
                className="bg-transparent text-sm text-ink outline-none placeholder:text-ink-soft w-24"
              />
            </div>
          </div>
        </div>

        {/* List */}
        {hasHistory ? (
          <div className="flex flex-col gap-5">
            {grouped.map((g, gi) => (
              <div key={gi}>
                <span className="font-mono text-[9px] tracking-wider text-ink-fade mb-2 block">{g.date}</span>
                <div className="flex flex-col gap-1.5">
                  {g.items.map((item, ii) => (
                    <motion.div
                      key={item.id || `${gi}-${ii}`}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: gi * 0.1 + ii * 0.05 }}
                      className="p-3 border border-ink/20 rounded-md bg-paper hover:border-ink/50 transition-colors grid grid-cols-[1.4fr_1fr_1fr_100px] gap-3 items-center"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className={`w-2 h-2 rounded-full ${
                          item.state === 'done' ? 'bg-ink-ghost' : item.state === 'active' ? 'bg-ember' : 'bg-ink-ghost'
                        }`} />
                        <span className="text-sm text-ink">{item.name || '未命名'}</span>
                      </div>
                      <span className="font-mono text-[9px] tracking-wider text-ink-fade">{item.skill || ''}</span>
                      <span className="text-sm text-ink-soft">{formatStatus(item)}</span>
                      <div className="flex gap-1.5 justify-self-end">
                        {getItemType(item) === 'sessions' && item.id && (
                          <button
                            onClick={() => handleArchiveToggle(item)}
                            disabled={archivingId === item.id}
                            title={item.archivedAt ? t('nav.unarchiveSession') : t('nav.archiveSession')}
                            aria-label={item.archivedAt ? t('nav.unarchiveSession') : t('nav.archiveSession')}
                            className="w-7 h-7 rounded-full border border-ink-fade/60 flex items-center justify-center hover:border-ink-fade transition-colors disabled:opacity-40"
                          >
                            {item.archivedAt
                              ? <ArchiveRestore className="w-3.5 h-3.5 text-ink-soft" />
                              : <Archive className="w-3.5 h-3.5 text-ink-soft" />}
                          </button>
                        )}
                        <button
                          onClick={() => handleRetry(item)}
                          className="w-7 h-7 rounded-full border border-ink-fade/60 flex items-center justify-center hover:border-ink-fade transition-colors"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 text-ink-soft ${retryingId === item.id ? 'animate-spin' : ''}`} />
                        </button>
                        <button
                          onClick={() => handleOpen(item)}
                          className="w-7 h-7 rounded-full border border-ink-fade/60 flex items-center justify-center hover:border-ink-fade transition-colors"
                        >
                          <ArrowUpRight className="w-3.5 h-3.5 text-ink-soft" />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Empty state */
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex flex-col items-center justify-center py-24 gap-4"
          >
            <div className="w-12 h-12 rounded-full border border-dashed border-ink-fade/60 flex items-center justify-center">
              <Clock className="w-5 h-5 text-ink-fade" />
            </div>
            <div className="text-center">
              <p className="text-base text-ink-soft">还没有记录</p>
              <p className="text-sm text-ink-fade mt-1">你和模型的对话和任务会出现在这里</p>
            </div>
            <button
              onClick={handleStartChat}
              className="h-9 px-5 border border-ink/70 rounded-md font-hand text-sm text-ink hover:bg-paper-2 transition-colors flex items-center gap-1.5 mt-2"
            >
              <MessageSquare className="w-4 h-4" />
              开始对话
            </button>
          </motion.div>
        )}
      </div>
    </div>
  )
}
