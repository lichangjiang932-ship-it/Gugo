import { useEffect, useState } from 'react'
import { useToast } from '../../../components/Toast.jsx'
import { useT } from '../../../i18n/I18nProvider.jsx'
import { savePreviewScreenshot } from '../../../lib/previewScreenshot.js'
import { useUiContributions } from '../../../plugins/uiContributionRegistry.js'
import { previewDrawsInApp } from '../preview/previewDrawsInApp.js'
import usePreviewElementPicker from '../rightWorkbench/usePreviewElementPicker.js'
import DockHost from '../dock/DockHost.jsx'
import { readDockState, subscribeDock } from '../dock/dockStore.js'
import RightPaneGrid from '../rightPanes/RightPaneGrid.jsx'
import RightPreviewPane from '../RightPreviewPane.jsx'
import RightWorkbench from '../RightWorkbench.jsx'

/**
 * The right region: the workbench above, and the task list and the open file
 * sharing the space below it.
 *
 * These used to be one slot with a ternary in it — the workbench and the preview
 * taking turns, and the task list in a separate column beside them, so opening
 * anything evicted whatever was there. Each is its own pane now, and they are
 * placed rather than arbitrated: the region holds what the reader has open.
 */
export default function ChatRightPanels({
  onInsertText,
  workbenchOpen,
  sessionId,
  todos,
  messages,
  attachments,
  workbenchTab,
  onWorkbenchTabChange,
  selectedWorkspacePath,
  onCloseWorkbench,
  onOpenArtifact,
  onWorkbenchSend,
  isGenerating,
  workbenchMessage,
  previewArtifact,
  previewTabs,
  previewActiveId,
  onActivatePreviewTab,
  onClosePreviewTab,
  onClosePreview,
  onPreviewMessage,
}) {
  const { t } = useT()
  const toast = useToast()
  const contributedTabs = useUiContributions('workbench-tab')
  // The reader points at preview content and the selector goes to the composer.
  // The panel is the only thing that can see the content, so this is answered
  // here, where the open file is known, rather than guessed from the DOM later.
  const elementPicker = usePreviewElementPicker({ insertText: onInsertText, t, toast })
  const inAppPreview = previewArtifact?.directFile
    ? previewDrawsInApp(previewArtifact.directFile)
    : false
  // The review takes the region over rather than sitting in a pane: it is a
  // full-height reader with a file tree of its own down one side, and a quarter
  // of the region would leave it arguing with the panes around it.
  const [dockState, setDockState] = useState(readDockState)
  useEffect(() => {
    const timer = setTimeout(() => subscribeDock(setDockState), 0)
    return () => clearTimeout(timer)
  }, [])

  const takeScreenshot = () => {
    void savePreviewScreenshot().then((result) => {
      if (result.ok) toast.success(t('workbench.previewScreenshotSaved', { width: result.width, height: result.height }))
      else toast.error(t('workbench.previewScreenshotFailed'))
    })
  }

  // The region is open when any of its panes is wanted — not only when the tool
  // panel is. Each pane answers for itself; the grid draws nothing when none of
  // them wants the room.
  //
  // Inside the tool panel the two levels are the tab: the entry list is the front
  // door and a tool is the room behind it, so choosing a tool is what closes the
  // list and Back (`workbench-tool-entry`) is what brings it back. The list used
  // to be suppressed whenever anything else was open, which made Back look like
  // it had closed the panel: the tab did return to `entry` and the pane was then
  // hidden for having nothing but the list to show. It can share the region with
  // the review and an open file; it simply is not what a tool tab shows.
  const showWorkbench = workbenchOpen

  return (
    <RightPaneGrid
      t={t}
      top={showWorkbench ? (
        <RightWorkbench
          embedded
          sessionId={sessionId}
          todos={todos}
          messages={messages}
          attachments={attachments}
          activeTab={workbenchTab}
          onTabChange={onWorkbenchTabChange}
          onClose={onCloseWorkbench}
          onInsertText={onInsertText}
          onOpenArtifact={onOpenArtifact}
          onSendMessage={onWorkbenchSend}
          selectedWorkspacePath={selectedWorkspacePath}
          isGenerating={isGenerating}
          statusMessage={workbenchMessage}
        />
      ) : null}
      bottoms={[
        dockState.panel === 'diff' ? {
          key: 'middle',
          node: <DockHost embedded onSendMessage={onWorkbenchSend} t={t} workspacePath={selectedWorkspacePath} />,
        } : null,
        previewArtifact ? {
          key: 'right',
          node: (
            <RightPreviewPane
          embedded
          artifact={previewArtifact}
          previewTabs={previewTabs}
          activePreviewId={previewActiveId}
          onActivateTab={onActivatePreviewTab}
          onCloseTab={onClosePreviewTab}
          onClose={onClosePreview}
          onMessage={onPreviewMessage}
          residentToolbar={{
            activeTab: workbenchTab,
            // This bar sits inside the preview, so its ✕ closes the preview. It
            // was wired to the tool panel's switch, which left the page the
            // reader was looking at exactly where it was and made the mark look
            // like it did nothing at all.
            closeLabelKey: 'chatPreview.close',
            contributedTabs,
            inAppPreview,
            onClose: onClosePreview,
            onPickElement: elementPicker.toggle,
            onScreenshot: takeScreenshot,
            picking: elementPicker.picking,
            onTabChange: onWorkbenchTabChange,
            workspacePath: selectedWorkspacePath,
          }}
        />
          ),
        } : null,
      ]}
    />
  )
}
