import { Fragment, useCallback, useState } from 'react'
import { GUTTER_PX, MIN_PANE_WIDTH, useRightRegionLayout } from './useRightRegionLayout.js'

/**
 * The right region, as a stack of panes that can be up at the same time.
 *
 * It replaces the pair of sibling columns the workbench and the dock used to be:
 * side by side they read as two unrelated strips, a file opened in one evicted
 * the other, and the task list could only ever be a full-height sliver. Here a
 * pane above may share the region with the panes below.
 *
 * Nothing here covers anything else. The change review spent a while as a
 * takeover, which was right while it carried a file tree of its own down one
 * side and would have fought a quarter of the region — once that tree became the
 * ≡ overlay, the takeover had no reason left and only made the review the one
 * pane with no edge of its own and the one that hid its neighbours.
 *
 * The arrangement is written out rather than left to flow, because the cases are
 * not the same shape: a pane *above* pushes what follows into a bottom row, but
 * panes with nothing above them sit side by side. Letting the boxes flow would
 * stack that row, which is the arrangement this is meant to prevent — and when
 * the row cannot give every pane a readable width, stacking is what it does on
 * purpose.
 */
export default function RightPaneGrid({
  bottoms = [],
  t,
  top = null,
}) {
  const region = useRightRegionLayout()
  const panes = bottoms.filter(Boolean)
  const openBottom = panes.length > 0
  const needed = panes.length * MIN_PANE_WIDTH + (panes.length - 1) * GUTTER_PX
  const stackBottom = panes.length > 1 && region.width < needed

  // Each pane's share of the row, in the same order as `panes`. Dragging a
  // divider between two of them moves the boundary without changing the total,
  // so a reader can give the diff the room and leave the file a column, and the
  // panes they are not touching stay where they were.
  const [weights, setWeights] = useState(() => panes.map(() => 1))
  // Adjusting during render, not in an effect: a pane opening or closing changes
  // how many shares the row has, and painting one frame with the wrong number of
  // them is a frame with the wrong widths in it.
  if (weights.length !== panes.length) setWeights(panes.map(() => 1))

  const beginDividerDrag = useCallback((index) => (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const row = event.currentTarget.parentElement?.getBoundingClientRect?.()
    if (!row?.width) return
    const total = weights.reduce((sum, value) => sum + value, 0) || panes.length
    const start = { fromX: event.clientX, weights: [...weights], unit: row.width / total }
    const onMove = (moveEvent) => {
      const shift = (moveEvent.clientX - start.fromX) / start.unit
      const next = [...start.weights]
      // The boundary moves both sides by the same amount, and neither may go
      // past the width a pane needs to stay readable.
      const wall = MIN_PANE_WIDTH / start.unit
      next[index] = Math.max(wall, Math.min(start.weights[index] + start.weights[index + 1] - wall, start.weights[index] + shift))
      next[index + 1] = start.weights[index] + start.weights[index + 1] - next[index]
      setWeights(next)
    }
    const stop = () => {
      globalThis.window?.removeEventListener?.('pointermove', onMove)
      globalThis.window?.removeEventListener?.('pointerup', stop)
    }
    globalThis.window?.addEventListener?.('pointermove', onMove)
    globalThis.window?.addEventListener?.('pointerup', stop)
  }, [panes.length, weights])

  if (!top && !openBottom) return null

  // The panes are cards: a border, a corner, and a gap between them. The line
  // between two panes used to be the only thing separating them, which drew them
  // as one surface ruled into strips; a card each says they are separate things
  // that happen to be stacked. The drag strip stays — it is the gap now, and the
  // hairline only shows under the pointer, to say the gap can be pulled.
  const divider = 'touch-none bg-transparent outline-none after:absolute after:bg-transparent hover:after:bg-accent/50 focus-visible:after:bg-focus'
  const card = 'overflow-hidden rounded-card border border-ink/10 bg-paper'
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

  return (
    <div
      data-testid="right-pane-grid"
      className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden p-1.5"
      style={{ width: `${region.width}px` }}
    >
      {/* Inside the region, not straddling its edge: the region clips its own
          overflow, so a handle hung on the outside is cut in half and only the
          sliver that happens to be inside can be grabbed. */}
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
            className={`flex min-h-0 flex-col ${card}`}
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
          {panes.map((pane, index) => (
            <Fragment key={pane.key}>
              {index > 0 && (stackBottom ? rowDivider : (
                <button
                  type="button"
                  data-testid="right-pane-column-divider"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('workbench.resize')}
                  className={`relative w-2 shrink-0 cursor-col-resize ${divider} after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2`}
                  onPointerDown={beginDividerDrag(index - 1)}
                />
              ))}
              <div
                data-testid={`right-pane-bottom-${pane.key}`}
                className={`flex min-h-0 min-w-0 flex-col ${card}`}
                style={panes.length === 1 ? { flex: '1 1 auto' } : { flex: `${weights[index] ?? 1} 1 0%` }}
              >
                {pane.node}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
