import { Check, Circle, CircleDot, ListChecks } from 'lucide-react'
import { normalizeSessionTodos } from '../../../lib/sessionTodos.js'

const STATUS_KEYS = Object.freeze({
  completed: 'workbench.planTodoDone',
  in_progress: 'workbench.planTodoActive',
  pending: 'workbench.planTodoPending',
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
    return <CircleDot className="plan-todo-active-dot mt-0.5 h-4 w-4 shrink-0 text-running" strokeWidth={2} aria-hidden="true" />
  }
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-ink/25" strokeWidth={1.75} aria-hidden="true" />
}

/**
 * The live task list as it belongs to the transcript: what the agent is doing,
 * where the reader is already looking, instead of only in the header counter or
 * the floating card. It stays inline (not floating, not sticky) so it scrolls
 * with the work it describes, and it retires once the turn is done and every
 * item is complete — the header keeps the finished tally from then on.
 */
export default function ConversationTodoList({ todos = [], active = false, t }) {
  const list = normalizeSessionTodos(todos)
  const done = list.filter((todo) => todo.status === 'completed').length
  if (list.length === 0 || (!active && done >= list.length)) return null
  const percent = Math.round((done / list.length) * 100)
  return (
    <section
      data-testid="conversation-todos"
      aria-label={t('workbench.planTasks')}
      className="mt-3 rounded-card border border-ink/[0.09] bg-paper-2/45 px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-ink-fade" strokeWidth={1.8} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-soft">{t('workbench.planTasks')}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-ink-fade">{done}/{list.length}</span>
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink/[0.08]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={list.length}
        aria-valuenow={done}
        aria-label={t('workbench.planProgress', { done, total: list.length })}
      >
        <div className="h-full rounded-full bg-success transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <ul className="mt-1.5 max-h-36 space-y-0.5 overflow-y-auto overscroll-contain" data-testid="conversation-todo-items">
        {list.map((todo) => {
          const status = todo.status || 'pending'
          return (
            <li
              key={todo.id}
              className={`flex items-start gap-2 rounded-control px-1 py-0.5 text-xs leading-5 ${status === 'in_progress' ? 'bg-running/[0.07]' : ''}`}
              data-status={status}
              aria-current={status === 'in_progress' ? 'step' : undefined}
            >
              <TodoMark status={status} />
              <span className={`min-w-0 ${status === 'completed' ? 'text-ink-fade line-through decoration-ink/30' : status === 'in_progress' ? 'font-medium text-ink' : 'text-ink-soft'}`}>
                <span className="sr-only">{t(STATUS_KEYS[status] || 'workbench.planTodoPending')}</span>
                {status === 'in_progress' ? todo.activeForm : todo.content}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
