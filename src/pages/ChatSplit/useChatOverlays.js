import { useCallback } from 'react'

import useSessionChangesReview from './useSessionChangesReview.js'
import usePreviewAutoOpen from './usePreviewAutoOpen.js'
import useWorkbenchShortcuts from './useWorkbenchShortcuts.js'

/**
 * What a reader can bring up around the transcript: the change review, the
 * preview panel, and the keys that open them.
 *
 * All three answer to the same two setters the sidebar buttons use — the panel's
 * tab and whether it is open — so a key can only ever do what the button beside
 * it does. Grouping them here keeps that promise in one place instead of three
 * call sites in the page.
 */
export default function useChatOverlays({
  dispatch,
  isGenerating = false,
  messages = [],
  sessionId = '',
  setPlanVisible,
  setWorkbenchOpen,
  setWorkbenchTab,
  workspacePath = '',
} = {}) {
  const openPreview = useCallback(() => {
    setWorkbenchTab?.('browser')
    setWorkbenchOpen?.(true)
  }, [setWorkbenchOpen, setWorkbenchTab])

  useWorkbenchShortcuts({
    onOpenPreview: openPreview,
    onSelectTool: (tool) => {
      setWorkbenchTab?.(tool)
      setWorkbenchOpen?.(true)
    },
  })

  // While the agent is working, the preview it verifies through has to be on
  // screen: the page it reads is the one in the panel.
  usePreviewAutoOpen({ active: isGenerating, onOpen: openPreview, sessionId, workspaceRoot: workspacePath })

  const sessionChangesReview = useSessionChangesReview({
    messages,
    onOpen: () => setPlanVisible?.(false),
    // The diff opens in the main area's preview pane, not in the sidebar: the
    // review is about this conversation, and the sidebar is a different tool.
    onOpenDiff: (artifact) => dispatch?.({ type: 'OPEN_PREVIEW_ARTIFACT', payload: artifact }),
    workspacePath,
  })

  return { openPreview, sessionChangesReview }
}
