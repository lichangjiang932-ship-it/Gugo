import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Circle, MessageSquare, Plug, RefreshCw, Target, Trash2, X } from 'lucide-react'
import { getMcpCatalogApi, listMcpServersApi } from '../../lib/mcpClient.js'
import {
  approveGoalPlanApi,
  createGoalPlanApi,
  listGoalPlansApi,
  pickActivePlan,
  setGoalStepStatusApi,
  showGoalPlanApi,
} from '../../lib/goalPlanClient.js'
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

const STEP_ICON = { done: Check, in_progress: RefreshCw, blocked: X, skipped: X, pending: Circle }
const STEP_LABEL_KEY = {
  pending: 'statusPending',
  in_progress: 'statusInProgress',
  done: 'statusDone',
  blocked: 'statusBlocked',
  skipped: 'statusSkipped',
}

/**
 * The panel reads and writes the host-persisted plan, not a client checklist.
 *
 * It deliberately cannot mark a step `done`: completion requires evidence the
 * host verifies against persisted Turn events, and the UI has no such thing to
 * cite. The only completion path is the agent calling `goal_step_update`.
 */
function GoalsPanel({ copy, todos, sessionId, onClose, onChange }) {
  const [value, setValue] = useState('')
  const [state, setState] = useState({ loadedFor: '', plan: null, error: '', busy: false })
  const [refreshToken, setRefreshToken] = useState(0)
  const legacy = Array.isArray(todos) ? todos : []
  // Derived, not stored: state is only ever written from async callbacks, so
  // the effect below never sets state during its synchronous phase.
  const loading = Boolean(sessionId) && state.loadedFor !== sessionId && !state.error
  const plan = state.plan

  useEffect(() => {
    if (!sessionId) return undefined
    let cancelled = false
    Promise.resolve()
      .then(() => listGoalPlansApi({ sessionId, limit: 20 }))
      .then((data) => {
        if (cancelled) return null
        const active = pickActivePlan(data?.plans || [])
        return active ? showGoalPlanApi(active.id) : null
      })
      .then((detail) => {
        if (cancelled) return
        setState({ loadedFor: sessionId, plan: detail?.plan || null, error: '', busy: false })
      })
      .catch((error) => {
        if (cancelled) return
        setState({ loadedFor: sessionId, plan: null, error: error?.message || copy.loadFailed, busy: false })
      })
    return () => { cancelled = true }
  }, [sessionId, refreshToken, copy.loadFailed])

  const reload = () => setRefreshToken((token) => token + 1)

  const run = async (work) => {
    setState((current) => ({ ...current, busy: true, error: '' }))
    try {
      await work()
      reload()
      setState((current) => ({ ...current, busy: false, error: '' }))
    } catch (error) {
      setState((current) => ({ ...current, busy: false, error: error?.message || copy.loadFailed }))
    }
  }

  const createPlan = () => {
    const objective = value.trim()
    if (!objective) return
    setValue('')
    return run(() => createGoalPlanApi({ objective, steps: [{ title: objective }], sessionId: sessionId || null }))
  }

  return (
    <PanelShell testId="slash-goals-panel" icon={Target} title={copy.title} closeLabel={copy.close} onClose={onClose}>
      <div className="mt-3 flex gap-2"><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); createPlan() } }} placeholder={copy.placeholder} className="h-9 min-w-0 flex-1 rounded-control border border-ink/[0.12] bg-paper-2/60 px-3 text-[13px] text-ink outline-none placeholder:text-ink-fade focus:border-ink/25" /><button type="button" onClick={createPlan} disabled={!value.trim() || state.busy} className="rounded-control bg-ink px-3 text-xs text-paper hover:bg-ink/85 disabled:opacity-35">{copy.add}</button></div>
      {state.error ? <p data-testid="slash-goals-error" className="mt-3 text-xs text-danger">{state.error}</p> : null}
      {loading ? <p className="mt-3 text-xs text-ink-fade">{copy.loading}</p> : null}
      {!loading && !plan && !legacy.length ? <div className="mt-3 rounded-card bg-ink/[0.035] px-3 py-4 text-center text-xs text-ink-fade">{copy.empty}</div> : null}
      {plan ? (
        <div className="mt-3" data-testid="slash-goals-plan">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{plan.objective}</span>
            <span className="text-xs text-ink-fade">{copy.revision} {plan.revision}</span>
            <span
              data-testid="slash-goals-plan-status"
              className={`rounded-pill px-2 py-0.5 text-xs ${plan.status === 'awaiting_approval' ? 'bg-warn/15 text-warn' : 'bg-ink/[0.055] text-ink-soft'}`}
            >
              {plan.status === 'awaiting_approval' ? copy.awaitingApproval : copy[plan.status] || plan.status}
            </span>
          </div>
          {plan.status === 'awaiting_approval' ? (
            <button type="button" disabled={state.busy} onClick={() => run(() => approveGoalPlanApi({ planId: plan.id, expectedVersion: plan.version }))} className="mt-2 rounded-control bg-ink px-3 py-1.5 text-xs text-paper hover:bg-ink/85 disabled:opacity-35">{state.busy ? copy.approving : copy.approve}</button>
          ) : null}
          <div className="mt-2 max-h-60 space-y-1 overflow-y-auto">
            {(plan.steps || []).map((step) => {
              const Icon = STEP_ICON[step.status] || Circle
              const verified = step.evidenceVerified === true
              const canReopen = step.status === 'done'
              const canStart = step.status === 'pending' || step.status === 'blocked' || step.status === 'skipped'
              return (
                <div key={step.id} data-testid={`slash-goals-step-${step.ordinal}`} className="flex items-center gap-2 rounded-card px-2 py-2 hover:bg-ink/[0.035]">
                  <Icon className={`h-4 w-4 shrink-0 ${verified ? 'text-success' : 'text-ink-fade'}`} strokeWidth={1.8} />
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${step.status === 'done' ? 'text-ink-soft' : 'text-ink'}`} title={verified ? copy.verified : undefined}>{step.ordinal + 1}. {step.title}</span>
                  <span className="text-xs text-ink-fade">{copy[STEP_LABEL_KEY[step.status]] || step.status}</span>
                  {canStart ? <button type="button" disabled={state.busy} onClick={() => run(() => setGoalStepStatusApi({ planId: plan.id, stepId: step.id, status: 'in_progress', expectedVersion: plan.version }))} title={copy.start} aria-label={copy.start} className="flex h-6 w-6 items-center justify-center rounded-control text-ink-fade hover:bg-ink/[0.045] hover:text-ink disabled:opacity-35"><RefreshCw className="h-3.5 w-3.5" /></button> : null}
                  {canReopen ? <button type="button" disabled={state.busy} onClick={() => run(() => setGoalStepStatusApi({ planId: plan.id, stepId: step.id, status: 'in_progress', expectedVersion: plan.version }))} title={copy.reopen} aria-label={copy.reopen} className="flex h-6 w-6 items-center justify-center rounded-control text-ink-fade hover:bg-ink/[0.045] hover:text-ink disabled:opacity-35"><RefreshCw className="h-3.5 w-3.5" /></button> : null}
                  {step.status !== 'blocked' && step.status !== 'done' ? <button type="button" disabled={state.busy} onClick={() => run(() => setGoalStepStatusApi({ planId: plan.id, stepId: step.id, status: 'blocked', expectedVersion: plan.version }))} title={copy.block} aria-label={copy.block} className="flex h-6 w-6 items-center justify-center rounded-control text-ink-fade hover:bg-ink/[0.045] hover:text-danger disabled:opacity-35"><X className="h-3.5 w-3.5" /></button> : null}
                  {step.status !== 'skipped' && step.status !== 'done' ? <button type="button" disabled={state.busy} onClick={() => run(() => setGoalStepStatusApi({ planId: plan.id, stepId: step.id, status: 'skipped', expectedVersion: plan.version }))} title={copy.skip} aria-label={copy.skip} className="flex h-6 w-6 items-center justify-center rounded-control text-ink-fade hover:bg-ink/[0.045] hover:text-ink disabled:opacity-35"><Trash2 className="h-3.5 w-3.5" /></button> : null}
                </div>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-ink-fade">{copy.doneNeedsEvidence}</p>
          <button type="button" onClick={reload} className="mt-2 text-xs text-ink-fade underline hover:text-ink">{copy.title}</button>
        </div>
      ) : null}
      {legacy.length > 0 ? (
        <div className="mt-3" data-testid="slash-goals-legacy">
          <p className="text-xs text-ink-fade">{copy.legacy}</p>
          <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
            {legacy.map((goal, index) => {
              const done = goalDone(goal)
              return <div key={goal.id || index} className="group flex items-center gap-2 rounded-card px-2 py-2 hover:bg-ink/[0.035]"><button type="button" onClick={() => onChange?.(legacy.map((item, itemIndex) => itemIndex === index ? updateGoalDone(item, !done) : item))} title={done ? copy.markOpen : copy.markDone} aria-label={done ? copy.markOpen : copy.markDone} className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-pill ${done ? 'text-success' : 'text-ink-fade hover:text-ink'}`}>{done ? <Check className="h-4 w-4" /> : <Circle className="h-4 w-4" />}</button><span className={`min-w-0 flex-1 truncate text-[13px] ${done ? 'text-ink-fade line-through' : 'text-ink'}`}>{goalText(goal)}</span><span className="text-xs text-ink-fade">{done ? copy.completed : copy.active}</span><button type="button" onClick={() => onChange?.(legacy.filter((_, itemIndex) => itemIndex !== index))} title={copy.remove} aria-label={copy.remove} className="flex h-6 w-6 items-center justify-center rounded-control text-ink-fade opacity-0 hover:bg-ink/[0.045] hover:text-danger group-hover:opacity-100 focus:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button></div>
            })}
          </div>
        </div>
      ) : null}
    </PanelShell>
  )
}

export default function SlashInlinePanelHost({ panel, onClose, statusProps, todos, sessionId, onGoalsChange, onSubmitFeedback, onManageMcp }) {
  const { lang } = useT()
  const copy = getSlashActionCopy(lang)
  if (!panel) return null
  let content = null
  if (panel === 'status') content = <ChatStatusCard {...statusProps} onClose={onClose} />
  if (panel === 'mcp') content = <McpStatusPanel copy={copy.mcpPanel} onClose={onClose} onManage={onManageMcp} />
  if (panel === 'feedback') content = <FeedbackPanel copy={copy.feedbackPanel} onClose={onClose} onSubmit={onSubmitFeedback} />
  if (panel === 'goals') content = <GoalsPanel copy={copy.goalsPanel} todos={todos} sessionId={sessionId} onClose={onClose} onChange={onGoalsChange} />
  return content ? <div className="mx-auto w-full max-w-[872px] px-4 pb-2">{content}</div> : null
}
