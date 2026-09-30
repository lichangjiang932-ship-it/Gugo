import { ListChecks } from 'lucide-react'

import { previewShortcutLabel } from '../../../lib/previewShortcuts.js'
import { ChatPreviewButton, ChatSessionHeading, ChatWorkbenchToggle } from './ChatSessionHeader.jsx'
import SessionChangesReview from './SessionChangesReview.jsx'

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
  return (
    <header className="chat-session-header flex h-12 shrink-0 items-center gap-2.5 px-4 backdrop-blur-sm" data-chat-context={hasWorkspace ? 'project' : 'conversation'}>
      <ChatSessionHeading hasWorkspace={hasWorkspace} title={activeSession?.title || t('nav.newChat')} data-testid="chat-session-title" />
      <button type="button" data-testid="header-plan-toggle" aria-pressed={planVisible || undefined} onClick={() => (planVisible ? onClosePlan?.() : onOpenPlan?.())} title={t('workbench.planCardTitle')} aria-label={t('workbench.planCardTitle')} className="chat-chrome-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-fade hover:text-ink"><ListChecks className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" /></button>
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
