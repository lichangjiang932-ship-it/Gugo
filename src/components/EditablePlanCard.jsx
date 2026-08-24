import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'

function toDraft(steps = []) {
  return steps.map((step, index) => ({
    id: step.id || `draft-${index + 1}`,
    title: String(step.title || ''),
    description: String(step.description || step.input?.description || ''),
    kind: step.kind || 'execute',
    input: step.input || {},
  }))
}

function move(items, index, offset) {
  const target = index + offset
  if (target < 0 || target >= items.length) return items
  const next = [...items]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export default function EditablePlanCard({ plan, disabled = false, onApprove, t }) {
  const [steps, setSteps] = useState(() => toDraft(plan?.steps))

  const hasEmptyTitle = steps.some((step) => !step.title.trim())

  return (
    <div className="mt-3 rounded-md border border-dashed border-cyan/50 bg-cyan/5 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs text-cyan">{t('taskSteering.planTitle')}</p>
          <p className="text-sm text-ink mt-1">{plan?.objective}</p>
        </div>
        <span className="text-xs text-ink-fade shrink-0">
          {t('taskSteering.editPlanHint')}
        </span>
      </div>

      <div className="mt-3 space-y-2">
        {steps.map((step, index) => (
          <div key={step.id} className="flex items-start gap-2 rounded-md border border-cyan/20 bg-paper/70 p-2">
            <span className="w-5 pt-2 text-center font-mono text-[10px] text-ink-fade">{index + 1}</span>
            <div className="min-w-0 flex-1 space-y-2">
              <input
                value={step.title}
                disabled={disabled}
                maxLength={200}
                aria-label={`${t('taskSteering.stepLabel')} ${index + 1}`}
                onChange={(event) => setSteps((current) => current.map((item, itemIndex) => (
                  itemIndex === index ? { ...item, title: event.target.value } : item
                )))}
                className="w-full h-8 px-2 rounded border border-ink/20 bg-paper text-sm text-ink outline-none focus:border-cyan disabled:opacity-60"
              />
              <textarea
                value={step.description}
                disabled={disabled}
                maxLength={2000}
                rows={2}
                aria-label={`${t('taskSteering.stepDescriptionLabel')} ${index + 1}`}
                placeholder={t('taskSteering.stepDescriptionPlaceholder')}
                onChange={(event) => setSteps((current) => current.map((item, itemIndex) => (
                  itemIndex === index ? { ...item, description: event.target.value } : item
                )))}
                className="w-full min-h-14 resize-y px-2 py-1.5 rounded border border-ink/15 bg-paper text-xs text-ink outline-none focus:border-cyan disabled:opacity-60"
              />
            </div>
            <button
              type="button"
              disabled={disabled || index === 0}
              onClick={() => setSteps((current) => move(current, index, -1))}
              aria-label={t('taskSteering.moveStepUp')}
              className="w-8 h-8 inline-flex items-center justify-center rounded border border-ink/15 text-ink-soft disabled:opacity-30"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              disabled={disabled || index === steps.length - 1}
              onClick={() => setSteps((current) => move(current, index, 1))}
              aria-label={t('taskSteering.moveStepDown')}
              className="w-8 h-8 inline-flex items-center justify-center rounded border border-ink/15 text-ink-soft disabled:opacity-30"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              disabled={disabled || steps.length <= 1}
              onClick={() => setSteps((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              aria-label={t('taskSteering.deleteStep')}
              className="w-8 h-8 inline-flex items-center justify-center rounded border border-danger/20 text-danger disabled:opacity-30"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={disabled || steps.length >= 50}
          onClick={() => setSteps((current) => [...current, {
            id: `draft-${Date.now()}-${current.length}`,
            title: t('taskSteering.newStepTitle'),
            description: '',
            kind: 'execute',
            input: { description: '' },
          }])}
          className="h-9 px-3 rounded-md border border-cyan/40 text-cyan text-sm inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {t('taskSteering.addStep')}
        </button>
        <button
          type="button"
          disabled={disabled || !steps.length || hasEmptyTitle}
          onClick={() => onApprove?.(steps.map(({ id, title, description, kind, input }) => ({
            id,
            title: title.trim(),
            description: description.trim(),
            kind,
            input: { ...input, description: description.trim() },
          })))}
          className="h-9 px-3 rounded-md bg-cyan text-paper text-sm disabled:opacity-50"
        >
          {disabled ? t('taskSteering.approvingPlan') : t('taskSteering.approvePlan')}
        </button>
      </div>
    </div>
  )
}
