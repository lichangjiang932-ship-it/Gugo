import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  ExternalLink,
  FileText,
  Files,
  Globe2,
  MessageSquare,
  Play,
  RotateCcw,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react'
import { resolveDeliveryArtifacts } from '../../lib/artifactReferences.js'
import { buildAttachmentPreviewArtifact } from '../../lib/attachmentPreview.js'
import { classifyDirectFile, withArtifactPreviewMode } from '../../lib/directFilePreview.js'
import {
  buildRetainedLocalFileReferences,
  buildVerifiedLocalFileReferences,
} from '../../lib/localFileReferences.js'
import { runWorkbenchTerminal } from '../../lib/workbenchClient.js'
import { useT } from '../../i18n/I18nProvider.jsx'
import { withDownloadToken } from '../../lib/jobClient.js'
import { verifiedLocalFileIdentity } from '../../lib/verifiedLocalFileIdentity.js'
import { UiContributionRenderer, useUiContributions } from '../../plugins/uiContributionRegistry.js'

const TABS = { files: Files, chat: MessageSquare, browser: Globe2, terminal: TerminalSquare }
const DEFAULT_WIDTH = 420
const MIN_WIDTH = 320
const WIDTH_STORAGE_KEY = 'yma:right-workbench-width'

function clampWidth(value) {
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
  const maxWidth = Math.max(MIN_WIDTH, Math.min(760, viewportWidth - 320))
  return Math.min(maxWidth, Math.max(MIN_WIDTH, Number(value) || DEFAULT_WIDTH))
}

function readStoredWidth() {
  if (typeof window === 'undefined') return DEFAULT_WIDTH
  try {
    return clampWidth(window.localStorage.getItem(WIDTH_STORAGE_KEY))
  } catch {
    return DEFAULT_WIDTH
  }
}

function collectAttachmentArtifacts(attachments, { messageId = '', current = false } = {}) {
  return (Array.isArray(attachments) ? attachments : [])
    .map((attachment) => buildAttachmentPreviewArtifact(attachment, { messageId }))
    .filter(Boolean)
    .map((artifact, index) => ({
      ...artifact.directFile,
      id: artifact.directFile.id || `${messageId || 'current'}-${index}-${artifact.directFile.url}`,
      messageId,
      userAttachment: true,
      currentAttachment: current,
    }))
}

function collectArtifacts(messages, currentAttachments = []) {
  const messageArtifacts = messages.flatMap((message, index) => {
    if (message?.role === 'user') {
      return collectAttachmentArtifacts(message.attachments, { messageId: message.id || String(index) })
    }
    if (message?.role !== 'assistant') return []
    const suspended = message?.meta?.interrupted === true || message?.meta?.paused === true
    const canPresentLocalFiles = message?.meta?.streaming !== true
      || suspended
      || message?.meta?.failed === true
    if (!canPresentLocalFiles) return []
    const deliveryArtifacts = message?.meta?.failed || suspended || message?.meta?.streaming
      ? []
      : resolveDeliveryArtifacts(message?.meta)
    const verifiedLocalFiles = buildVerifiedLocalFileReferences({
      toolCalls: message?.meta?.toolCalls,
      verifiedLocalFiles: message?.meta?.verifiedLocalFiles,
      messageId: message?.id,
      turnId: message?.meta?.serverTurnId,
    }).map((reference) => ({
      ...(reference.previewArtifact?.directFile || {}),
      id: reference.id,
      messageId: message.id,
      verifiedLocalFile: true,
    }))
    const retainedLocalFiles = buildRetainedLocalFileReferences({
      toolCalls: message?.meta?.toolCalls,
      retainedLocalFiles: message?.meta?.retainedLocalFiles,
      messageId: message?.id,
      turnId: message?.meta?.serverTurnId,
    }).map((reference) => ({
      ...(reference.previewArtifact?.directFile || {}),
      id: reference.id,
      messageId: message.id,
      retainedLocalFile: true,
      verificationPending: true,
    }))
    const managedArtifacts = deliveryArtifacts
      .filter((artifact) => artifact?.url)
      .map((artifact) => ({
        ...artifact,
        id: artifact.id || `${message.id || index}-${artifact.url}`,
        messageId: message.id,
      }))
    return [...managedArtifacts, ...retainedLocalFiles, ...verifiedLocalFiles]
  }).reverse()
  const newestFirst = [
    ...collectAttachmentArtifacts(currentAttachments, { current: true }).reverse(),
    ...messageArtifacts,
  ]
  const seenLocalFiles = new Set()
  const seenAttachments = new Set()
  return newestFirst.filter((artifact) => {
    if (artifact?.userAttachment === true) {
      const identity = String(artifact.id || artifact.url || '')
      if (!identity || seenAttachments.has(identity)) return false
      seenAttachments.add(identity)
      return true
    }
    if (artifact?.verifiedLocalFile !== true && artifact?.retainedLocalFile !== true) return true
    const identity = verifiedLocalFileIdentity(artifact)
    if (!identity || seenLocalFiles.has(identity)) return !identity
    seenLocalFiles.add(identity)
    return true
  })
}

function WorkbenchFileVisual({ artifact }) {
  const kind = classifyDirectFile(artifact)
  if (kind !== 'image' || !artifact?.url) {
    return <FileText className="h-3.5 w-3.5" />
  }
  const previewUrl = withArtifactPreviewMode(withDownloadToken(artifact.url))
  return (
    <img
      src={previewUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className="h-full w-full rounded-control object-cover"
    />
  )
}

function openArtifactLink(event, onOpenArtifact, artifact) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (typeof onOpenArtifact !== 'function') return
  event.preventDefault()
  onOpenArtifact({ messageId: artifact.messageId || '', content: '', preview: null, directFile: artifact })
}

function normalizeBrowserUrl(value) {
  const input = String(value || '').trim()
  if (!input) return ''
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch {
    return ''
  }
}

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

  const submitSideChat = (event) => {
    event.preventDefault()
    const content = sideInput.trim()
    if (!content || isGenerating) return
    setSideInput('')
    onSendMessage(content)
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
      <button
        type="button"
        data-testid="workbench-resize-handle"
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none bg-transparent outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-accent/50 focus-visible:after:bg-focus"
        aria-label={t('workbench.resize')}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={clampWidth(Number.MAX_SAFE_INTEGER)}
        aria-valuenow={panelWidth}
        aria-orientation="vertical"
        role="separator"
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => setPanelWidth(clampWidth(DEFAULT_WIDTH))}
      />

      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink/10 px-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-xs font-semibold text-ink">{t('workbench.title')}</h2>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-pill ${isGenerating ? 'animate-pulse bg-running' : 'bg-success'}`} aria-hidden="true" />
          </div>
          <p className="mt-0.5 truncate text-xs leading-5 text-ink-fade" title={statusMessage || undefined}>
            {statusMessage || t(isGenerating ? 'workbench.active' : 'workbench.ready')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPanelWidth(clampWidth(DEFAULT_WIDTH))}
          aria-label={t('workbench.resetWidth')}
          title={t('workbench.resetWidth')}
          className="flex h-7 w-7 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button type="button" data-testid="workbench-close" onClick={onClose} aria-label={t('workbench.close')} title={t('workbench.close')} className="flex h-7 w-7 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-ink/5 hover:text-ink"><X className="h-4 w-4" /></button>
      </header>

      <nav data-testid="workbench-navigation" className="flex h-10 shrink-0 items-stretch gap-1 border-b border-ink/10 px-2" aria-label={t('workbench.show')}>
        {Object.entries(TABS).map(([tab, Icon]) => (
          <button
            key={tab}
            type="button"
            data-testid={`workbench-tab-${tab}`}
            onClick={() => onTabChange(tab)}
            aria-current={activeTab === tab ? 'page' : undefined}
            aria-label={t(`workbench.${tab}`)}
            title={t(`workbench.${tab}`)}
            className={`group relative flex min-w-0 flex-1 items-center justify-center gap-1.5 border-b-2 px-1 text-xs transition-colors ${activeTab === tab ? 'border-blue-500 text-blue-600' : 'border-transparent text-ink-fade hover:text-ink'}`}
          >
            <Icon className="h-[18px] w-[18px] shrink-0" />
            <span className="sr-only">{t(`workbench.${tab}`)}</span>
            {tab === 'files' && artifacts.length > 0 && <span data-testid="workbench-file-count" data-compact-numeric-badge className="min-w-4 rounded-pill bg-ink/[0.08] px-1 py-0.5 text-center text-[9px] font-semibold leading-none text-ink-soft">{artifacts.length}</span>}
          </button>
        ))}
        {contributedTabs.map((contribution) => {
          const Icon = contribution.icon || Files
          const label = contribution.labelKey ? t(contribution.labelKey) : contribution.label
          return <button
            key={contribution.key}
            type="button"
            data-testid={`workbench-tab-${contribution.tabId}`}
            data-ui-plugin={contribution.pluginId}
            onClick={() => onTabChange(contribution.tabId)}
            aria-current={activeTab === contribution.tabId ? 'page' : undefined}
            aria-label={label}
            title={label}
            className={`group relative flex min-w-0 flex-1 items-center justify-center border-b-2 px-1 text-xs transition-colors ${activeTab === contribution.tabId ? 'border-blue-500 text-blue-600' : 'border-transparent text-ink-fade hover:text-ink'}`}
          ><Icon className="h-[18px] w-[18px] shrink-0" /><span className="sr-only">{label}</span></button>
        })}
      </nav>

      {activeTab === 'files' && (
        <section data-testid="workbench-files" data-artifact-surface="workbench-files" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <div className="mb-2 flex items-end justify-between gap-3 px-1">
            <div>
              <h3 className="text-xs font-semibold text-ink">{t('workbench.recentArtifacts')}</h3>
              <p className="mt-1 text-xs leading-4 text-ink-fade">{t('workbench.filesHint')}</p>
            </div>
            {artifacts.length > 0 && <span className="shrink-0 text-xs text-ink-fade tabular-nums">{t('workbench.itemCount', { count: artifacts.length })}</span>}
          </div>
          {artifacts.length === 0 ? (
            <div className="flex h-44 flex-col items-center justify-center gap-2 text-ink-fade"><Files className="h-7 w-7 opacity-30" /><span className="text-xs">{t('workbench.noFiles')}</span></div>
          ) : artifacts.map((artifact) => (
            <div key={artifact.id} className="group flex w-full items-center rounded-control transition-colors hover:bg-ink/5">
              <a
                href={withDownloadToken(artifact.url)}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="workbench-file-open"
                onClick={(event) => openArtifactLink(event, onOpenArtifact, artifact)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-control bg-ink/5 text-ink-fade"><WorkbenchFileVisual artifact={artifact} /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.filename || t('workbench.untitledArtifact')}</span><span className="mt-0.5 block truncate text-xs uppercase tracking-wide text-ink-fade">{artifact.type || t('workbench.fileType')}</span></span>
                <ExternalLink className="h-3.5 w-3.5 text-ink-fade" />
              </a>
              <a href={withDownloadToken(artifact.url)} download={artifact.filename || ''} aria-label={t('chatPreview.download', { filename: artifact.filename || t('workbench.untitledArtifact') })} title={t('chatPreview.download', { filename: artifact.filename || t('workbench.untitledArtifact') })} className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-fade hover:bg-paper hover:text-accent-ink"><Download className="h-3.5 w-3.5" /></a>
            </div>
          ))}
        </section>
      )}

      {activeTab === 'chat' && (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
            {messages.filter((message) => ['user', 'assistant'].includes(message.role)).slice(-16).map((message, index) => (
              <article key={message.id || index} className={`border-l-2 py-1 pl-3 ${message.role === 'user' ? 'ml-6 border-accent/50' : 'mr-3 border-ink/15'}`}>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-fade">{t(message.role === 'user' ? 'workbench.you' : 'workbench.assistant')}</p>
                <p className="whitespace-pre-wrap break-words text-xs leading-5 text-ink-soft">{String(message.content || '').slice(0, 1200)}</p>
              </article>
            ))}
          </div>
          <form onSubmit={submitSideChat} className="border-t border-ink/10 p-3">
            <textarea value={sideInput} onChange={(event) => setSideInput(event.target.value)} rows={3} placeholder={t('workbench.chatPlaceholder')} className="w-full resize-none rounded-control border border-ink/15 bg-paper px-3 py-2.5 text-sm outline-none transition-colors focus:border-ink/40" />
            <div className="mt-2 flex justify-end"><button disabled={!sideInput.trim() || isGenerating} className="h-8 rounded-control bg-ink px-4 text-xs font-medium text-paper disabled:opacity-40">{t(isGenerating ? 'workbench.generating' : 'workbench.send')}</button></div>
          </form>
        </section>
      )}

      {activeTab === 'browser' && (
        <section className="flex min-h-0 flex-1 flex-col">
          <form onSubmit={navigateBrowser} className="border-b border-ink/10 p-2">
            <div className="flex gap-2"><input value={browserInput} onChange={(event) => setBrowserInput(event.target.value)} aria-label={t('workbench.browserUrl')} className="h-9 min-w-0 flex-1 rounded-control border border-ink/15 bg-paper px-3 text-xs outline-none focus:border-focus" /><button className="h-9 rounded-control bg-ink px-3 text-xs text-paper">{t('workbench.go')}</button></div>
            {browserError && <p role="alert" className="mt-1.5 px-1 text-xs text-danger">{browserError}</p>}
          </form>
          {browserUrl ? <iframe title={t('workbench.browser')} src={browserUrl} sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" className="min-h-0 flex-1 border-0 bg-white" /> : <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-fade"><Globe2 className="h-9 w-9 opacity-35" /><span className="text-sm">{t('workbench.browserHint')}</span></div>}
        </section>
      )}

      {activeTab === 'terminal' && (
        <section className="flex min-h-0 flex-1 flex-col bg-[#191919] text-stone-200">
          <div className="flex items-center gap-2 border-b border-white/10 p-2"><input value={cwd} onChange={(event) => setCwd(event.target.value)} aria-label={t('workbench.cwd')} className="h-8 min-w-0 flex-1 rounded border border-white/10 bg-black/20 px-2 font-mono text-xs outline-none focus:border-focus" /><button type="button" onClick={() => setTerminalOutput('')} aria-label={t('workbench.clearTerminal')} title={t('workbench.clearTerminal')} className="flex h-8 w-8 items-center justify-center rounded text-stone-400 hover:bg-white/10 hover:text-stone-100"><Trash2 className="h-3.5 w-3.5" /></button></div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-5">{terminalOutput || t('workbench.terminalHint')}</pre>
          <form onSubmit={runCommand} className="flex gap-2 border-t border-white/10 p-2"><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t('workbench.command')} className="h-9 min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 font-mono text-xs outline-none focus:border-focus" /><button disabled={terminalBusy || !command.trim()} aria-label={t('workbench.run')} className="flex h-9 w-9 items-center justify-center rounded bg-accent disabled:opacity-50"><Play className="h-3.5 w-3.5" /></button></form>
        </section>
      )}
      {contributedTabs.map((contribution) => activeTab === contribution.tabId && (
        <UiContributionRenderer
          key={contribution.key}
          contribution={contribution}
          context={{
            artifacts,
            attachments,
            isGenerating,
            messages,
            onOpenArtifact,
            onSendMessage,
            t,
          }}
          fallback={<div role="alert" className="p-4 text-sm text-danger">{t('errors.unknown')}</div>}
        />
      ))}
    </aside>
  )
}
