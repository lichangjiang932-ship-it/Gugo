import { useState } from 'react'
import { X } from 'lucide-react'
import WorkbenchFiles from '../rightWorkbench/WorkbenchFiles.jsx'
import WorkbenchPlan from '../rightWorkbench/WorkbenchPlan.jsx'

/**
 * The task list / plan / output card, floating on the right.
 *
 * It is deliberately not a workbench tab. A tab can only be seen while its panel
 * is open, so opening the panel to look at something else used to hide the plan —
 * which is what made "opening the panel" and "seeing the plan" fight each other.
 * As a card it has its own visibility: the reader closes it, the agent's next new
 * list opens it, and neither decision touches the tool panel.
 *
 * The close button is explicit rather than a hover affordance: this card covers
 * working content, so the way to get it out of the way has to be findable without
 * hunting for it.
 *
 * Two inner views share the card: the plan (task list, goal steps, outputs) and
 * the session's files (full artifact rows with preview, download, snapshot and
 * verification states). The file list used to live only in the tool panel —
 * exactly the panel-tab trade-off this card exists to avoid — so it rides here
 * as a peer view instead of going back into the panel.
 */
const CARD_TABS = Object.freeze([
  { id: 'progress', labelKey: 'workbench.planCardTabProgress' },
  { id: 'files', labelKey: 'workbench.planCardTabFiles' },
])

export default function PlanCard({ artifacts = [], onClose, onOpenArtifact, onRevealTurn, sessionId = '', todos = [], t }) {
  const [tab, setTab] = useState('progress')
  return (
    <section
      data-testid="plan-card"
      aria-label={t('workbench.planCardTitle')}
      className="pointer-events-auto absolute top-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(300px,calc(100vw-3rem))] flex-col overflow-hidden rounded-card overlay-float"
    >
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-ink/10 pl-2.5 pr-1">
        <h2 className="min-w-0 shrink-0 truncate text-sm font-semibold text-ink">{t('workbench.planCardTitle')}</h2>
        <div className="flex min-w-0 flex-1 items-end justify-center gap-1" role="tablist" aria-label={t('workbench.planCardTitle')}>
          {CARD_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              data-testid={`plan-card-tab-${entry.id}`}
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={`border-b-2 px-2 pb-1 pt-0.5 text-xs transition-colors ${tab === entry.id ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-fade hover:text-ink'}`}
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="tabpanel">
        {tab === 'files' ? (
          <WorkbenchFiles artifacts={artifacts} onOpenArtifact={onOpenArtifact} t={t} />
        ) : (
          <WorkbenchPlan
            artifacts={artifacts}
            onOpenArtifact={onOpenArtifact}
            onRevealTurn={onRevealTurn}
            sessionId={sessionId}
            t={t}
            todos={todos}
          />
        )}
      </div>
    </section>
  )
}
