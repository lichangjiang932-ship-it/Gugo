import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Save, Pin, Search, BookOpen, X, Users } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useActiveAgent } from '../agents/activeAgentContext.js'
import { useT } from '../i18n/I18nProvider.jsx'
import {
  listMemoriesApi,
  upsertMemoryApi,
  deleteMemoryApi,
} from '../lib/memoryClient.js'

const TYPE_IDS = ['user', 'feedback', 'project', 'reference']

function emptyMemory() {
  return {
    id: '',
    type: 'user',
    title: '',
    body: '',
    pinned: false,
    agentId: null,
    frontmatter: {},
  }
}

export default function MemoryView() {
  const { t } = useT()
  const { agents, activeAgentId } = useActiveAgent()
  const types = TYPE_IDS.map((id) => {
    const [label, hint] = t(`memory.types.${id}`)
    return { id, label, hint }
  })
  const [memories, setMemories] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [filterAgent, setFilterAgent] = useState('all') // 'all' | '__global__' | <agentId>
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)

  const agentNameById = useMemo(() => {
    const m = new Map()
    for (const a of agents) m.set(a.id, a.name)
    return m
  }, [agents])

  const reload = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const data = await listMemoriesApi()
      setMemories(data.memories || [])
    } catch (e) {
      setErr(e.message || t('memory.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    const timer = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(timer)
  }, [reload])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return memories.filter((m) => {
      if (filterType !== 'all' && m.type !== filterType) return false
      if (filterAgent === '__global__' && m.agentId) return false
      if (filterAgent !== 'all' && filterAgent !== '__global__' && m.agentId !== filterAgent) return false
      if (!q) return true
      return m.title.toLowerCase().includes(q) || m.body.toLowerCase().includes(q)
    })
  }, [memories, filterType, filterAgent, query])

  const handleNew = () => setEditing({ ...emptyMemory(), agentId: filterAgent !== 'all' && filterAgent !== '__global__' ? filterAgent : null })

  const handleSave = async () => {
    if (!editing) return
    setSaving(true)
    try {
      await upsertMemoryApi({
        id: editing.id || undefined,
        type: editing.type,
        title: editing.title,
        body: editing.body,
        pinned: !!editing.pinned,
        agentId: editing.agentId || null,
        frontmatter: editing.frontmatter || {},
      })
      setEditing(null)
      await reload()
    } catch (e) {
      setErr(e.message || t('memory.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    if (!id) return
    if (!window.confirm(t('memory.confirmDelete'))) return
    try {
      await deleteMemoryApi(id)
      if (editing?.id === id) setEditing(null)
      await reload()
    } catch (e) {
      setErr(e.message || t('memory.deleteFailed'))
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
          <BookOpen className="w-5 h-5 text-ember" />
          <div className="flex-1">
            <div className="text-base font-semibold text-ink">{t('memory.title')}</div>
            <div className="text-[11px] text-ink-fade">{t('memory.subtitle')}</div>
          </div>
          <button
            type="button"
            onClick={handleNew}
            className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('memory.add')}
          </button>
        </div>

        {/* Filters */}
        <div className="px-6 py-3 flex items-center gap-3 border-b border-ink/5 flex-wrap">
          <div className="flex items-center gap-1.5 border border-ink/15 rounded-md overflow-hidden text-[11px]">
            <FilterChip active={filterType === 'all'} onClick={() => setFilterType('all')}>{t('memory.all')}</FilterChip>
            {types.map((type) => (
              <FilterChip
                key={type.id}
                active={filterType === type.id}
                onClick={() => setFilterType(type.id)}
              >
                {type.label}
              </FilterChip>
            ))}
          </div>
          {/* v0.8 Agent 范围 */}
          <div className="flex items-center gap-1.5 text-[11px]">
            <Users className="w-3 h-3 text-ink-fade" />
            <select
              value={filterAgent}
              onChange={(e) => setFilterAgent(e.target.value)}
              className="h-7 px-2 text-[11px] bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember"
            >
              <option value="all">{t('memory.allAgents')}</option>
              <option value="__global__">{t('memory.globalOnly')}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{t('memory.agentOnly', { name: a.name })}</option>
              ))}
            </select>
          </div>
          <div className="relative flex-1 max-w-[280px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-fade" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('memory.search')}
              className="w-full h-8 pl-8 pr-3 text-xs bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember"
            />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0">
          {/* List */}
          <div className="w-[360px] border-r border-ink/10 overflow-auto">
            {loading && <div className="p-4 text-sm text-ink-fade">{t('memory.loading')}</div>}
            {err && <div className="p-4 text-sm text-rose-700">{err}</div>}
            {!loading && filtered.length === 0 && (
              <div className="p-6 text-center text-sm text-ink-fade">
                {t('memory.empty')}
              </div>
            )}
            {filtered.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setEditing(m)}
                className={`w-full text-left border-b border-ink/5 px-4 py-3 hover:bg-paper-2 transition-colors ${
                  editing?.id === m.id ? 'bg-ember/10' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-ember">{m.type}</span>
                  {m.pinned && <Pin className="w-3 h-3 text-ember" />}
                  {m.agentId && (
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-ink/5 text-[9px] text-ink-fade">
                      <Users className="w-2.5 h-2.5" />
                      {agentNameById.get(m.agentId) || m.agentId.slice(0, 6)}
                    </span>
                  )}
                  <span className="text-sm text-ink truncate">{m.title}</span>
                </div>
                <div className="text-[11px] text-ink-fade truncate mt-1">
                  {(m.body || '').split('\n')[0]}
                </div>
              </button>
            ))}
          </div>

          {/* Editor */}
          <div className="flex-1 overflow-auto">
            {!editing ? (
              <div className="h-full flex items-center justify-center text-sm text-ink-fade">
                {t('memory.selectHint')}
              </div>
            ) : (
              <div className="max-w-[720px] mx-auto px-8 py-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-ink">
                    {editing.id ? t('memory.editTitle') : t('memory.newTitle')}
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="text-ink-fade hover:text-ink"
                    title={t('memory.close')}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div>
                  <label className="block text-[11px] text-ink-fade mb-1.5">{t('memory.type')}</label>
                  <div className="flex gap-1.5">
                    {types.map((type) => (
                      <button
                        key={type.id}
                        type="button"
                        onClick={() => setEditing({ ...editing, type: type.id })}
                        className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                          editing.type === type.id
                            ? 'bg-ember text-paper border-ember'
                            : 'bg-paper-2 border-ink/15 text-ink-soft hover:border-ember/50'
                        }`}
                        title={type.hint}
                      >
                        {type.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-ink-fade mb-1.5">{t('memory.titleLabel')}</label>
                  <input
                    value={editing.title}
                    onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                    placeholder={t('memory.titlePlaceholder')}
                    className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-ink-fade mb-1.5">{t('memory.bodyLabel')}</label>
                  <textarea
                    value={editing.body}
                    onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                    rows={10}
                    placeholder={t('memory.bodyPlaceholder')}
                    className="w-full px-3 py-2 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono"
                  />
                  <div className="text-[10px] text-ink-fade mt-1">{t('memory.linkHint')}</div>
                </div>

                <label className="flex items-center gap-2 text-xs text-ink-soft cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!editing.pinned}
                    onChange={(e) => setEditing({ ...editing, pinned: e.target.checked })}
                  />
                  <Pin className="w-3.5 h-3.5" />
                  {t('memory.pinned')}
                </label>

                {/* v0.8 绑定到 agent */}
                <div>
                  <label className="block text-[11px] text-ink-fade mb-1.5 flex items-center gap-1">
                    <Users className="w-3 h-3" />{t('memory.bindAgent')}
                  </label>
                  <select
                    value={editing.agentId || ''}
                    onChange={(e) => setEditing({ ...editing, agentId: e.target.value || null })}
                    className="w-full h-8 px-2 text-xs bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember"
                  >
                    <option value="">{t('memory.globalAgent')}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}{a.id === activeAgentId ? t('memory.current') : ''}</option>
                    ))}
                  </select>
                  <div className="text-[10px] text-ink-fade mt-1">
                    {t('memory.agentHint')}
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !editing.title.trim() || !editing.body.trim()}
                    className="h-8 px-4 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 disabled:opacity-50 flex items-center gap-1"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {saving ? t('memory.saving') : t('memory.save')}
                  </button>
                  {editing.id && (
                    <button
                      type="button"
                      onClick={() => handleDelete(editing.id)}
                      className="h-8 px-3 border border-rose-300 text-rose-700 rounded-md text-xs hover:bg-rose-50 flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      {t('memory.delete')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 transition-colors ${
        active ? 'bg-ember text-paper' : 'text-ink-soft hover:bg-paper-2'
      }`}
    >
      {children}
    </button>
  )
}
