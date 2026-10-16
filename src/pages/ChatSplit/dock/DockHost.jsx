import { useEffect, useState } from 'react'
import DiffReviewPanel from '../rightWorkbench/diffReview/DiffReviewPanel.jsx'
import DockLayout from './DockLayout.jsx'
import { closeDock, readDockState, subscribeDock } from './dockStore.js'
import { useDockWidth } from './useDockWidth.js'

/**
 * The change review, over the whole right region.
 *
 * It is the last panel to live in the dock: the plan moved into a pane of its
 * own, and the browser and the terminal are workbench tools, so the review is
 * the only thing that still takes the region rather than sharing it. The review
 * brings its own toolbar, so the dock adds no header of its own.
 */
export default function DockHost({
  embedded = false,
  onSendMessage,
  t,
  workspacePath = '',
}) {
  const [dockState, setDockState] = useState(readDockState)
  const dock = useDockWidth()

  useEffect(() => {
    let unsubscribe = null
    const timer = setTimeout(() => { unsubscribe = subscribeDock(setDockState) }, 0)
    return () => { clearTimeout(timer); unsubscribe?.() }
  }, [])

  if (dockState.panel !== 'diff') return null

  return (
    <DockLayout dock={dock} embedded={embedded} header={() => null} onClose={closeDock} testId="right-dock" t={t}>
      <DiffReviewPanel
        initialTargetMode={dockState.targetMode}
        onClose={closeDock}
        onExpandToggle={dock.toggleExpand}
        onSendMessage={onSendMessage}
        panelExpanded={dock.expanded}
        t={t}
        workspacePath={workspacePath}
      />
    </DockLayout>
  )
}
