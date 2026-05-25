import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Pin,
  ListChecks,
  Gauge,
  Activity,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  CheckCircle2,
  Circle,
  ArrowLeft,
  Sparkles,
} from 'lucide-react'
import {
  listMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  listTodos,
  createTodo,
  updateTodo,
  deleteTodo,
  getEffort,
  setEffort,
  listMeters,
} from '../lib/reasonixClient.js'

const KIND_OPTIONS = [
  { id: 'user', label: '个人偏好' },
  { id: 'project', label: '项目上下文' },
  { id: 'feedback', label: '历史反馈' },
  { id: 'reference', label: '参考资料' },
]

function Section({ icon: Icon, title, subtitle, action, children }) {
  return (
    <section className="border border-ink/20 rounded-lg p-5 bg-paper">
      <header className="flex items-start justify-between gap-3 mb-4 pb-3 border-b border-ink-fade/30">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-md bg-ink/5 flex items-center justify-center text-ink">
            <Icon className="w-4 h-4" />
          </div>
          <div>
            <h2 className="font-hand text-xl text-ink leading-tight">{title}</h2>
            {subtitle && <p className="text-sm text-ink-soft mt-0.5">{subtitle}</p>}
          </div>
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

function MemoriesPanel() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [draft, setDraft] = useState({ title: '', content: '', kind: 'user' })
  const [submitting, setSubmitting] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      const data = await listMemories()
      setItems(data.memories || [])
      setErr('')
    } catch (e) { setErr(e.message) } finally { setLoading(false) }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time fetch (refresh 内部 await 后才真正 setState 主体，setLoading 是预期行为)
  useEffect(() => { refresh() }, [])

  const totalTokens = useMemo(
    () => items.filter((m) => m.enabled).reduce((s, m) => s + m.tokens, 0),
    [items],
  )

  const handleCreate = async (e) => {
    e.preventDefault()
    if (!draft.title.trim() || !draft.content.trim()) return
    setSubmitting(true)
    try {
      await createMemory(draft)
      setDraft({ title: '', content: '', kind: 'user' })
      await refresh()
    } catch (e) { setErr(e.message) } finally { setSubmitting(false) }
  }

  const handleToggle = async (m) => {
    try { await updateMemory(m.id, { enabled: !m.enabled }); await refresh() } catch (e) { setErr(e.message) }
  }
  const handleDelete = async (m) => {
    if (!confirm(`删除「${m.title}」？`)) return
    try { await deleteMemory(m.id); await refresh() } catch (e) { setErr(e.message) }
  }

  return (
    <Section
      icon={Pin}
      title="钉记忆"
      subtitle={`受 Reasonix memory 启发：把长期偏好钉到模型 prefix，自动注入到每次对话。当前启用 ${items.filter(x => x.enabled).length} 条 · 约 ${totalTokens} tokens`}
    >
      <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-12 gap-3 mb-5">
        <select
          value={draft.kind}
          onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
          className="md:col-span-2 h-9 px-2 border border-ink/30 rounded-md bg-paper text-sm text-ink"
        >
          {KIND_OPTIONS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <input
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          placeholder="标题，例如「我偏好简体中文回答」"
          className="md:col-span-4 h-9 px-3 border border-ink/30 rounded-md bg-paper text-sm text-ink"
        />
        <input
          value={draft.content}
          onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
          placeholder="内容（≤4000 字）"
          className="md:col-span-5 h-9 px-3 border border-ink/30 rounded-md bg-paper text-sm text-ink"
        />
        <button
          type="submit"
          disabled={submitting || !draft.title.trim() || !draft.content.trim()}
          className="md:col-span-1 h-9 px-3 bg-ink text-paper rounded-md text-sm flex items-center justify-center gap-1 hover:bg-ink-soft disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
        </button>
      </form>

      {err && <div className="mb-3 p-2 border border-ember/40 rounded-md text-sm text-ember bg-ember-soft/30">{err}</div>}

      {loading ? (
        <div className="text-sm text-ink-fade">加载中…</div>
      ) : items.length === 0 ? (
        <div className="p-8 text-center text-sm text-ink-fade border border-dashed border-ink-fade/40 rounded-md">
          还没有钉住的记忆。试试加一条「我偏好简体中文 / 我用 macOS / 我喜欢 TDD」之类。
        </div>
      ) : (
        <div className="divide-y divide-ink-fade/20 border border-ink-fade/30 rounded-md">
          {items.map((m) => (
            <div key={m.id} className="flex items-start gap-3 p-3">
              <button
                onClick={() => handleToggle(m)}
                className="shrink-0 mt-0.5 text-ink-fade hover:text-ember"
                title={m.enabled ? '已启用，点击禁用' : '已禁用，点击启用'}
              >
                {m.enabled ? <ToggleRight className="w-5 h-5 text-ember" /> : <ToggleLeft className="w-5 h-5" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs px-1.5 py-0.5 bg-ink/5 text-ink-soft rounded font-mono">
                    {KIND_OPTIONS.find((k) => k.id === m.kind)?.label || m.kind}
                  </span>
                  <span className="font-hand text-base text-ink truncate">{m.title}</span>
                  <span className="text-xs text-ink-fade ml-auto font-mono">~{m.tokens}t</span>
                </div>
                <div className="text-sm text-ink-soft mt-1 whitespace-pre-wrap break-words">{m.content}</div>
              </div>
              <button
                onClick={() => handleDelete(m)}
                className="shrink-0 text-ink-fade hover:text-ember"
                title="删除"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function TodosPanel() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [title, setTitle] = useState('')

  const refresh = async () => {
    setLoading(true)
    try { setItems((await listTodos()).todos || []); setErr('') } catch (e) { setErr(e.message) } finally { setLoading(false) }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time fetch (refresh 内部 await 后才真正 setState 主体，setLoading 是预期行为)
  useEffect(() => { refresh() }, [])

  const handleAdd = async (e) => {
    e.preventDefault()
    if (!title.trim()) return
    try { await createTodo({ title: title.trim() }); setTitle(''); await refresh() } catch (e) { setErr(e.message) }
  }

  const toggle = async (t) => {
    const next = t.status === 'done' ? 'pending' : 'done'
    try { await updateTodo(t.id, { status: next }); await refresh() } catch (e) { setErr(e.message) }
  }
  const remove = async (t) => {
    if (!confirm(`删除「${t.title}」？`)) return
    try { await deleteTodo(t.id); await refresh() } catch (e) { setErr(e.message) }
  }

  const pendingCount = items.filter((t) => t.status !== 'done').length

  return (
    <Section
      icon={ListChecks}
      title="TODO"
      subtitle={`受 Reasonix /todo 启发：跨会话持久化的小任务列表。未完成 ${pendingCount} 条。`}
    >
      <form onSubmit={handleAdd} className="flex gap-2 mb-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="加一条新任务，回车提交…"
          className="flex-1 h-9 px-3 border border-ink/30 rounded-md bg-paper text-sm text-ink"
        />
        <button
          type="submit"
          disabled={!title.trim()}
          className="h-9 px-4 bg-ink text-paper rounded-md text-sm hover:bg-ink-soft disabled:opacity-50"
        >
          添加
        </button>
      </form>

      {err && <div className="mb-3 p-2 border border-ember/40 rounded-md text-sm text-ember bg-ember-soft/30">{err}</div>}

      {loading ? (
        <div className="text-sm text-ink-fade">加载中…</div>
      ) : items.length === 0 ? (
        <div className="p-8 text-center text-sm text-ink-fade border border-dashed border-ink-fade/40 rounded-md">
          清空状态。先休息一下。
        </div>
      ) : (
        <ul className="divide-y divide-ink-fade/20 border border-ink-fade/30 rounded-md">
          {items.map((t) => (
            <li key={t.id} className="flex items-center gap-3 p-3">
              <button onClick={() => toggle(t)} className="shrink-0 text-ink-fade hover:text-ember">
                {t.status === 'done'
                  ? <CheckCircle2 className="w-5 h-5 text-ember" />
                  : <Circle className="w-5 h-5" />}
              </button>
              <span className={`flex-1 text-sm ${t.status === 'done' ? 'line-through text-ink-fade' : 'text-ink'}`}>
                {t.title}
              </span>
              <button onClick={() => remove(t)} className="shrink-0 text-ink-fade hover:text-ember">
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function EffortPanel() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')

  const refresh = async () => {
    try { setData((await getEffort()).effort); setErr('') } catch (e) { setErr(e.message) }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time fetch (refresh 内部 await 后才真正 setState 主体，setLoading 是预期行为)
  useEffect(() => { refresh() }, [])

  const handleChange = async (effort) => {
    try { setData((await setEffort(effort)).effort); setErr('') } catch (e) { setErr(e.message) }
  }

  if (!data) {
    return (
      <Section icon={Gauge} title="思考预算 (effort)" subtitle="加载中…">
        {err && <div className="text-sm text-ember">{err}</div>}
      </Section>
    )
  }

  const levels = Object.entries(data.presets)

  return (
    <Section
      icon={Gauge}
      title="思考预算 (effort)"
      subtitle="受 Reasonix /effort 启发：用一个旋钮决定每次对话最多走多少步、思考多深、烧多少积分。"
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {levels.map(([id, preset]) => {
          const active = data.effort === id
          return (
            <button
              key={id}
              onClick={() => handleChange(id)}
              className={`p-3 rounded-md border text-left transition-colors ${
                active ? 'border-ember bg-ember-soft/40' : 'border-ink/30 hover:border-ink-fade'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-hand text-lg text-ink">{preset.label}</span>
                {active && <Sparkles className="w-4 h-4 text-ember" />}
              </div>
              <div className="text-xs text-ink-soft mt-2 font-mono">
                {preset.maxSteps} 步 · 思考深度 {preset.reasoningDepth} · ×{preset.costRatio} 积分
              </div>
            </button>
          )
        })}
      </div>
      {err && <div className="mt-3 text-sm text-ember">{err}</div>}
    </Section>
  )
}

function MetersPanel() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    (async () => {
      try { setItems((await listMeters(20)).meters || []); setErr('') }
      catch (e) { setErr(e.message) }
      finally { setLoading(false) }
    })()
  }, [])

  return (
    <Section
      icon={Activity}
      title="会话仪表盘"
      subtitle="受 Reasonix dashboard 启发：每个会话的 token 用量、缓存命中率、消耗积分一览。需要主聊天接口接入后才会有数据。"
    >
      {err && <div className="mb-3 p-2 border border-ember/40 rounded-md text-sm text-ember bg-ember-soft/30">{err}</div>}
      {loading ? (
        <div className="text-sm text-ink-fade">加载中…</div>
      ) : items.length === 0 ? (
        <div className="p-8 text-center text-sm text-ink-fade border border-dashed border-ink-fade/40 rounded-md">
          还没有任何会话数据。等主聊天链路上报后这里会出现。
        </div>
      ) : (
        <div className="overflow-x-auto border border-ink-fade/30 rounded-md">
          <table className="w-full text-sm">
            <thead className="bg-ink/5 text-ink-soft">
              <tr>
                <th className="px-3 py-2 text-left font-normal">会话</th>
                <th className="px-3 py-2 text-right font-normal">轮次</th>
                <th className="px-3 py-2 text-right font-normal">In</th>
                <th className="px-3 py-2 text-right font-normal">Out</th>
                <th className="px-3 py-2 text-right font-normal">缓存命中</th>
                <th className="px-3 py-2 text-right font-normal">积分</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-fade/20">
              {items.map((m) => (
                <tr key={m.sessionId}>
                  <td className="px-3 py-2 font-mono text-xs text-ink-soft truncate max-w-[160px]">{m.sessionId}</td>
                  <td className="px-3 py-2 text-right">{m.turns}</td>
                  <td className="px-3 py-2 text-right font-mono">{m.tokensIn.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right font-mono">{m.tokensOut.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right font-mono">{(m.cacheHitRate * 100).toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right text-ember">-{m.costCredits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

export default function ReasonixWorkspace() {
  const [tab, setTab] = useState('memories')
  const tabs = [
    { id: 'memories', label: '钉记忆', icon: Pin },
    { id: 'todos', label: 'TODO', icon: ListChecks },
    { id: 'effort', label: '思考预算', icon: Gauge },
    { id: 'meters', label: '会话仪表盘', icon: Activity },
  ]
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-ink/20 bg-paper/95 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4">
          <Link
            to="/chat"
            className="flex items-center gap-1 text-sm text-ink-soft hover:text-ink transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            返回对话
          </Link>
          <div className="h-5 w-px bg-ink-fade/40" />
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">REASONIX-INSPIRED</span>
            <h1 className="font-hand text-2xl text-ink">认知工作台</h1>
          </div>
        </div>
        <nav className="max-w-5xl mx-auto px-6 flex gap-1 border-t border-ink-fade/20">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 px-3 py-2 text-sm border-b-2 transition-colors ${
                tab === id ? 'border-ember text-ink' : 'border-transparent text-ink-fade hover:text-ink-soft'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 flex flex-col gap-6">
        {tab === 'memories' && <MemoriesPanel />}
        {tab === 'todos' && <TodosPanel />}
        {tab === 'effort' && <EffortPanel />}
        {tab === 'meters' && <MetersPanel />}
      </main>
    </div>
  )
}
