import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Circle, MessageSquare, Plug, RefreshCw, Target, Trash2, X } from 'lucide-react'
import { getMcpCatalogApi, listMcpServersApi } from '../../lib/mcpClient.js'
import { getSlashActionCopy } from '../../lib/slashCoreCommands.js'
import { useT } from '../../i18n/I18nProvider.jsx'
import ChatStatusCard from './ChatStatusCard.jsx'

function PanelShell({ testId, icon: Icon, title, closeLabel, onClose, children }) {
  return (
    <section data-testid={testId} className="rounded-card border border-ink/[0.12] bg-paper px-4 py-3.5 shadow-[0_12px_34px_rgb(var(--color-ink-rgb)/0.11)]">
      <div className="flex items-center gap-2.5">
        <Icon className="h-[18px] w-[18px] text-ink-soft" strokeWidth={1.8} />
        <h2 className="flex-1 text-sm font-medium text-ink">{title}</h2>
        <button type="button" onClick={onClose} title={closeLabel} aria-label={closeLabel} className="flex h-7 w-7 items-center justify-center rounded-control text-ink-fade hover:bg-ink/[0.05] hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      </div>
      {children}
    </section>
  )
}

function McpStatusPanel({ copy, onClose, onManage }) {
  const [state, setState] = useState({ loading: true, error: '', servers: [], catalog: [] })
  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: '' }))
    try {
      const [serverData, catalogData] = await Promise.all([listMcpServersApi(), getMcpCatalogApi()])
      setState({ loading: false, error: '', servers: serverData.servers || [], catalog: catalogData.catalog || [] })
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error?.message || copy.loadError }))
    }
  }, [copy.loadError])

  useEffect(() => { load() }, [load])
  const runtimeById = useMemo(() => new Map(state.catalog.map((item) => [item.serverId, item])), [state.catalog])
  const connectedCount = state.servers.filter((server) => runtimeById.get(server.id)?.connected === true).length

  return (
    <PanelShell testId="slash-mcp-panel" icon={Plug} title={copy.title} closeLabel={copy.close} onClose={onClose}>
      {state.loading && <div className="mt-3 flex items-center gap-2 rounded-card bg-ink/[0.035] px-3 py-3 text-xs text-ink-fade"><RefreshCw className="h-3.5 w-3.5 animate-spin" />{copy.loading}</div>}
      {!state.loading && state.error && (
        <div className="mt-3 flex items-center gap-3 rounded-card border border-ink/10 border-l-2 border-l-danger/55 bg-paper-2/45 px-3 py-2.5 text-xs text-ink-soft">
          <span className="min-w-0 flex-1 truncate" title={state.error}>{copy.loadError}: {state.error}</span>
          <button type="button" onClick={load} className="rounded-control px-2 py-1 text-danger hover:bg-ink/[0.045]">{copy.retry}</button>
        </div>
      )}
      {!state.loading && !state.error && (
        <>
          <div className="mt-3 flex items-center gap-2 text-xs text-ink-fade">
            <span>{state.servers.length} {copy.configured}</span><span aria-hidden="true">·</span><span className="text-success">{connectedCount} {copy.connected}</span>
          </div>
          {state.servers.length === 0 ? (
            <div className="mt-3 rounded-card bg-ink/[0.035] px-3 py-4 text-center text-xs text-ink-fade">{copy.empty}</div>
          ) : (
            <div className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">
              {state.servers.map((server) => {
                const runtime = runtimeById.get(server.id)
                const connected = runtime?.connected === true
                return (
                  <div key={server.id} className="flex items-center gap-3 rounded-card px-3 py-2 hover:bg-ink/[0.035]">
                    <span className={`h-2 w-2 shrink-0 rounded-pill ${connected ? 'bg-success' : 'bg-ink/20'}`} />
                    <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium text-ink">{server.name || server.id}</div><div className="truncate text-xs text-ink-fade">{server.transport || 'stdio'}</div></div>
                    <div className="text-right text-xs text-ink-fade"><div>{connected ? copy.connected : copy.disconnected}</div>{connected && <div>{runtime?.tools?.length || 0} {copy.tools}</div>}</div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
      <div className="mt-3 flex justify-end border-t border-ink/[0.08] pt-2.5"><button type="button" onClick={onManage} className="rounded-control px-2.5 py-1.5 text-xs text-ink-soft hover:bg-ink/[0.05] hover:text-ink">{copy.manage}</button></div>
    </PanelShell>
  )
}

function FeedbackPanel({ copy, onClose, onSubmit }) {
  const [value, setValue] = useState('')
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const feedback = value.trim()
    if (!feedback || busy) { if (!feedback) setNotice({ type: 'error', text: copy.required }); return }
    setBusy(true)
    try {
      const saved = await onSubmit?.(feedback)
      if (saved === false) { setNotice({ type: 'error', text: copy.failed }); return }
      setValue('')
      setNotice({ type: 'success', text: copy.saved })
    } catch {
      setNotice({ type: 'error', text: copy.failed })
    } finally {
      setBusy(false)
    }
  }
  return (
    <PanelShell testId="slash-feedback-panel" icon={MessageSquare} title={copy.title} closeLabel={copy.close} onClose={onClose}>
      <textarea autoFocus value={value} onChange={(event) => { setValue(event.target.value); setNotice({ type: '', text: '' }) }} placeholder={copy.placeholder} rows={3} className="mt-3 w-full resize-none rounded-card border border-ink/[0.12] bg-paper-2/60 px-3 py-2.5 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-fade focus:border-ink/25" />
      <div className="mt-1.5 min-h-4 text-xs text-ink-fade">{notice.text ? <span className={notice.type === 'error' ? 'text-danger' : 'text-success'}>{notice.text}</span> : copy.note}</div>
      <div className="mt-2 flex justify-end gap-2"><button type="button" onClick={onClose} disabled={busy} className="rounded-control px-3 py-1.5 text-xs text-ink-soft hover:bg-ink/[0.05] disabled:opacity-40">{copy.cancel}</button><button type="button" onClick={submit} disabled={busy} className="rounded-control bg-ink px-3 py-1.5 text-xs text-paper hover:bg-ink/85 disabled:opacity-40">{copy.submit}</button></div>
    </PanelShell>
  )
}

function goalText(goal) { return String(goal?.text ?? goal?.content ?? '') }
function goalDone(goal) { return goal?.done === true || goal?.status === 'completed' || goal?.status === 'done' }
function updateGoalDone(goal, done) {
  if (Object.prototype.hasOwnProperty.call(goal || {}, 'content') || Object.prototype.hasOwnProperty.call(goal || {}, 'status')) return { ...goal, status: done ? 'completed' : 'pending' }
  return { ...goal, done }
}

function GoalsPanel({ copy, todos, onClose, onChange }) {
  const [value, setValue] = useState('')
  const list = Array.isArray(todos) ? todos : []
  const add = () => {
    const text = value.trim()
    if (!text) return
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    onChange?.([...list, { id, text, done: false }])
    setValue('')
  }
  return (
    <PanelShell testId="slash-goals-panel" icon={Target} title={copy.title} closeLabel={copy.close} onClose={onClose}>
      <div className="mt-3 flex gap-2"><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add() } }} placeholder={copy.placeholder} className="h-9 min-w-0 flex-1 rounded-control border border-ink/[0.12] bg-paper-2/60 px-3 text-[13px] text-ink outline-none placeholder:text-ink-fade focus:border-ink/25" /><button type="button" onClick={add} disabled={!value.trim()} className="rounded-control bg-ink px-3 text-xs text-paper hover:bg-ink/85 disabled:opacity-35">{copy.add}</button></div>
      {list.length === 0 ? <div className="mt-3 rounded-card bg-ink/[0.035] px-3 py-4 text-center text-xs text-ink-fade">{copy.empty}</div> : (
        <div className="mt-3 max-h-48 space-y-1 overflow-y-auto">
          {list.map((goal, index) => {
            const done = goalDone(goal)
            return <div key={goal.id || index} className="group flex items-center gap-2 rounded-card px-2 py-2 hover:bg-ink/[0.035]"><button type="button" onClick={() => onChange?.(list.map((item, itemIndex) => itemIndex === index ? updateGoalDone(item, !done) : item))} title={done ? copy.markOpen : copy.markDone} aria-label={done ? copy.markOpen : copy.markDone} className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-pill ${done ? 'text-success' : 'text-ink-fade hover:text-ink'}`}>{done ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}</button><span className={`min-w-0 flex-1 truncate text-[13px] ${done ? 'text-ink-fade line-through' : 'text-ink'}`}>{goalText(goal)}</span><span className="text-xs text-ink-fade">{done ? copy.completed : copy.active}</span><button type="button" onClick={() => onChange?.(list.filter((_, itemIndex) => itemIndex !== index))} title={copy.remove} aria-label={copy.remove} className="flex h-6 w-6 items-center justify-center rounded-control text-ink-fade opacity-0 hover:bg-ink/[0.045] hover:text-danger group-hover:opacity-100 focus:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button></div>
          })}
        </div>
      )}
    </PanelShell>
  )
}

export default function SlashInlinePanelHost({ panel, onClose, statusProps, todos, onGoalsChange, onSubmitFeedback, onManageMcp }) {
  const { lang } = useT()
  const copy = getSlashActionCopy(lang)
  if (!panel) return null
  let content = null
  if (panel === 'status') content = <ChatStatusCard {...statusProps} onClose={onClose} />
  if (panel === 'mcp') content = <McpStatusPanel copy={copy.mcpPanel} onClose={onClose} onManage={onManageMcp} />
  if (panel === 'feedback') content = <FeedbackPanel copy={copy.feedbackPanel} onClose={onClose} onSubmit={onSubmitFeedback} />
  if (panel === 'goals') content = <GoalsPanel copy={copy.goalsPanel} todos={todos} onClose={onClose} onChange={onGoalsChange} />
  return content ? <div className="mx-auto w-full max-w-[872px] px-4 pb-2">{content}</div> : null
}
