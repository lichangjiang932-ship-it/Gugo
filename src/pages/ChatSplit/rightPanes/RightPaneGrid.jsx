import { GUTTER_PX, MIN_PANE_WIDTH, useRightRegionLayout } from './useRightRegionLayout.js'

/**
 * The right region, as a stack of panes that can be up at the same time.
 *
 * It replaces the pair of sibling columns the workbench and the dock used to be:
 * side by side they read as two unrelated strips, a file opened in one evicted
 * the other, and the task list could only ever be a full-height sliver. Here a
 * pane above may share the region with up to two below.
 *
 * The arrangement is written out rather than left to flow, because the two cases
 * are not the same shape: a pane *above* pushes what follows into a bottom row,
 * but two panes with nothing above them sit side by side. Letting the boxes flow
 * would stack that pair, which is the arrangement this is meant to stop.
 */
export default function RightPaneGrid({
  bottomLeft = null,
  bottomRight = null,
  t,
  takeover = null,
  top = null,
}) {
  const region = useRightRegionLayout()
  const openLeft = Boolean(bottomLeft)
  const openRight = Boolean(bottomRight)
  const openBottom = openLeft || openRight
  // Two panes below sit side by side only while both can still hold a readable
  // line. When the region is too narrow for that, stacking them is the honest
  // answer — a 180px column of a document is not a pane, it is a sliver. Widening
  // the region puts the split back on its own.
  const stackBottom = openLeft && openRight && region.width < MIN_PANE_WIDTH * 2 + GUTTER_PX
  const splitColumns = openLeft && openRight && !stackBottom
  if (!top && !openBottom) return null

  const divider = 'touch-none bg-transparent outline-none after:absolute after:bg-transparent hover:after:bg-accent/50 focus-visible:after:bg-focus'
  const rowDivider = (
    <button
      type="button"
      data-testid="right-pane-row-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('workbench.resize')}
      className={`relative h-2 shrink-0 cursor-row-resize ${divider} after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2`}
      onPointerDown={region.beginRowDrag}
      onKeyDown={region.resizeRowWithKeyboard}
    />
  )
  const columnDivider = (
    <button
      type="button"
      data-testid="right-pane-column-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('workbench.resize')}
      className={`relative w-2 shrink-0 cursor-col-resize ${divider} after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2`}
      onPointerDown={region.beginColumnDrag}
      onKeyDown={region.resizeColumnWithKeyboard}
    />
  )

  return (
    <div
      data-testid="right-pane-grid"
      className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden"
      style={{ width: `${region.width}px` }}
    >
      {/* Inside the region, not straddling its edge: the region clips its own
          overflow, so a handle hung on the outside is cut in half and only the
          sliver that happens to be inside can be grabbed — which is the same as
          not being grabbable. The hairline still lands on the boundary. */}
      <button
        type="button"
        data-testid="right-region-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('workbench.resize')}
        aria-valuemin={region.minWidth}
        aria-valuenow={region.width}
        className={`absolute inset-y-0 left-0 z-20 w-2 cursor-col-resize ${divider} after:inset-y-0 after:left-0 after:w-px`}
        onPointerDown={region.beginWidthDrag}
        onKeyDown={region.resizeWidthWithKeyboard}
        onDoubleClick={region.resetWidth}
      />

      {top && (
        <>
          <div
            data-testid="right-pane-top"
            className="flex min-h-0 flex-col overflow-hidden"
            style={openBottom ? { flex: `0 0 ${region.topRatio * 100}%` } : { flex: '1 1 auto' }}
          >
            {top}
          </div>
          {openBottom && rowDivider}
        </>
      )}

      {openBottom && (
        <div
          data-testid="right-pane-bottom"
          data-stacked={stackBottom ? 'true' : undefined}
          className={`flex min-h-0 flex-1 overflow-hidden ${stackBottom ? 'flex-col' : 'flex-row'}`}
        >
          {openLeft && (
            <div
              data-testid="right-pane-bottom-left"
              className="flex min-h-0 min-w-0 flex-col overflow-hidden"
              // Stacked or alone, it shares the room evenly rather than taking
              // whatever its content wants — a plan card with a long list would
              // otherwise leave the pane under it a strip.
              style={splitColumns ? { flex: `0 0 ${region.bottomLeftRatio * 100}%` } : { flex: '1 1 0%' }}
            >
              {bottomLeft}
            </div>
          )}
          {splitColumns && columnDivider}
          {openRight && (
            <div data-testid="right-pane-bottom-right" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {bottomRight}
            </div>
          )}
        </div>
      )}

      {takeover && (
        <div data-testid="right-pane-takeover" className="absolute inset-0 z-30 flex min-h-0 flex-col overflow-hidden bg-paper">
          {takeover}
        </div>
      )}
    </div>
  )
}
