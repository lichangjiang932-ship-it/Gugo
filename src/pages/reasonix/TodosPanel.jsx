import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Circle, ListChecks, Trash2 } from 'lucide-react'
import { createTodo, deleteTodo, listTodos, updateTodo } from '../../lib/reasonixClient.js'
import Section from './Section.jsx'

export default function TodosPanel({ copy }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const refresh = useCallback(async () => { setLoading(true); try { setItems((await listTodos()).todos || []); setError('') } catch (caught) { setError(caught.message) } finally { setLoading(false) } }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time async fetch; state updates happen after the request settles.
  useEffect(() => { refresh() }, [refresh])
  const add = async (event) => { event.preventDefault(); if (!title.trim()) return; try { await createTodo({ title: title.trim() }); setTitle(''); await refresh() } catch (caught) { setError(caught.message) } }
  const toggle = async (item) => { try { await updateTodo(item.id, { status: item.status === 'done' ? 'pending' : 'done' }); await refresh() } catch (caught) { setError(caught.message) } }
  const remove = async (item) => { if (!confirm(copy.confirmDelete(item.title))) return; try { await deleteTodo(item.id); await refresh() } catch (caught) { setError(caught.message) } }
  const pendingCount = items.filter((item) => item.status !== 'done').length
  return <Section icon={ListChecks} title={copy.title} subtitle={copy.subtitle(pendingCount)}>
    <form onSubmit={add} className="mb-4 flex gap-2"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={copy.placeholder} className="h-9 flex-1 rounded-md border border-ink/30 bg-paper px-3 text-sm text-ink" /><button type="submit" disabled={!title.trim()} className="h-9 rounded-md bg-ink px-4 text-sm text-paper hover:bg-ink-soft disabled:opacity-50">{copy.add}</button></form>
    {error && <div className="mb-3 rounded-md border border-danger/40 bg-danger/5 p-2 text-sm text-danger">{error}</div>}
    {loading ? <div className="text-sm text-ink-fade">{copy.loading}</div> : items.length === 0 ? <div className="rounded-md border border-dashed border-ink-fade/40 p-8 text-center text-sm text-ink-fade">{copy.empty}</div> : <ul className="divide-y divide-ink-fade/20 rounded-md border border-ink-fade/30">{items.map((item) => <li key={item.id} className="flex items-center gap-3 p-3"><button onClick={() => toggle(item)} className="shrink-0 text-ink-fade hover:text-accent-ink">{item.status === 'done' ? <CheckCircle2 className="h-5 w-5 text-accent-ink" /> : <Circle className="h-5 w-5" />}</button><span className={`flex-1 text-sm ${item.status === 'done' ? 'text-ink-fade line-through' : 'text-ink'}`}>{item.title}</span><button onClick={() => remove(item)} className="shrink-0 text-ink-fade hover:text-accent-ink"><Trash2 className="h-4 w-4" /></button></li>)}</ul>}
  </Section>
}
