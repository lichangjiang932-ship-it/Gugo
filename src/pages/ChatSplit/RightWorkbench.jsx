import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.jsx'
import { useToast } from '../../components/Toast.jsx'
import { savePreviewScreenshot } from '../../lib/previewScreenshot.js'
import usePreviewElementPicker from './rightWorkbench/usePreviewElementPicker.js'
import { runWorkbenchTerminal } from '../../lib/workbenchClient.js'
import { stripAnsiSequences } from '../../lib/terminalText.js'
import { appendTerminalEntry, createTerminalTranscript, TERMINAL_STREAM } from '../../lib/terminalTranscript.js'
import { useUiContributions } from '../../plugins/uiContributionRegistry.js'
import RightWorkbenchContent from './rightWorkbench/RightWorkbenchContent.jsx'
import RightWorkbenchFrame from './rightWorkbench/RightWorkbenchFrame.jsx'
import WorkbenchToolbar from './rightWorkbench/WorkbenchToolbar.jsx'
import { collectArtifacts } from './rightWorkbench/rightWorkbenchArtifacts.js'
import {
  clampWidth,
  DEFAULT_WIDTH,
  readStoredWidth,
  WIDTH_STORAGE_KEY,
} from './rightWorkbench/rightWorkbenchLayout.js'

export default function RightWorkbench({
  sessionId = '',
  todos = [],
  messages = [],
  attachments = [],
  activeTab,
  onTabChange,
  onClose,
  onInsertText,
  onOpenArtifact,
  onSendMessage,
  selectedWorkspacePath = '',
  isGenerating,
  statusMessage = '',
}) {
  const { t } = useT()
  const toast = useToast()
  const contributedTabs = useUiContributions('workbench-tab')
  const artifacts = useMemo(() => collectArtifacts(messages, attachments), [attachments, messages])
  const resizeRef = useRef(null)
  const [panelWidth, setPanelWidth] = useState(readStoredWidth)
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('.')
  // The transcript is bounded as it grows (see lib/terminalTranscript.js): a long
  // session used to append to one string with no ceiling, so every update
  // re-rendered the whole history and stdout/stderr arrived glued together.
  const [terminalTranscript, setTerminalTranscript] = useState(createTerminalTranscript)
  const [terminalBusy, setTerminalBusy] = useState(false)
  // Expand grows the panel to its widest allowed size and remembers where it
  // was, so the second click restores the reader's own width rather than a guess.
  const restoreWidthRef = useRef(null)
  const [panelExpanded, setPanelExpanded] = useState(false)
  const toggleExpand = () => {
    if (!panelExpanded) {
      restoreWidthRef.current = panelWidth
      setPanelWidth(clampWidth(Number.MAX_SAFE_INTEGER))
      setPanelExpanded(true)
    } else {
      setPanelWidth(clampWidth(restoreWidthRef.current || DEFAULT_WIDTH))
      setPanelExpanded(false)
    }
  }

  useEffect(() => {
    const handlePointerMove = (event) => {
      if (!resizeRef.current) return
      const { startX, startWidth } = resizeRef.current
      setPanelWidth(clampWidth(startWidth + startX - event.clientX))
    }
    const stopResize = () => { resizeRef.current = null }
    const handleResize = () => setPanelWidth((width) => clampWidth(width))
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(panelWidth))
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [panelWidth])

  const beginResize = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    resizeRef.current = { startX: event.clientX, startWidth: panelWidth }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const resizeWithKeyboard = (event) => {
    if (event.key === 'ArrowLeft') setPanelWidth((width) => clampWidth(width + 24))
    else if (event.key === 'ArrowRight') setPanelWidth((width) => clampWidth(width - 24))
    else if (event.key === 'Home') setPanelWidth(clampWidth(DEFAULT_WIDTH))
    else return
    event.preventDefault()
  }

  const resetWidth = () => setPanelWidth(clampWidth(DEFAULT_WIDTH))
  // The capture is of the docked view, so it is the panel's own pixels; the toast
  // is where a failure explains itself, since a menu that closes on click has
  // nowhere left to say anything.
  // Picking hands the selector to the composer so the next message names it.
  const elementPicker = usePreviewElementPicker({ insertText: onInsertText, t, toast })
  const takeScreenshot = () => {
    void savePreviewScreenshot().then((result) => {
      if (result.ok) toast.success(t('workbench.previewScreenshotSaved', { width: result.width, height: result.height }))
      else toast.error(t('workbench.previewScreenshotFailed'))
    })
  }

  const runCommand = async (event) => {
    event.preventDefault()
    const value = command.trim()
    if (!value || terminalBusy) return
    setTerminalBusy(true)
    setCommand('')
    setTerminalTranscript((current) => appendTerminalEntry(current, { stream: TERMINAL_STREAM.COMMAND, text: value }))
    try {
      const result = await runWorkbenchTerminal({ command: value, cwd: cwd.trim() || '.' })
      setCwd(result.cwd || cwd)
      setTerminalTranscript((current) => {
        let next = current
        const stdout = stripAnsiSequences(result.stdout)
        const stderr = stripAnsiSequences(result.stderr)
        // Each stream keeps its own entry: a failure is not one more
        // paragraph of output, so the panel can label and place it.
        if (stdout) next = appendTerminalEntry(next, { stream: TERMINAL_STREAM.STDOUT, text: stdout })
        if (stderr) next = appendTerminalEntry(next, { stream: TERMINAL_STREAM.STDERR, text: stderr })
        if (result.error && !stderr) next = appendTerminalEntry(next, { stream: TERMINAL_STREAM.ERROR, text: result.error })
        return next
      })
    } catch (error) {
      setTerminalTranscript((current) => appendTerminalEntry(current, {
        stream: TERMINAL_STREAM.ERROR,
        text: error.message || t('workbench.terminalFailed'),
      }))
    } finally {
      setTerminalBusy(false)
    }
  }

  return (
    <aside
      id="right-workbench"
      data-testid="right-workbench"
      className="relative flex h-full min-w-0 max-w-[calc(100vw-60px)] shrink flex-row overflow-hidden border-l border-ink/10 bg-paper"
      style={{ width: `${panelWidth}px` }}
    >
      {/* One row of content under a header that carries the tool switch — the
          panel no longer hugs the screen edge with a vertical strip of its own. */}
      <div className="right-workbench-surface flex min-w-0 flex-1 flex-col overflow-hidden">
        <RightWorkbenchFrame
          beginResize={beginResize}
          isGenerating={isGenerating}
          onResetWidth={resetWidth}
          panelWidth={panelWidth}
          resizeWithKeyboard={resizeWithKeyboard}
          statusMessage={statusMessage}
          t={t}
          toolbar={(
            <WorkbenchToolbar
              activeTab={activeTab}
              contributedTabs={contributedTabs}
              onClose={onClose}
              onPickElement={elementPicker.toggle}
              onResetWidth={resetWidth}
              onScreenshot={takeScreenshot}
              picking={elementPicker.picking}
              onTabChange={onTabChange}
              onToggleExpand={toggleExpand}
              panelExpanded={panelExpanded}
              t={t}
              workspacePath={selectedWorkspacePath}
            />
          )}
        />
        <RightWorkbenchContent
          activeTab={activeTab}
          artifacts={artifacts}
          attachments={attachments}
          sessionId={sessionId}
          todos={todos}
          command={command}
          contributedTabs={contributedTabs}
          cwd={cwd}
          isGenerating={isGenerating}
          messages={messages}
          onOpenArtifact={onOpenArtifact}
          onSendMessage={onSendMessage}
          onTabChange={onTabChange}
          runCommand={runCommand}
          setCommand={setCommand}
          setCwd={setCwd}
          setTerminalTranscript={setTerminalTranscript}
          t={t}
          terminalBusy={terminalBusy}
          terminalTranscript={terminalTranscript}
          workspacePath={selectedWorkspacePath}
        />
      </div>
    </aside>
  )
}
