import { useCallback, useEffect } from 'react'

import useSessionChangesReview from './useSessionChangesReview.js'
import usePreviewAutoOpen from './usePreviewAutoOpen.js'
import useWorkbenchShortcuts from './useWorkbenchShortcuts.js'
import { openDock } from './dock/dockStore.js'

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
  setWorkbenchOpen,
  setWorkbenchTab,
  workspacePath = '',
} = {}) {
  const openPreview = useCallback(() => {
    setWorkbenchTab?.('browser')
    setWorkbenchOpen?.(true)
  }, [setWorkbenchOpen, setWorkbenchTab])

  const openDiffReview = useCallback(() => {
    // The review opens *beside* what is already up, not in place of it. It used
    // to close the tool panel on the reasoning that two panels competed for the
    // same edge; sitting the dock next to the tool panel is what the layout is
    // for, so a reader comparing a change against the panel they were reading
    // no longer loses the panel to see the change.
    openDock()
  }, [])

  // The chat's change chip asks for the docked review panel through this event,
  // so the header carries no workbench state of its own and the docked panel and
  // the header chip can never disagree about which surface is showing.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    window.addEventListener('chat-workbench:open-diff', openDiffReview)
    return () => window.removeEventListener('chat-workbench:open-diff', openDiffReview)
  }, [openDiffReview])

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
    // No `onOpen` any more: opening the review used to close the task list. The
    // two answer different questions about the same session, so reading one of
    // them should not cost the reader the other.
    // The diff opens in the main area's preview pane, not in the sidebar: the
    // review is about this conversation, and the sidebar is a different tool.
    // The pane only exists while the side panel is open, so it is opened first,
    // as every other way of opening a preview does.
    onOpenDiff: (artifact) => {
      setWorkbenchOpen?.(true)
      dispatch?.({ type: 'OPEN_PREVIEW_ARTIFACT', payload: artifact })
    },
    workspacePath,
  })

  return { openPreview, sessionChangesReview }
}
