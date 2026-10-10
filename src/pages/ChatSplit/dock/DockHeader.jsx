import { Maximize2, Minimize2, MoreVertical, X } from 'lucide-react'

const BUTTON = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-soft transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30'

/**
 * The header every docked panel shares: what the panel is on the left, the same
 * four controls on the right (menu, open-in-window, expand, close) — so the
 * terminal, the browser and the review never drift apart in either position or
 * behaviour. Controls without a job are not rendered.
 */
export default function DockHeader({
  actions = null,
  children,
  onClose,
  onOpenWindow,
  onToggleExpand,
  expanded = false,
  t,
}) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b border-ink/10 px-2" data-testid="dock-header">
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
      {actions}
      <button
        type="button"
        className={BUTTON}
        data-testid="dock-more"
        aria-label={t('diffReview.more')}
        title={t('diffReview.more')}
        onClick={(event) => event.currentTarget.parentElement?.querySelector('[data-dock-menu]')?.toggle?.()}
      >
        <MoreVertical className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
      </button>
      {typeof onOpenWindow === 'function' && (
        <button type="button" className={BUTTON} data-testid="dock-open-window"
          aria-label={t('diffReview.openInNewWindow')} title={t('diffReview.openInNewWindow')} onClick={onOpenWindow}>
          <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">
            <span className="block h-3 w-3 rounded-[3px] border border-current" />
          </span>
        </button>
      )}
      <button
        type="button"
        className={BUTTON}
        data-testid="dock-expand"
        aria-pressed={expanded}
        aria-label={t(expanded ? 'workbench.resetWidth' : 'diffReview.expandWidth')}
        title={t(expanded ? 'workbench.resetWidth' : 'diffReview.expandWidth')}
        onClick={onToggleExpand}
      >
        {expanded
          ? <Minimize2 className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
          : <Maximize2 className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />}
      </button>
      {typeof onClose === 'function' && (
        <button type="button" className={BUTTON} data-testid="dock-close"
          aria-label={t('workbench.close')} title={t('workbench.close')} onClick={onClose}>
          <X className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />
        </button>
      )}
    </header>
  )
}
