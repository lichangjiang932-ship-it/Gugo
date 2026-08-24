import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.jsx'
import { runWorkbenchTerminal } from '../../lib/workbenchClient.js'
import { useUiContributions } from '../../plugins/uiContributionRegistry.js'
import RightWorkbenchContent from './rightWorkbench/RightWorkbenchContent.jsx'
import RightWorkbenchFrame from './rightWorkbench/RightWorkbenchFrame.jsx'
import { collectArtifacts } from './rightWorkbench/rightWorkbenchArtifacts.js'
import {
  clampWidth,
  DEFAULT_WIDTH,
  normalizeBrowserUrl,
  readStoredWidth,
  WIDTH_STORAGE_KEY,
} from './rightWorkbench/rightWorkbenchLayout.js'

export default function RightWorkbench({
  messages = [],
  attachments = [],
  activeTab,
  onTabChange,
  onClose,
  onOpenArtifact,
  onSendMessage,
  isGenerating,
  statusMessage = '',
}) {
  const { t } = useT()
  const contributedTabs = useUiContributions('workbench-tab')
  const artifacts = useMemo(() => collectArtifacts(messages, attachments), [attachments, messages])
  const resizeRef = useRef(null)
  const [panelWidth, setPanelWidth] = useState(readStoredWidth)
  const [sideInput, setSideInput] = useState('')
  const [browserInput, setBrowserInput] = useState('https://')
  const [browserUrl, setBrowserUrl] = useState('')
  const [browserError, setBrowserError] = useState('')
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('.')
  const [terminalOutput, setTerminalOutput] = useState('')
  const [terminalBusy, setTerminalBusy] = useState(false)

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

  const submitSideChat = async (event) => {
    event.preventDefault()
    const inputSnapshot = sideInput
    const content = inputSnapshot.trim()
    if (!content || isGenerating) return
    try {
      const accepted = await onSendMessage?.(content)
      if (accepted === true) {
        setSideInput((current) => current === inputSnapshot ? '' : current)
      }
    } catch {
      // Keep the draft intact. The parent surface owns the actionable error.
    }
  }

  const navigateBrowser = (event) => {
    event.preventDefault()
    const nextUrl = normalizeBrowserUrl(browserInput)
    if (!nextUrl) {
      setBrowserError(t('workbench.browserInvalid'))
      return
    }
    setBrowserError('')
    setBrowserInput(nextUrl)
    setBrowserUrl(nextUrl)
  }

  const runCommand = async (event) => {
    event.preventDefault()
    const value = command.trim()
    if (!value || terminalBusy) return
    setTerminalBusy(true)
    setCommand('')
    setTerminalOutput((current) => `${current}${current ? '\n\n' : ''}> ${value}\n`)
    try {
      const result = await runWorkbenchTerminal({ command: value, cwd: cwd.trim() || '.' })
      setCwd(result.cwd || cwd)
      setTerminalOutput((current) => `${current}${result.stdout || ''}${result.stderr || ''}${result.error ? `\n${result.error}` : ''}`)
    } catch (error) {
      setTerminalOutput((current) => `${current}${error.message || t('workbench.terminalFailed')}`)
    } finally {
      setTerminalBusy(false)
    }
  }

  return (
    <aside
      id="right-workbench"
      data-testid="right-workbench"
      className="relative flex h-full min-w-0 max-w-[calc(100vw-60px)] shrink flex-col overflow-hidden border-l border-ink/10 bg-paper"
      style={{ width: `${panelWidth}px` }}
    >
      <RightWorkbenchFrame
        activeTab={activeTab}
        artifacts={artifacts}
        beginResize={beginResize}
        contributedTabs={contributedTabs}
        isGenerating={isGenerating}
        onClose={onClose}
        onResetWidth={resetWidth}
        onTabChange={onTabChange}
        panelWidth={panelWidth}
        resizeWithKeyboard={resizeWithKeyboard}
        statusMessage={statusMessage}
        t={t}
      />
      <RightWorkbenchContent
        activeTab={activeTab}
        artifacts={artifacts}
        attachments={attachments}
        browserError={browserError}
        browserInput={browserInput}
        browserUrl={browserUrl}
        command={command}
        contributedTabs={contributedTabs}
        cwd={cwd}
        isGenerating={isGenerating}
        messages={messages}
        navigateBrowser={navigateBrowser}
        onOpenArtifact={onOpenArtifact}
        onSendMessage={onSendMessage}
        runCommand={runCommand}
        setBrowserInput={setBrowserInput}
        setCommand={setCommand}
        setCwd={setCwd}
        setSideInput={setSideInput}
        setTerminalOutput={setTerminalOutput}
        sideInput={sideInput}
        submitSideChat={submitSideChat}
        t={t}
        terminalBusy={terminalBusy}
        terminalOutput={terminalOutput}
      />
    </aside>
  )
}
