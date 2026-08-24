import { useState } from 'react'
import { useNavigate } from '../lib/router.jsx'
import { Search, MessageSquare, LayoutList } from 'lucide-react'
import AppLayout from '../components/AppLayout.jsx'
import { useAppContext } from '../store/AppContext'
import { useT } from '../i18n/I18nProvider.jsx'
import { useToast } from '../components/Toast.jsx'
import { getAuthToken } from '../lib/accountClient'
import { archiveSessionRemote, unarchiveSessionRemote } from '../lib/sessionClient'
import { visibleTabs } from '../lib/tabVisibility.js'
import HistoryContent from './history/HistoryContent.jsx'
import { contentPreview, getItemType, groupByDate, timestampValue } from './history/historyViewUtils.js'

const tabs = [
  { key: 'sessions', labelKey: 'history.sessions', icon: MessageSquare },
  { key: 'tasks', labelKey: 'history.tasks', icon: LayoutList },
]

export default function HistoryView() {
  const navigate = useNavigate()
  const { state, dispatch } = useAppContext()
  const { t, lang } = useT()
  const toast = useToast()
  const [activeTab, setActiveTab] = useState('sessions')
  const [query, setQuery] = useState('')
  const [retryingId, setRetryingId] = useState(null)
  const [archiveFilter, setArchiveFilter] = useState('active')
  const [archivingId, setArchivingId] = useState(null)

  const rawHistory = [
    ...(state.sessions || []).map((session) => ({
      id: session.id,
      type: 'session',
      name: session.title || t('history.unnamedSession'),
      skill: t('history.messageCount', { count: session.messages?.length || 0 }),
      status: t('history.session'),
      detail: contentPreview(session.messages?.at(-1)?.content, t) || t('history.emptySession'),
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

  const normalizedQuery = query.trim().toLocaleLowerCase(lang)
  const filtered = rawHistory.filter((item) => {
    const typeMatch = getItemType(item) === activeTab
    const searchMatch = !normalizedQuery || [item.name, item.skill, item.status, item.detail]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase(lang).includes(normalizedQuery))
    if (activeTab === 'sessions') {
      const isArchived = !!item.archivedAt
      if (effectiveArchiveFilter === 'active' && isArchived) return false
      if (effectiveArchiveFilter === 'archived' && !isArchived) return false
    }
    return typeMatch && searchMatch
  }).sort((a, b) => timestampValue(b) - timestampValue(a))

  const grouped = groupByDate(filtered, t, lang)
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
        const result = isArchived
          ? await unarchiveSessionRemote(item.id)
          : await archiveSessionRemote(item.id)
        if (result?.session) {
          dispatch({
            type: 'APPLY_SERVER_SESSION_METADATA',
            payload: { sessionId: item.id, session: result.session },
          })
        }
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
    <AppLayout className="h-screen flex bg-paper overflow-hidden">
      <div className="flex-1 overflow-y-auto px-5 py-6 sm:px-8">
        {/* Header */}
        <div className="mx-auto mb-5 flex max-w-5xl flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{t('history.eyebrow')}</span>
            <h1 className="font-semibold text-[28px] text-ink mt-1.5">{t('history.title')}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
                {t(tab.labelKey)}
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
                      className={`inline-flex items-center h-7 px-2.5 rounded-full text-xs border transition-colors ${
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
                placeholder={t('history.search')}
                className="bg-transparent text-sm text-ink outline-none placeholder:text-ink-soft w-24"
              />
            </div>
          </div>
        </div>

        <HistoryContent
          archivingId={archivingId}
          groups={grouped}
          onArchiveToggle={handleArchiveToggle}
          onOpen={handleOpen}
          onRetry={handleRetry}
          onStartChat={handleStartChat}
          retryingId={retryingId}
          t={t}
        />
      </div>
    </AppLayout>
  )
}
