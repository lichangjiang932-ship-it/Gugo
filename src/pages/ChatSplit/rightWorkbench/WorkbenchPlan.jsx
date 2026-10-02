import { useCallback, useEffect, useState } from 'react'
import { Ban, Check, ChevronDown, Circle, CircleDot, Loader2, Minus, RefreshCw, ShieldCheck } from 'lucide-react'
import { approveGoalPlanApi, listGoalPlansApi, pickActivePlan, showGoalPlanApi } from '../../../lib/goalPlanClient.js'
import { subscribeGoalPlanChanged } from '../../../lib/goalPlanSignals.js'

/**
 * What this session is doing, in three parts: the task list the agent keeps, the
 * plan it is working through, and what it has produced.
 *
 * The data already exists — nothing here invents state:
 *   · todos  → the session's own `manage_todos` list
 *   · plan   → the goal plan for this session, through the same client the slash
 *              goals panel uses
 *   · output → the artifacts the panel already collected from the transcript
 *
 * The plan lives on the server and the agent edits it *during* a turn, so the
 * panel re-reads on every signal that a turn may have moved it (see
 * lib/goalPlanSignals.js) rather than only once when it was opened. A panel that
 * read once showed a plan frozen at that moment, which reads as "the plan is not
 * being followed".
 */
const TODO_STATUS_KEYS = Object.freeze({
  completed: 'workbench.planTodoDone',
  in_progress: 'workbench.planTodoActive',
})

const PLAN_STATUS_KEYS = Object.freeze({
  awaiting_approval: 'workbench.planStatusAwaiting',
  approved: 'workbench.planStatusApproved',
  completed: 'workbench.planStatusCompleted',
  blocked: 'workbench.planStatusBlocked',
  cancelled: 'workbench.planStatusCancelled',
  superseded: 'workbench.planStatusSuperseded',
})

const STEP_ICONS = Object.freeze({
  done: Check,
  in_progress: Loader2,
  blocked: Ban,
  skipped: Minus,
  pending: Circle,
})
const STEP_STATUS_KEYS = Object.freeze({
  done: 'workbench.planStepDone',
  in_progress: 'workbench.planStepActive',
  blocked: 'workbench.planStepBlocked',
  skipped: 'workbench.planStepSkipped',
  pending: 'workbench.planStepPending',
})

function todoLabel(todo) {
  return String(todo?.activeForm || todo?.content || todo?.title || '').trim()
}

function stepIconClass(status) {
  if (status === 'done') return 'text-success'
  if (status === 'blocked') return 'text-danger'
  return 'text-ink-fade'
}

/**
 * How a step's evidence reads to a person.
 *
 * The host verifies evidence fail-closed, so the panel's job is to stop a "done"
 * from looking identical whether or not anything backed it. Four states, in
 * descending strength: host-verified, present-but-unverified, manually confirmed,
 * and none at all on a step that claims to be finished.
 */
function stepEvidenceState(step) {
  if (step?.evidenceVerified === true) return 'verified'
  if (step?.evidence?.manualConfirmed === true) return 'manual'
  if (step?.evidence) return 'unverified'
  if (step?.status === 'done') return 'missing'
  return 'none'
}

const EVIDENCE_KEYS = Object.freeze({
  verified: 'workbench.planEvidenceVerified',
  manual: 'workbench.planEvidenceManual',
  unverified: 'workbench.planEvidenceUnverified',
  missing: 'workbench.planEvidenceMissing',
})

const EVIDENCE_CLASSES = Object.freeze({
  verified: 'text-success',
  manual: 'text-running',
  unverified: 'text-warning',
  missing: 'text-danger',
})

function TodoMark({ status }) {
  if (status === 'completed') {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success" aria-hidden="true">
        <Check className="h-2.5 w-2.5 text-paper" strokeWidth={3.25} />
      </span>
    )
  }
  if (status === 'in_progress') {
    // A ring with a live centre rather than a spinner: one task is "the one",
    // and a spinning glyph on a list reads as loading, not as focus.
    return <CircleDot className="plan-todo-active-dot mt-0.5 h-4 w-4 shrink-0 text-running" strokeWidth={2} aria-hidden="true" />
  }
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-ink/25" strokeWidth={1.75} aria-hidden="true" />
}

function TaskList({ t, taskList }) {
  const done = taskList.filter((todo) => todo?.status === 'completed').length
  const percent = taskList.length ? Math.round((done / taskList.length) * 100) : 0
  return (
    <>
      <div className="mb-2.5 flex items-center gap-2" data-testid="workbench-plan-progress">
        <div
          className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-ink/[0.08]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={taskList.length}
          aria-valuenow={done}
          aria-label={t('workbench.planProgress', { done, total: taskList.length })}
        >
          <div className="h-full rounded-full bg-success transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
        <span className="shrink-0 font-mono text-xs tabular-nums text-ink-fade">{done}/{taskList.length}</span>
      </div>
      <ul className="space-y-0.5">
        {taskList.map((todo, index) => {
          const status = todo?.status || 'pending'
          return (
            <li
              key={todo?.id || index}
              className={`flex items-start gap-2 rounded-control px-1.5 py-1 text-xs leading-5 ${status === 'in_progress' ? 'bg-running/[0.07]' : ''}`}
              data-testid="workbench-plan-task"
              data-status={status}
              aria-current={status === 'in_progress' ? 'step' : undefined}
            >
              <TodoMark status={status} />
              <span className={`min-w-0 ${status === 'completed' ? 'text-ink-fade line-through decoration-ink/30' : status === 'in_progress' ? 'font-medium text-ink' : 'text-ink-soft'}`}>
                <span className="sr-only">{t(TODO_STATUS_KEYS[status] || 'workbench.planTodoPending')}</span>
                {todoLabel(todo)}
              </span>
            </li>
          )
        })}
      </ul>
    </>
  )
}

function Section({ action, children, count, testId, title }) {
  return (
    <section className="border-b border-ink/[0.08] px-3 py-3 last:border-b-0" data-testid={testId}>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink">{title}</h3>
        {Number.isFinite(count) && count > 0 && <span className="font-mono text-xs text-ink-fade">{count}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  )
}

function PlanStep({ onRevealTurn, step, t }) {
  const [open, setOpen] = useState(false)
  const Icon = STEP_ICONS[step?.status] || Circle
  const evidence = step?.evidence
  const state = stepEvidenceState(step)
  const detailId = `plan-step-evidence-${step?.id || step?.ordinal}`
  return (
    <li className="text-xs leading-5" data-testid="workbench-plan-step" data-status={step?.status || 'pending'} data-evidence={state}>
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${stepIconClass(step?.status)} ${step?.status === 'in_progress' ? 'animate-spin' : ''}`} aria-hidden="true" />
        <span className="w-4 shrink-0 text-right font-mono text-ink-fade">{step?.ordinal}</span>
        <span className={`min-w-0 flex-1 ${step?.status === 'done' ? 'text-ink-fade' : 'text-ink-soft'}`}>
          <span className="sr-only">{t(STEP_STATUS_KEYS[step?.status] || 'workbench.planStepPending')}</span>
          {step?.title}
        </span>
        {state !== 'none' && (
          <button
            type="button"
            data-testid="workbench-plan-step-toggle"
            aria-expanded={open}
            aria-controls={detailId}
            title={t(EVIDENCE_KEYS[state])}
            onClick={() => setOpen((value) => !value)}
            className={`flex shrink-0 items-center gap-1 rounded-control px-1.5 py-0.5 text-xs hover:bg-ink/[0.05] ${EVIDENCE_CLASSES[state]}`}
          >
            {state === 'verified' ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            <span className="max-w-[7rem] truncate">{t(EVIDENCE_KEYS[state])}</span>
            <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && (
        <div id={detailId} data-testid="workbench-plan-step-evidence" className="mt-1 ml-6 space-y-0.5 rounded-control bg-ink/[0.035] px-2 py-1.5 font-mono text-xs text-ink-fade">
          {evidence?.toolCallId && <p data-testid="workbench-plan-evidence-tool">{`${t('workbench.planEvidenceToolCall')}: ${evidence.toolCallId}`}</p>}
          {evidence?.turnId && <p data-testid="workbench-plan-evidence-turn">{`${t('workbench.planEvidenceTurn')}: ${evidence.turnId}`}</p>}
          {evidence?.confirmedBy && <p>{`${t('workbench.planEvidenceConfirmedBy')}: ${evidence.confirmedBy}`}</p>}
          {evidence?.note && <p className="font-sans">{evidence.note}</p>}
          {state === 'missing' && <p className="font-sans">{t('workbench.planEvidenceMissingHint')}</p>}
          {evidence?.turnId && typeof onRevealTurn === 'function' && (
            <button
              type="button"
              data-testid="workbench-plan-reveal-turn"
              onClick={() => onRevealTurn(evidence.turnId)}
              className="mt-1 font-sans text-ink-soft underline underline-offset-4 hover:text-ink"
            >
              {t('workbench.planRevealTurn')}
            </button>
          )}
        </div>
      )}
    </li>
  )
}

export default function WorkbenchPlan({ onRevealTurn, sessionId = '', todos = [], t }) {
  const [plan, setPlan] = useState(null)
  const [planError, setPlanError] = useState('')
  const [loadedFor, setLoadedFor] = useState('')
  const [approving, setApproving] = useState(false)
  const [approveNote, setApproveNote] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  const reload = useCallback(() => setReloadToken((value) => value + 1), [])

  // A turn may have moved the plan. The signal arrives from the one place every
  // turn event passes through; bumping the token is the whole response, and the
  // read below is the only thing that touches plan state.
  useEffect(() => subscribeGoalPlanChanged(reload), [reload])

  // The task list is the other half of the same question ("what is left?"). It
  // arrives as a prop, so a change to it is a signal that the agent is working —
  // and it also covers a runtime that writes todos without a goal tool. Kept as a
  // dependency rather than a separate effect so there is one read path.
  const todoSignature = (Array.isArray(todos) ? todos : [])
    .map((todo) => `${todo?.id || todo?.content || ''}:${todo?.status || ''}`).join('|')

  useEffect(() => {
    if (!sessionId) return undefined
    let cancelled = false
    Promise.resolve()
      .then(() => listGoalPlansApi({ sessionId, limit: 20 }))
      .then((data) => {
        if (cancelled) return null
        // The server owns which plan is current: it prefers one awaiting approval,
        // then an approved one, and only then the most recent row. Picking here
        // duplicated that rule and got it wrong — it looked for a status named
        // "active", which does not exist — so a finished plan could be shown as
        // the current one.
        const next = pickActivePlan(data?.plans)
        return next ? showGoalPlanApi(next.id) : null
      })
      .then((detail) => {
        if (cancelled) return
        setPlan(detail?.plan || null)
        setPlanError('')
        setLoadedFor(sessionId)
      })
      .catch((error) => {
        if (cancelled) return
        setPlan(null)
        setPlanError(error?.message || t('workbench.planLoadFailed'))
        setLoadedFor(sessionId)
      })
    return () => { cancelled = true }
  }, [sessionId, t, reloadToken, todoSignature])

  const approve = async () => {
    if (!plan) return
    setApproving(true)
    setApproveNote('')
    try {
      await approveGoalPlanApi({ planId: plan.id, expectedVersion: plan.version })
      setApproveNote(t('workbench.planApproved'))
    } catch (error) {
      // A version conflict means the plan moved underneath us; the honest answer
      // is to re-read it rather than retry blindly against a stale copy.
      setApproveNote(error?.currentVersion != null
        ? t('workbench.planVersionConflict')
        : error?.message || t('workbench.planApproveFailed'))
    } finally {
      setApproving(false)
      reload()
    }
  }

  const taskList = (Array.isArray(todos) ? todos : []).filter((todo) => todoLabel(todo))
  const steps = Array.isArray(plan?.steps) ? plan.steps : []
  const planLoading = Boolean(sessionId) && loadedFor !== sessionId && !planError
  const canApprove = plan?.status === 'awaiting_approval'

  return (
    <section className="min-h-0 flex-1 overflow-y-auto" data-testid="workbench-plan">
      <Section count={taskList.length} testId="workbench-plan-tasks" title={t('workbench.planTasks')}>
        {taskList.length === 0
          ? <p className="text-xs text-ink-fade" data-testid="workbench-plan-tasks-empty">{t('workbench.planTasksEmpty')}</p>
          : <TaskList t={t} taskList={taskList} />}
      </Section>

      <Section
        action={(
          <button
            type="button"
            data-testid="workbench-plan-refresh"
            onClick={reload}
            aria-label={t('workbench.planRefresh')}
            title={t('workbench.planRefresh')}
            className="flex h-6 w-6 items-center justify-center rounded-control text-ink-fade transition-transform hover:rotate-90 hover:bg-ink/5 hover:text-ink"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
        count={steps.length}
        testId="workbench-plan-plan"
        title={t('workbench.planPlan')}
      >
        {planError
          ? <p className="text-xs text-danger" data-testid="workbench-plan-error">{planError}</p>
          : planLoading
            ? <p className="text-xs text-ink-fade">{t('workbench.planLoading')}</p>
            : !plan
              ? <p className="text-xs text-ink-fade" data-testid="workbench-plan-empty">{t('workbench.planEmpty')}</p>
              : (
                <>
                  <div className="mb-2 flex items-start gap-2">
                    <p className="min-w-0 flex-1 text-xs text-ink-soft" data-testid="workbench-plan-objective">{plan.objective}</p>
                    <span
                      data-testid="workbench-plan-status"
                      data-status={plan.status}
                      className={`shrink-0 rounded-pill px-1.5 py-0.5 text-xs ${plan.status === 'approved' ? 'bg-accent/15 text-accent-ink' : 'bg-ink/[0.06] text-ink-fade'}`}
                    >
                      {t(PLAN_STATUS_KEYS[plan.status] || 'workbench.planStatusUnknown')}
                    </span>
                  </div>
                  {canApprove && (
                    <div className="mb-2 flex items-center gap-2">
                      <button
                        type="button"
                        data-testid="workbench-plan-approve"
                        disabled={approving}
                        onClick={() => { void approve() }}
                        className="rounded-control bg-ink px-2.5 py-1 text-xs text-paper hover:bg-ink/85 disabled:opacity-35"
                      >
                        {t(approving ? 'workbench.planApproving' : 'workbench.planApprove')}
                      </button>
                      <span className="text-xs text-ink-fade">{t('workbench.planApproveHint')}</span>
                    </div>
                  )}
                  {approveNote && <p role="status" data-testid="workbench-plan-approve-note" className="mb-2 text-xs text-ink-soft">{approveNote}</p>}
                  <ol className="space-y-1.5">
                    {steps.map((step) => (
                      <PlanStep key={step.id || step.ordinal} onRevealTurn={onRevealTurn} step={step} t={t} />
                    ))}
                  </ol>
                </>
              )}
      </Section>
      {/* Outputs are not progress: the files a session produced live in the
          workbench's own "workspace files" tool, with room to preview them. */}
    </section>
  )
}
