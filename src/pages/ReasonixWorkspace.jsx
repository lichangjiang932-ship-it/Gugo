import { useState } from 'react'
import { Activity, ArrowLeft, Gauge, ListChecks, Pin } from 'lucide-react'
import { Link } from '../lib/router.jsx'
import EffortPanel from './reasonix/EffortPanel.jsx'
import MemoriesPanel from './reasonix/MemoriesPanel.jsx'
import MetersPanel from './reasonix/MetersPanel.jsx'
import TodosPanel from './reasonix/TodosPanel.jsx'

const KIND_OPTIONS = [
  { id: 'user', label: '个人偏好' }, { id: 'project', label: '项目上下文' },
  { id: 'feedback', label: '历史反馈' }, { id: 'reference', label: '参考资料' },
]
const COPY = {
  back: '返回对话', title: '认知工作台',
  memories: { title: '钉记忆', subtitle: (count, tokens) => `受 Reasonix memory 启发：把长期偏好钉到模型 prefix，自动注入到每次对话。当前启用 ${count} 条 · 约 ${tokens} tokens`, titlePlaceholder: '标题，例如「我偏好简体中文回答」', contentPlaceholder: '内容（≤4000 字）', confirmDelete: (title) => `删除「${title}」？`, loading: '加载中…', empty: '还没有钉住的记忆。试试加一条「我偏好简体中文 / 我用 macOS / 我喜欢 TDD」之类。', disable: '已启用，点击禁用', enable: '已禁用，点击启用', delete: '删除' },
  todos: { title: 'TODO', subtitle: (count) => `受 Reasonix /todo 启发：跨会话持久化的小任务列表。未完成 ${count} 条。`, placeholder: '加一条新任务，回车提交…', add: '添加', loading: '加载中…', empty: '清空状态。先休息一下。', confirmDelete: (title) => `删除「${title}」？` },
  effort: { title: '思考预算 (effort)', loading: '加载中…', subtitle: '受 Reasonix /effort 启发：用一个旋钮决定每次对话最多走多少步、思考多深。', preset: (steps, depth) => `${steps} 步 · 思考深度 ${depth}` },
  meters: { title: '会话仪表盘', subtitle: '受 Reasonix dashboard 启发：集中查看每个会话的调用次数、token 用量与缓存命中率。', loading: '加载中…', empty: '还没有任何会话数据。等主聊天链路上报后这里会出现。', headers: ['会话', '轮次', 'In', 'Out', '缓存命中'] },
}
const TABS = [
  { id: 'memories', label: '钉记忆', icon: Pin }, { id: 'todos', label: 'TODO', icon: ListChecks },
  { id: 'effort', label: '思考预算', icon: Gauge }, { id: 'meters', label: '会话仪表盘', icon: Activity },
]

export default function ReasonixWorkspace() {
  const [tab, setTab] = useState('memories')
  return <div className="min-h-screen bg-paper text-ink">
    <header className="sticky top-0 z-10 border-b border-ink/20 bg-paper/95 backdrop-blur"><div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-4"><Link to="/chat" className="flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"><ArrowLeft className="h-4 w-4" />{COPY.back}</Link><div className="h-5 w-px bg-ink-fade/40" /><div className="flex items-center gap-2"><span className="font-mono text-[9px] uppercase tracking-[0.22em] text-ink-fade">REASONIX-INSPIRED</span><h1 className="font-semibold text-2xl text-ink">{COPY.title}</h1></div></div>
      <nav className="mx-auto flex max-w-5xl gap-1 border-t border-ink-fade/20 px-6">{TABS.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setTab(id)} className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors ${tab === id ? 'border-ember text-ink' : 'border-transparent text-ink-fade hover:text-ink-soft'}`}><Icon className="h-4 w-4" />{label}</button>)}</nav>
    </header>
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">{tab === 'memories' && <MemoriesPanel copy={COPY.memories} kindOptions={KIND_OPTIONS} />}{tab === 'todos' && <TodosPanel copy={COPY.todos} />}{tab === 'effort' && <EffortPanel copy={COPY.effort} />}{tab === 'meters' && <MetersPanel copy={COPY.meters} />}</main>
  </div>
}
