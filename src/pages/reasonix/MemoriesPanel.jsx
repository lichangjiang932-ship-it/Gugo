import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pin, Plus, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react'
import { createMemory, deleteMemory, listMemories, updateMemory } from '../../lib/reasonixClient.js'
import Section from './Section.jsx'

export default function MemoriesPanel({ copy, kindOptions }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState({ title: '', content: '', kind: 'user' })
  const [submitting, setSubmitting] = useState(false)
  const refresh = useCallback(async () => {
    setLoading(true)
    try { setItems((await listMemories()).memories || []); setError('') } catch (caught) { setError(caught.message) } finally { setLoading(false) }
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time async fetch; state updates happen after the request settles.
  useEffect(() => { refresh() }, [refresh])
  const totalTokens = useMemo(() => items.filter((item) => item.enabled).reduce((sum, item) => sum + item.tokens, 0), [items])
  const submit = async (event) => {
    event.preventDefault()
    if (!draft.title.trim() || !draft.content.trim()) return
    setSubmitting(true)
    try { await createMemory(draft); setDraft({ title: '', content: '', kind: 'user' }); await refresh() } catch (caught) { setError(caught.message) } finally { setSubmitting(false) }
  }
  const toggle = async (item) => { try { await updateMemory(item.id, { enabled: !item.enabled }); await refresh() } catch (caught) { setError(caught.message) } }
  const remove = async (item) => { if (!confirm(copy.confirmDelete(item.title))) return; try { await deleteMemory(item.id); await refresh() } catch (caught) { setError(caught.message) } }

  return <Section icon={Pin} title={copy.title} subtitle={copy.subtitle(items.filter((item) => item.enabled).length, totalTokens)}>
    <form onSubmit={submit} className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-12">
      <select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value }))} className="h-9 rounded-md border border-ink/30 bg-paper px-2 text-sm text-ink md:col-span-2">{kindOptions.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}</select>
      <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder={copy.titlePlaceholder} className="h-9 rounded-md border border-ink/30 bg-paper px-3 text-sm text-ink md:col-span-4" />
      <input value={draft.content} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} placeholder={copy.contentPlaceholder} className="h-9 rounded-md border border-ink/30 bg-paper px-3 text-sm text-ink md:col-span-5" />
      <button type="submit" disabled={submitting || !draft.title.trim() || !draft.content.trim()} className="flex h-9 items-center justify-center gap-1 rounded-md bg-ink px-3 text-sm text-paper hover:bg-ink-soft disabled:opacity-50 md:col-span-1"><Plus className="h-4 w-4" /></button>
    </form>
    {error && <div className="mb-3 rounded-md border border-ember/40 bg-ember-soft/30 p-2 text-sm text-ember">{error}</div>}
    {loading ? <div className="text-sm text-ink-fade">{copy.loading}</div> : items.length === 0 ? <div className="rounded-md border border-dashed border-ink-fade/40 p-8 text-center text-sm text-ink-fade">{copy.empty}</div> : <div className="divide-y divide-ink-fade/20 rounded-md border border-ink-fade/30">{items.map((item) => <div key={item.id} className="flex items-start gap-3 p-3">
      <button onClick={() => toggle(item)} className="mt-0.5 shrink-0 text-ink-fade hover:text-ember" title={item.enabled ? copy.disable : copy.enable}>{item.enabled ? <ToggleRight className="h-5 w-5 text-ember" /> : <ToggleLeft className="h-5 w-5" />}</button>
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="rounded bg-ink/5 px-1.5 py-0.5 font-mono text-xs text-ink-soft">{kindOptions.find((kind) => kind.id === item.kind)?.label || item.kind}</span><span className="truncate font-semibold text-base text-ink">{item.title}</span><span className="ml-auto font-mono text-xs text-ink-fade">~{item.tokens}t</span></div><div className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-soft">{item.content}</div></div>
      <button onClick={() => remove(item)} className="shrink-0 text-ink-fade hover:text-ember" title={copy.delete}><Trash2 className="h-4 w-4" /></button>
    </div>)}</div>}
  </Section>
}
