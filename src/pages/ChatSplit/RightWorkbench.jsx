import { useMemo, useState } from 'react'
import { Files, MessageSquare, Globe2, TerminalSquare, X, Play, ExternalLink, FileText, Download } from 'lucide-react'
import { buildArtifactPreview } from '../../lib/artifactPreview.js'
import { runWorkbenchTerminal } from '../../lib/workbenchClient.js'
import { useT } from '../../i18n/I18nProvider.jsx'
import { withDownloadToken } from '../../lib/jobClient.js'

const TABS = { files: Files, chat: MessageSquare, browser: Globe2, terminal: TerminalSquare }

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

export default function RightWorkbench({ messages = [], activeTab, onTabChange, onClose, onOpenArtifact, onSendMessage, isGenerating }) {
  const { t } = useT()
  const artifacts = useMemo(() => collectArtifacts(messages), [messages])
  const [sideInput, setSideInput] = useState('')
  const [browserInput, setBrowserInput] = useState('https://')
  const [browserUrl, setBrowserUrl] = useState('')
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('.')
  const [terminalOutput, setTerminalOutput] = useState('')
  const [terminalBusy, setTerminalBusy] = useState(false)

  const submitSideChat = (event) => {
    event.preventDefault()
    const content = sideInput.trim()
    if (!content || isGenerating) return
    setSideInput('')
    onSendMessage(content)
  }
  const navigateBrowser = (event) => {
    event.preventDefault()
    const value = browserInput.trim()
    if (/^https?:\/\//i.test(value)) setBrowserUrl(value)
  }
  const runCommand = async (event) => {
    event.preventDefault()
    const value = command.trim()
    if (!value || terminalBusy) return
    setTerminalBusy(true)
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

  return <aside id="right-workbench" data-testid="right-workbench" className="flex h-full w-[min(440px,42vw)] min-w-[340px] shrink-0 flex-col border-l border-ink/15 bg-paper-2">
    <div className="flex h-12 shrink-0 items-center justify-end border-b border-ink/10 px-2">
      <button type="button" onClick={onClose} aria-label={t('workbench.close')} title={t('workbench.close')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-fade hover:bg-paper hover:text-ink"><X className="h-4 w-4" /></button>
    </div>
    <nav data-testid="workbench-navigation" className="flex shrink-0 flex-col gap-1 border-b border-ink/10 p-2" aria-label={t('workbench.show')}>
      {Object.entries(TABS).map(([tab, Icon]) => <button
        key={tab}
        type="button"
        onClick={() => onTabChange(tab)}
        aria-current={activeTab === tab ? 'page' : undefined}
        className={`group flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors ${activeTab === tab ? 'bg-paper text-ink shadow-sm ring-1 ring-ink/5' : 'text-ink-soft hover:bg-paper/70 hover:text-ink'}`}
      >
        <Icon className={`h-4 w-4 shrink-0 ${activeTab === tab ? 'text-ember' : 'text-ink-fade group-hover:text-ink-soft'}`} />
        <span className="min-w-0 flex-1 truncate">{t(`workbench.${tab}`)}</span>
        {tab === 'files' && artifacts.length > 0 && <span data-testid="workbench-file-count" className="min-w-5 rounded-full bg-ember/10 px-1.5 py-0.5 text-center text-[10px] font-medium text-ember">{artifacts.length}</span>}
      </button>)}
    </nav>

    {activeTab === 'files' && <div data-testid="workbench-files" className="min-h-0 flex-1 overflow-y-auto p-3"><p className="mb-3 text-xs text-ink-fade">{t('workbench.filesHint')}</p>{artifacts.length === 0 ? <div className="flex h-40 flex-col items-center justify-center gap-2 text-ink-fade"><Files className="h-8 w-8 opacity-40" /><span className="text-sm">{t('workbench.noFiles')}</span></div> : artifacts.map((artifact) => artifact.direct ? <a key={artifact.id} href={withDownloadToken(artifact.url)} download={artifact.filename || ''} className="mb-2 flex w-full items-center gap-3 rounded-lg border border-ink/10 bg-paper p-3 text-left transition-colors hover:border-ember/40 hover:bg-paper/80"><span className="flex h-9 w-9 items-center justify-center rounded-md bg-paper-2 text-ember"><FileText className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.filename || 'artifact'}</span><span className="block truncate text-xs text-ink-fade">{artifact.type || 'file'}</span></span><Download className="h-3.5 w-3.5 text-ink-fade" /></a> : <button key={artifact.id} type="button" onClick={() => onOpenArtifact(artifact)} className="mb-2 flex w-full items-center gap-3 rounded-lg border border-ink/10 bg-paper p-3 text-left transition-colors hover:border-ember/40 hover:bg-paper/80"><span className="flex h-9 w-9 items-center justify-center rounded-md bg-paper-2 text-ember"><FileText className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.preview.filename}</span><span className="block truncate text-xs text-ink-fade">{artifact.preview.summary}</span></span><ExternalLink className="h-3.5 w-3.5 text-ink-fade" /></button>)}</div>}

    {activeTab === 'chat' && <div className="flex min-h-0 flex-1 flex-col"><div className="flex-1 space-y-2 overflow-y-auto p-3">{messages.filter((message) => ['user', 'assistant'].includes(message.role)).slice(-16).map((message, index) => <div key={message.id || index} className={`rounded-lg p-2.5 text-xs leading-5 ${message.role === 'user' ? 'ml-8 bg-ember/10 text-ink' : 'mr-5 bg-paper text-ink-soft'}`}>{String(message.content || '').slice(0, 1200)}</div>)}</div><form onSubmit={submitSideChat} className="border-t border-ink/10 p-3"><textarea value={sideInput} onChange={(event) => setSideInput(event.target.value)} rows={3} placeholder={t('workbench.chatPlaceholder')} className="w-full resize-none rounded-lg border border-ink/15 bg-paper p-2.5 text-sm outline-none focus:border-ember" /><button disabled={!sideInput.trim() || isGenerating} className="mt-2 h-8 rounded-md bg-ember px-3 text-xs text-paper disabled:opacity-50">{t(isGenerating ? 'workbench.generating' : 'workbench.send')}</button></form></div>}

    {activeTab === 'browser' && <div className="flex min-h-0 flex-1 flex-col"><form onSubmit={navigateBrowser} className="flex gap-2 border-b border-ink/10 p-2"><input value={browserInput} onChange={(event) => setBrowserInput(event.target.value)} aria-label={t('workbench.browserUrl')} className="min-w-0 flex-1 rounded-md border border-ink/15 bg-paper px-2 text-xs outline-none focus:border-ember" /><button className="h-8 rounded-md bg-ink px-3 text-xs text-paper">{t('workbench.go')}</button></form>{browserUrl ? <iframe title={t('workbench.browser')} src={browserUrl} sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" className="min-h-0 flex-1 border-0 bg-white" /> : <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-fade"><Globe2 className="h-9 w-9 opacity-40" /><span className="text-sm">{t('workbench.browserHint')}</span></div>}</div>}

    {activeTab === 'terminal' && <div className="flex min-h-0 flex-1 flex-col bg-[#191919] text-stone-200"><div className="border-b border-white/10 p-2"><input value={cwd} onChange={(event) => setCwd(event.target.value)} aria-label={t('workbench.cwd')} className="h-8 w-full rounded border border-white/10 bg-black/20 px-2 font-mono text-xs outline-none focus:border-ember" /></div><pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-5">{terminalOutput || t('workbench.terminalHint')}</pre><form onSubmit={runCommand} className="flex gap-2 border-t border-white/10 p-2"><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t('workbench.command')} className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 font-mono text-xs outline-none focus:border-ember" /><button disabled={terminalBusy || !command.trim()} aria-label={t('workbench.run')} className="flex h-8 w-8 items-center justify-center rounded bg-ember disabled:opacity-50"><Play className="h-3.5 w-3.5" /></button></form></div>}
  </aside>
}
