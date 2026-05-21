import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Save, Pin, Search, BookOpen, X } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import {
  listMemoriesApi,
  upsertMemoryApi,
  deleteMemoryApi,
} from '../lib/memoryClient.js'

const TYPES = [
  { id: 'user', label: '用户', hint: '关于用户的长期事实（角色、偏好）' },
  { id: 'feedback', label: '反馈', hint: '校正过的工作方式，下次重复' },
  { id: 'project', label: '项目', hint: '项目背景、约束、决策' },
  { id: 'reference', label: '引用', hint: '用户指定要记住的资料片段' },
]

function emptyMemory() {
  return {
    id: '',
    type: 'user',
    title: '',
    body: '',
    pinned: false,
    frontmatter: {},
  }
}

export default function MemoryView() {
  const [memories, setMemories] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)

  const reload = async () => {
    setLoading(true)
    setErr('')
    try {
      const data = await listMemoriesApi()
      setMemories(data.memories || [])
    } catch (e) {
      setErr(e.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return memories.filter((m) => {
      if (filterType !== 'all' && m.type !== filterType) return false
      if (!q) return true
      return m.title.toLowerCase().includes(q) || m.body.toLowerCase().includes(q)
    })
  }, [memories, filterType, query])

  const handleNew = () => setEditing(emptyMemory())

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
        frontmatter: editing.frontmatter || {},
      })
      setEditing(null)
      await reload()
    } catch (e) {
      setErr(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    if (!id) return
    if (!window.confirm('删除这条记忆?不可撤销。')) return
    try {
      await deleteMemoryApi(id)
      if (editing?.id === id) setEditing(null)
      await reload()
    } catch (e) {
      setErr(e.message || '删除失败')
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
            <div className="text-base font-semibold text-ink">记忆中心</div>
            <div className="text-[11px] text-ink-fade">长期记住的用户偏好、反馈、项目背景；会注入到每次对话</div>
          </div>
          <button
            type="button"
            onClick={handleNew}
            className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            新增
          </button>
        </div>

        {/* Filters */}
        <div className="px-6 py-3 flex items-center gap-3 border-b border-ink/5">
          <div className="flex items-center gap-1.5 border border-ink/15 rounded-md overflow-hidden text-[11px]">
            <FilterChip active={filterType === 'all'} onClick={() => setFilterType('all')}>全部</FilterChip>
            {TYPES.map((t) => (
              <FilterChip
                key={t.id}
                active={filterType === t.id}
                onClick={() => setFilterType(t.id)}
              >
                {t.label}
              </FilterChip>
            ))}
          </div>
          <div className="relative flex-1 max-w-[280px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-fade" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题或内容…"
              className="w-full h-8 pl-8 pr-3 text-xs bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember"
            />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 flex min-h-0">
          {/* List */}
          <div className="w-[360px] border-r border-ink/10 overflow-auto">
            {loading && <div className="p-4 text-sm text-ink-fade">加载中…</div>}
            {err && <div className="p-4 text-sm text-rose-700">{err}</div>}
            {!loading && filtered.length === 0 && (
              <div className="p-6 text-center text-sm text-ink-fade">
                还没有记忆，点击「新增」开始。
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
                左侧选择记忆，或点「新增」创建一条
              </div>
            ) : (
              <div className="max-w-[720px] mx-auto px-8 py-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-ink">
                    {editing.id ? '编辑记忆' : '新建记忆'}
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="text-ink-fade hover:text-ink"
                    title="关闭"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div>
                  <label className="block text-[11px] text-ink-fade mb-1.5">类型</label>
                  <div className="flex gap-1.5">
                    {TYPES.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setEditing({ ...editing, type: t.id })}
                        className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                          editing.type === t.id
                            ? 'bg-ember text-paper border-ember'
                            : 'bg-paper-2 border-ink/15 text-ink-soft hover:border-ember/50'
                        }`}
                        title={t.hint}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-ink-fade mb-1.5">标题</label>
                  <input
                    value={editing.title}
                    onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                    placeholder="一句话描述这条记忆"
                    className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember"
                  />
                </div>

                <div>
                  <label className="block text-[11px] text-ink-fade mb-1.5">内容 (markdown)</label>
                  <textarea
                    value={editing.body}
                    onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                    rows={10}
                    placeholder={'比如:\n用户偏好用 TypeScript + Vite,不喜欢冗长注释。\n相关: [[design-style]]'}
                    className="w-full px-3 py-2 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono"
                  />
                  <div className="text-[10px] text-ink-fade mt-1">支持 [[slug]] 形式链接其他记忆</div>
                </div>

                <label className="flex items-center gap-2 text-xs text-ink-soft cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!editing.pinned}
                    onChange={(e) => setEditing({ ...editing, pinned: e.target.checked })}
                  />
                  <Pin className="w-3.5 h-3.5" />
                  置顶（优先注入到模型上下文）
                </label>

                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !editing.title.trim() || !editing.body.trim()}
                    className="h-8 px-4 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 disabled:opacity-50 flex items-center gap-1"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {saving ? '保存中…' : '保存'}
                  </button>
                  {editing.id && (
                    <button
                      type="button"
                      onClick={() => handleDelete(editing.id)}
                      className="h-8 px-3 border border-rose-300 text-rose-700 rounded-md text-xs hover:bg-rose-50 flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      删除
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
