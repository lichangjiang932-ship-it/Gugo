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
import { buildArtifactPreview } from '../../lib/artifactPreview.js'
import { runWorkbenchTerminal } from '../../lib/workbenchClient.js'
import { useT } from '../../i18n/I18nProvider.jsx'
import { withDownloadToken } from '../../lib/jobClient.js'

const TABS = { files: Files, chat: MessageSquare, browser: Globe2, terminal: TerminalSquare }
const DEFAULT_WIDTH = 440
const MIN_WIDTH = 360
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

function collectArtifacts(messages) {
  return messages.flatMap((message, index) => {
    if (message?.role !== 'assistant') return []
    const direct = Array.isArray(message?.meta?.serverArtifacts)
      ? message.meta.serverArtifacts.map((artifact) => ({
          ...artifact,
          id: artifact.id || `${message.id || index}-${artifact.url}`,
          direct: true,
        }))
      : []
    const source = message?.meta?.artifactSource || message?.content
    if (!source) return direct
    const preview = buildArtifactPreview({ content: source, meta: message.meta })
    return preview ? [...direct, { id: message.id || `artifact-${index}`, messageId: message.id, content: source, preview }] : direct
  }).reverse()
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
  activeTab,
  onTabChange,
  onClose,
  onOpenArtifact,
  onSendMessage,
  isGenerating,
  statusMessage = '',
}) {
  const { t } = useT()
  const artifacts = useMemo(() => collectArtifacts(messages), [messages])
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
      className="relative flex h-full min-w-[360px] shrink-0 flex-col border-l border-ink/15 bg-paper-2 shadow-[-12px_0_30px_rgba(34,28,22,0.05)]"
      style={{ width: `${panelWidth}px` }}
    >
      <button
        type="button"
        data-testid="workbench-resize-handle"
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none bg-transparent outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-ember/50 focus-visible:after:bg-ember"
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

      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-ink/10 px-4 py-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${isGenerating ? 'animate-pulse bg-ember' : 'bg-emerald-500'}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">{t('workbench.title')}</h2>
          <p className="truncate text-[11px] text-ink-fade" title={statusMessage || undefined}>
            {statusMessage || t(isGenerating ? 'workbench.active' : 'workbench.ready')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPanelWidth(clampWidth(DEFAULT_WIDTH))}
          aria-label={t('workbench.resetWidth')}
          title={t('workbench.resetWidth')}
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-paper hover:text-ink"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onClose} aria-label={t('workbench.close')} title={t('workbench.close')} className="flex h-8 w-8 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-paper hover:text-ink"><X className="h-4 w-4" /></button>
      </header>

      <nav data-testid="workbench-navigation" className="grid shrink-0 grid-cols-4 gap-1 border-b border-ink/10 p-2" aria-label={t('workbench.show')}>
        {Object.entries(TABS).map(([tab, Icon]) => (
          <button
            key={tab}
            type="button"
            onClick={() => onTabChange(tab)}
            aria-current={activeTab === tab ? 'page' : undefined}
            className={`group relative flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs transition-colors ${activeTab === tab ? 'bg-paper text-ink shadow-sm ring-1 ring-ink/5' : 'text-ink-fade hover:bg-paper/70 hover:text-ink'}`}
          >
            <Icon className={`h-3.5 w-3.5 shrink-0 ${activeTab === tab ? 'text-ember' : ''}`} />
            <span className="truncate">{t(`workbench.${tab}`)}</span>
            {tab === 'files' && artifacts.length > 0 && <span data-testid="workbench-file-count" className="absolute -right-0.5 -top-1 min-w-4 rounded-full bg-ember px-1 py-0.5 text-center text-[9px] font-semibold leading-none text-paper">{artifacts.length}</span>}
          </button>
        ))}
      </nav>

      {activeTab === 'files' && (
        <section data-testid="workbench-files" className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold text-ink">{t('workbench.recentArtifacts')}</h3>
              <p className="mt-1 text-[11px] leading-4 text-ink-fade">{t('workbench.filesHint')}</p>
            </div>
            {artifacts.length > 0 && <span className="shrink-0 text-[10px] text-ink-fade">{t('workbench.itemCount', { count: artifacts.length })}</span>}
          </div>
          {artifacts.length === 0 ? (
            <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink/15 bg-paper/40 text-ink-fade"><Files className="h-8 w-8 opacity-35" /><span className="text-sm">{t('workbench.noFiles')}</span></div>
          ) : artifacts.map((artifact) => artifact.direct ? (
            <a key={artifact.id} href={withDownloadToken(artifact.url)} download={artifact.filename || ''} className="mb-2 flex w-full items-center gap-3 rounded-xl border border-ink/10 bg-paper p-3 text-left transition-all hover:-translate-y-0.5 hover:border-ember/35 hover:shadow-sm">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-ember/10 text-ember"><FileText className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.filename || t('workbench.untitledArtifact')}</span><span className="mt-0.5 block truncate text-[11px] uppercase tracking-wide text-ink-fade">{artifact.type || t('workbench.fileType')}</span></span>
              <Download className="h-3.5 w-3.5 text-ink-fade" />
            </a>
          ) : (
            <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact)} className="mb-2 flex w-full items-center gap-3 rounded-xl border border-ink/10 bg-paper p-3 text-left transition-all hover:-translate-y-0.5 hover:border-ember/35 hover:shadow-sm">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-ember/10 text-ember"><FileText className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.preview.filename}</span><span className="mt-0.5 block truncate text-[11px] text-ink-fade">{artifact.preview.summary}</span></span>
              <ExternalLink className="h-3.5 w-3.5 text-ink-fade" />
            </button>
          ))}
        </section>
      )}

      {activeTab === 'chat' && (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-3 overflow-y-auto p-3">
            {messages.filter((message) => ['user', 'assistant'].includes(message.role)).slice(-16).map((message, index) => (
              <article key={message.id || index} className={`rounded-xl border p-3 ${message.role === 'user' ? 'ml-8 border-ember/10 bg-ember/10' : 'mr-5 border-ink/10 bg-paper'}`}>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-fade">{t(message.role === 'user' ? 'workbench.you' : 'workbench.assistant')}</p>
                <p className="whitespace-pre-wrap break-words text-xs leading-5 text-ink-soft">{String(message.content || '').slice(0, 1200)}</p>
              </article>
            ))}
          </div>
          <form onSubmit={submitSideChat} className="border-t border-ink/10 bg-paper-2 p-3">
            <textarea value={sideInput} onChange={(event) => setSideInput(event.target.value)} rows={3} placeholder={t('workbench.chatPlaceholder')} className="w-full resize-none rounded-xl border border-ink/15 bg-paper p-3 text-sm outline-none transition-colors focus:border-ember" />
            <div className="mt-2 flex justify-end"><button disabled={!sideInput.trim() || isGenerating} className="h-8 rounded-lg bg-ember px-4 text-xs font-medium text-paper disabled:opacity-50">{t(isGenerating ? 'workbench.generating' : 'workbench.send')}</button></div>
          </form>
        </section>
      )}

      {activeTab === 'browser' && (
        <section className="flex min-h-0 flex-1 flex-col">
          <form onSubmit={navigateBrowser} className="border-b border-ink/10 p-2">
            <div className="flex gap-2"><input value={browserInput} onChange={(event) => setBrowserInput(event.target.value)} aria-label={t('workbench.browserUrl')} className="h-9 min-w-0 flex-1 rounded-lg border border-ink/15 bg-paper px-3 text-xs outline-none focus:border-ember" /><button className="h-9 rounded-lg bg-ink px-3 text-xs text-paper">{t('workbench.go')}</button></div>
            {browserError && <p role="alert" className="mt-1.5 px-1 text-[11px] text-red-600">{browserError}</p>}
          </form>
          {browserUrl ? <iframe title={t('workbench.browser')} src={browserUrl} sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" className="min-h-0 flex-1 border-0 bg-white" /> : <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-fade"><Globe2 className="h-9 w-9 opacity-35" /><span className="text-sm">{t('workbench.browserHint')}</span></div>}
        </section>
      )}

      {activeTab === 'terminal' && (
        <section className="flex min-h-0 flex-1 flex-col bg-[#191919] text-stone-200">
          <div className="flex items-center gap-2 border-b border-white/10 p-2"><input value={cwd} onChange={(event) => setCwd(event.target.value)} aria-label={t('workbench.cwd')} className="h-8 min-w-0 flex-1 rounded border border-white/10 bg-black/20 px-2 font-mono text-xs outline-none focus:border-ember" /><button type="button" onClick={() => setTerminalOutput('')} aria-label={t('workbench.clearTerminal')} title={t('workbench.clearTerminal')} className="flex h-8 w-8 items-center justify-center rounded text-stone-400 hover:bg-white/10 hover:text-stone-100"><Trash2 className="h-3.5 w-3.5" /></button></div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-5">{terminalOutput || t('workbench.terminalHint')}</pre>
          <form onSubmit={runCommand} className="flex gap-2 border-t border-white/10 p-2"><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t('workbench.command')} className="h-9 min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 font-mono text-xs outline-none focus:border-ember" /><button disabled={terminalBusy || !command.trim()} aria-label={t('workbench.run')} className="flex h-9 w-9 items-center justify-center rounded bg-ember disabled:opacity-50"><Play className="h-3.5 w-3.5" /></button></form>
        </section>
      )}
    </aside>
  )
}
