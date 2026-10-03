import { ListChecks } from 'lucide-react'

import { previewShortcutLabel } from '../../../lib/previewShortcuts.js'
import { ChatPreviewButton, ChatSessionHeading, ChatWorkbenchToggle } from './ChatSessionHeader.jsx'
import SessionChangesReview from './SessionChangesReview.jsx'

/** The task list's progress at a glance: a ring that fills as tasks finish. */
function TodoProgressRing({ done, total }) {
  const radius = 6.25
  const circumference = 2 * Math.PI * radius
  const ratio = total > 0 ? done / total : 0
  const complete = total > 0 && done >= total
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" data-testid="header-plan-ring">
      <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.75" />
      <circle
        cx="8" cy="8" r={radius} fill="none"
        stroke={complete ? 'rgb(var(--color-success-rgb))' : 'rgb(var(--color-running-rgb))'}
        strokeWidth="1.75" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.max(ratio, done > 0 ? 0.06 : 0))}
        transform="rotate(-90 8 8)"
        className="transition-[stroke-dashoffset] duration-300"
      />
      {complete && <path d="M5.4 8.2l1.7 1.7 3.5-3.6" fill="none" stroke="rgb(var(--color-success-rgb))" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  )
}

/**
 * The bar above the transcript: what this conversation is, and the panels it can
 * bring up.
 *
 * The controls are one row by design — title, then the task list, the change
 * review, the preview and the sidebar, in the order a reader reaches for them —
 * and the panel each one opens lives elsewhere, because the header's
 * `backdrop-blur` makes it the containing block for absolutely positioned
 * children. That is why this is a component and not markup inline in the view:
 * everything that decides *what* these buttons are sits in one file, and the view
 * only says which conversation they are about.
 */
export default function ChatSessionHeaderBar({
  activeSession = null,
  hasWorkspace = false,
  workspacePath = '',
  onClosePlan,
  onOpenPlan,
  onOpenPreview,
  onWorkbenchToggle,
  planVisible = false,
  previewOpen = false,
  sessionChangesReview = null,
  t,
  workbenchOpen = false,
}) {
  const previewLabel = t('workbench.preview')
  const previewTitle = t('workbench.previewWithShortcut', { label: previewLabel, shortcut: previewShortcutLabel() })
  // The task list's progress, on the button that opens it: the one number a
  // reader glances at to know where a long turn is.
  const todos = (Array.isArray(activeSession?.todos) ? activeSession.todos : [])
    .filter((todo) => String(todo?.content || todo?.activeForm || todo?.title || '').trim())
  const todosDone = todos.filter((todo) => todo?.status === 'completed').length
  const todoProgress = todos.length > 0 ? `${todosDone}/${todos.length}` : ''
  const planTitle = todoProgress
    ? `${t('workbench.planCardTitle')} · ${t('workbench.planProgress', { done: todosDone, total: todos.length })}`
    : t('workbench.planCardTitle')
  return (
    <header className="chat-session-header flex h-12 shrink-0 items-center gap-2.5 px-4 backdrop-blur-sm" data-chat-context={hasWorkspace ? 'project' : 'conversation'}>
      <ChatSessionHeading hasWorkspace={hasWorkspace} workspacePath={workspacePath} title={activeSession?.title || t('nav.newChat')} data-testid="chat-session-title" />
      <button type="button" data-testid="header-plan-toggle" data-has-progress={todoProgress ? true : undefined} aria-pressed={planVisible || undefined} onClick={() => (planVisible ? onClosePlan?.() : onOpenPlan?.())} onKeyDown={(event) => { if (event.key === 'Escape' && planVisible) { event.preventDefault(); onClosePlan?.() } }} title={planTitle} aria-label={planTitle} className={`chat-chrome-button inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-control px-1.5 text-xs text-ink-fade hover:text-ink ${todoProgress ? 'chat-plan-chip' : ''}`}>
        {todoProgress
          ? <TodoProgressRing done={todosDone} total={todos.length} />
          : <ListChecks className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
        {todoProgress && <span className="font-mono tabular-nums text-ink-soft" data-testid="header-plan-progress" aria-hidden="true">{todoProgress}</span>}
      </button>
      <SessionChangesReview review={sessionChangesReview} t={t} />
      <ChatPreviewButton
        open={previewOpen || undefined}
        onClick={onOpenPreview}
        label={previewLabel}
        shortcut={previewShortcutLabel()}
        title={previewTitle}
        aria-label={previewTitle}
        data-testid="chat-preview-toggle"
      />
      <ChatWorkbenchToggle
        open={workbenchOpen}
        onClick={onWorkbenchToggle}
        title={t(workbenchOpen ? 'workbench.hide' : 'workbench.show')}
        aria-label={t(workbenchOpen ? 'workbench.hide' : 'workbench.show')}
        aria-controls="right-workbench"
        aria-expanded={workbenchOpen}
        data-testid="workbench-toggle"
      />
    </header>
  )
}
