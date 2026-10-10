import DockHeader from './DockHeader.jsx'

/**
 * A right-docked panel: full height, its own header, and an edge the reader can
 * drag. The conversation keeps its own width; the panel never floats over it and
 * never covers the sidebar, which is what made the plan card and the review feel
 * like they were in the way.
 *
 * Everything panel-specific arrives through `header` and `children`, so the
 * review, the plan list and the terminal/browser share one set of rules instead
 * of three. The width itself is owned by the host (`dock` comes from
 * `useDockWidth`) so this component never keeps a second, disagreeing copy.
 */
export default function DockLayout({
  children,
  dock,
  embedded = false,
  header = null,
  onClose,
  onOpenWindow,
  testId = 'dock-panel',
  t,
}) {
  return (
    <aside
      id="right-dock"
      data-testid={testId}
      aria-label={t('diffReview.title')}
      className={`relative flex h-full min-w-0 flex-col overflow-hidden bg-paper ${embedded ? 'w-full' : 'max-w-[calc(100vw-60px)] shrink-0 border-l border-ink/10'}`}
      style={embedded ? undefined : { width: `${dock.width}px` }}
    >
      {!embedded && (
        <button
          type="button"
          data-testid="dock-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workbench.resize')}
          aria-valuemin={dock.minWidth}
          aria-valuenow={dock.width}
          className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none bg-transparent outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-accent/50 focus-visible:after:bg-focus"
          onPointerDown={dock.beginResize}
          onKeyDown={dock.resizeWithKeyboard}
          onDoubleClick={dock.reset}
        />
      )}
      {header === null
        ? <DockHeader expanded={dock.expanded} onClose={onClose} onOpenWindow={onOpenWindow} onToggleExpand={dock.toggleExpand} t={t} />
        : header({ ...dock, header: true })}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </aside>
  )
}
