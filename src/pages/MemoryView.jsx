import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, Plus } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useActiveAgent } from '../agents/activeAgentContext.js'
import { useT } from '../i18n/I18nProvider.jsx'
import { deleteMemoryApi, listMemoriesApi, upsertMemoryApi } from '../lib/memoryClient.js'
import MemoryEditor from './memory/MemoryEditor.jsx'
import MemoryFilters from './memory/MemoryFilters.jsx'
import MemoryList from './memory/MemoryList.jsx'

const TYPE_IDS = ['user', 'feedback', 'project', 'reference']
const emptyMemory = () => ({ id: '', type: 'user', title: '', body: '', pinned: false, agentId: null, frontmatter: {} })

export default function MemoryView() {
  const { t } = useT()
  const { agents, activeAgentId } = useActiveAgent()
  const types = TYPE_IDS.map((id) => { const [label, hint] = t(`memory.types.${id}`); return { id, label, hint } })
  const [memories, setMemories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [filterAgent, setFilterAgent] = useState('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const agentNameById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents])
  const reload = useCallback(async () => {
    setLoading(true); setError('')
    try { setMemories((await listMemoriesApi()).memories || []) } catch (caught) { setError(caught.message || t('memory.loadFailed')) } finally { setLoading(false) }
  }, [t])
  useEffect(() => { const timer = window.setTimeout(reload, 0); return () => window.clearTimeout(timer) }, [reload])
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return memories.filter((memory) => {
      if (filterType !== 'all' && memory.type !== filterType) return false
      if (filterAgent === '__global__' && memory.agentId) return false
      if (!['all', '__global__'].includes(filterAgent) && memory.agentId !== filterAgent) return false
      return !normalizedQuery || memory.title.toLowerCase().includes(normalizedQuery) || memory.body.toLowerCase().includes(normalizedQuery)
    })
  }, [filterAgent, filterType, memories, query])
  const handleNew = () => setEditing({ ...emptyMemory(), agentId: !['all', '__global__'].includes(filterAgent) ? filterAgent : null })
  const handleSave = async () => {
    if (!editing) return
    setSaving(true)
    try { await upsertMemoryApi({ ...editing, id: editing.id || undefined, pinned: !!editing.pinned, agentId: editing.agentId || null, frontmatter: editing.frontmatter || {} }); setEditing(null); await reload() } catch (caught) { setError(caught.message || t('memory.saveFailed')) } finally { setSaving(false) }
  }
  const handleDelete = async (id) => {
    if (!id || !window.confirm(t('memory.confirmDelete'))) return
    try { await deleteMemoryApi(id); if (editing?.id === id) setEditing(null); await reload() } catch (caught) { setError(caught.message || t('memory.deleteFailed')) }
  }
  return <div className="flex h-screen overflow-hidden bg-paper"><LeftRail /><div className="flex min-w-0 flex-1 flex-col">
    <div className="flex items-center gap-3 border-b border-ink/10 px-6 py-4"><BookOpen className="h-5 w-5 text-accent-ink" /><div className="flex-1"><div className="text-base font-semibold text-ink">{t('memory.title')}</div><div className="text-xs text-ink-fade">{t('memory.subtitle')}</div></div><button type="button" onClick={handleNew} className="flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-xs text-accent-contrast hover:bg-accent/90"><Plus className="h-3.5 w-3.5" />{t('memory.add')}</button></div>
    <MemoryFilters agents={agents} filterAgent={filterAgent} filterType={filterType} onAgentChange={setFilterAgent} onQueryChange={setQuery} onTypeChange={setFilterType} query={query} t={t} types={types} />
    <div className="flex min-h-0 flex-1"><MemoryList agentNameById={agentNameById} editingId={editing?.id} error={error} items={filtered} loading={loading} onEdit={setEditing} t={t} /><div className="flex-1 overflow-auto"><MemoryEditor activeAgentId={activeAgentId} agents={agents} editing={editing} onChange={setEditing} onClose={() => setEditing(null)} onDelete={handleDelete} onSave={handleSave} saving={saving} t={t} types={types} /></div></div>
  </div></div>
}
