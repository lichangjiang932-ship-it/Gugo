import { X } from 'lucide-react'
import WorkbenchPlan from '../rightWorkbench/WorkbenchPlan.jsx'

/**
 * The task list card, floating on the right: the agent's progress and nothing
 * else.
 *
 * It is deliberately not a workbench tab. A tab can only be seen while its panel
 * is open, so opening the panel to look at something else used to hide the plan —
 * which is what made "opening the panel" and "seeing the plan" fight each other.
 * As a card it has its own visibility: the reader closes it, the agent's next new
 * list opens it, and neither decision touches the tool panel.
 *
 * The session's files used to ride here as a second tab. They now live in the
 * workbench as its own tool ("workspace files"), where there is room for the full
 * rows — preview, download, snapshot and verification states — so this card
 * stays a glance: what is done, what is next.
 *
 * The close button is explicit rather than a hover affordance: this card covers
 * working content, so the way to get it out of the way has to be findable without
 * hunting for it.
 */
export default function PlanCard({ onClose, onRevealTurn, sessionId = '', todos = [], t }) {
  return (
    // top-14 clears the 48px chat and workbench headers, whose buttons — including
    // the toggle that closes this card — must stay reachable while it is open.
    <section
      data-testid="plan-card"
      aria-label={t('workbench.planCardTitle')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        onClose?.()
      }}
      className="pointer-events-auto absolute top-14 right-3 z-20 flex max-h-[calc(100%-4.25rem)] w-[min(300px,calc(100vw-3rem))] flex-col overflow-hidden rounded-card overlay-float"
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-ink/10 pl-2.5 pr-1">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{t('workbench.planCardTitle')}</h2>
        <button
          type="button"
          data-testid="plan-card-close"
          onClick={onClose}
          aria-label={t('workbench.closePlan')}
          title={t('workbench.closePlan')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <WorkbenchPlan
          onRevealTurn={onRevealTurn}
          sessionId={sessionId}
          t={t}
          todos={todos}
        />
      </div>
    </section>
  )
}
