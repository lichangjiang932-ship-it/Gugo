import { useState } from 'react'
import { Activity, ArrowLeft, Gauge, ListChecks, Pin } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import { Link } from '../lib/router.jsx'
import EffortPanel from './reasonix/EffortPanel.jsx'
import MemoriesPanel from './reasonix/MemoriesPanel.jsx'
import MetersPanel from './reasonix/MetersPanel.jsx'
import TodosPanel from './reasonix/TodosPanel.jsx'

const TAB_DEFINITIONS = [
  { id: 'memories', icon: Pin }, { id: 'todos', icon: ListChecks },
  { id: 'effort', icon: Gauge }, { id: 'meters', icon: Activity },
]

export default function ReasonixWorkspace() {
  const { t } = useT()
  const [tab, setTab] = useState('memories')
  const kindOptions = ['user', 'project', 'feedback', 'reference']
    .map((id) => ({ id, label: t(`reasonix.kinds.${id}`) }))
  const copy = {
    memories: {
      title: t('reasonix.memories.title'),
      subtitle: (count, tokens) => t('reasonix.memories.subtitle', { count, tokens }),
      titlePlaceholder: t('reasonix.memories.titlePlaceholder'),
      contentPlaceholder: t('reasonix.memories.contentPlaceholder'),
      confirmDelete: (title) => t('reasonix.memories.confirmDelete', { title }),
      loading: t('reasonix.memories.loading'),
      empty: t('reasonix.memories.empty'),
      disable: t('reasonix.memories.disable'),
      enable: t('reasonix.memories.enable'),
      delete: t('reasonix.memories.delete'),
    },
    todos: {
      title: t('reasonix.todos.title'),
      subtitle: (count) => t('reasonix.todos.subtitle', { count }),
      placeholder: t('reasonix.todos.placeholder'),
      add: t('reasonix.todos.add'),
      loading: t('reasonix.todos.loading'),
      empty: t('reasonix.todos.empty'),
      confirmDelete: (title) => t('reasonix.todos.confirmDelete', { title }),
    },
    effort: {
      title: t('reasonix.effort.title'),
      loading: t('reasonix.effort.loading'),
      subtitle: t('reasonix.effort.subtitle'),
      preset: (steps, depth) => t('reasonix.effort.preset', { steps, depth }),
      presetLabels: Object.fromEntries(
        ['low', 'medium', 'high', 'ultra']
          .map((id) => [id, t(`reasonix.effort.presets.${id}`)]),
      ),
    },
    meters: {
      title: t('reasonix.meters.title'),
      subtitle: t('reasonix.meters.subtitle'),
      loading: t('reasonix.meters.loading'),
      empty: t('reasonix.meters.empty'),
      headers: ['session', 'turns', 'input', 'output', 'cacheHit']
        .map((key) => t(`reasonix.meters.headers.${key}`)),
    },
  }
  return <div className="min-h-screen bg-paper text-ink">
    <header className="sticky top-0 z-10 border-b border-ink/20 bg-paper/95 backdrop-blur"><div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-4"><Link to="/chat" className="flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"><ArrowLeft className="h-4 w-4" />{t('reasonix.back')}</Link><div className="h-5 w-px bg-ink-fade/40" /><div className="flex items-center gap-2"><span className="font-mono text-[9px] uppercase tracking-[0.22em] text-ink-fade">REASONIX-INSPIRED</span><h1 className="font-semibold text-2xl text-ink">{t('reasonix.title')}</h1></div></div>
      <nav className="mx-auto flex max-w-5xl gap-1 border-t border-ink-fade/20 px-6">{TAB_DEFINITIONS.map(({ id, icon: Icon }) => <button key={id} onClick={() => setTab(id)} className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors ${tab === id ? 'border-accent text-ink' : 'border-transparent text-ink-fade hover:text-ink-soft'}`}><Icon className="h-4 w-4" />{t(`reasonix.tabs.${id}`)}</button>)}</nav>
    </header>
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">{tab === 'memories' && <MemoriesPanel copy={copy.memories} kindOptions={kindOptions} />}{tab === 'todos' && <TodosPanel copy={copy.todos} />}{tab === 'effort' && <EffortPanel copy={copy.effort} />}{tab === 'meters' && <MetersPanel copy={copy.meters} />}</main>
  </div>
}
