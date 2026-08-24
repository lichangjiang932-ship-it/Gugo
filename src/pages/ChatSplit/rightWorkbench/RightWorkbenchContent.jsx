import {
  Download,
  ExternalLink,
  FileText,
  Files,
  Globe2,
  Play,
  Trash2,
} from 'lucide-react'
import { classifyDirectFile, withArtifactPreviewMode } from '../../../lib/directFilePreview.js'
import { withDownloadToken } from '../../../lib/jobClient.js'
import { UiContributionRenderer } from '../../../plugins/uiContributionRegistry.js'

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

function FilesPanel({ artifacts, onOpenArtifact, t }) {
  return (
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
  )
}

function ChatPanel({ isGenerating, messages, setSideInput, sideInput, submitSideChat, t }) {
  return (
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
  )
}

function BrowserPanel({ browserError, browserInput, browserUrl, navigateBrowser, setBrowserInput, t }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={navigateBrowser} className="border-b border-ink/10 p-2">
        <div className="flex gap-2"><input value={browserInput} onChange={(event) => setBrowserInput(event.target.value)} aria-label={t('workbench.browserUrl')} className="h-9 min-w-0 flex-1 rounded-control border border-ink/15 bg-paper px-3 text-xs outline-none focus:border-focus" /><button className="h-9 rounded-control bg-ink px-3 text-xs text-paper">{t('workbench.go')}</button></div>
        {browserError && <p role="alert" className="mt-1.5 px-1 text-xs text-danger">{browserError}</p>}
      </form>
      {browserUrl ? <iframe title={t('workbench.browser')} src={browserUrl} sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" className="min-h-0 flex-1 border-0 bg-white" /> : <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-fade"><Globe2 className="h-9 w-9 opacity-35" /><span className="text-sm">{t('workbench.browserHint')}</span></div>}
    </section>
  )
}

function TerminalPanel({ command, cwd, runCommand, setCommand, setCwd, setTerminalOutput, t, terminalBusy, terminalOutput }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col bg-ink text-paper">
      <div className="flex items-center gap-2 border-b border-paper/10 p-2"><input value={cwd} onChange={(event) => setCwd(event.target.value)} aria-label={t('workbench.cwd')} className="h-8 min-w-0 flex-1 rounded border border-paper/10 bg-paper/10 px-2 font-mono text-xs outline-none focus:border-focus" /><button type="button" onClick={() => setTerminalOutput('')} aria-label={t('workbench.clearTerminal')} title={t('workbench.clearTerminal')} className="flex h-8 w-8 items-center justify-center rounded text-paper/65 hover:bg-paper/10 hover:text-paper"><Trash2 className="h-3.5 w-3.5" /></button></div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs leading-5">{terminalOutput || t('workbench.terminalHint')}</pre>
      <form onSubmit={runCommand} className="flex gap-2 border-t border-white/10 p-2"><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder={t('workbench.command')} className="h-9 min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 font-mono text-xs outline-none focus:border-focus" /><button disabled={terminalBusy || !command.trim()} aria-label={t('workbench.run')} className="flex h-9 w-9 items-center justify-center rounded bg-accent disabled:opacity-50"><Play className="h-3.5 w-3.5" /></button></form>
    </section>
  )
}

export default function RightWorkbenchContent(props) {
  const {
    activeTab,
    artifacts,
    attachments,
    contributedTabs,
    isGenerating,
    messages,
    onOpenArtifact,
    onSendMessage,
    t,
  } = props

  return (
    <>
      {activeTab === 'files' && <FilesPanel artifacts={artifacts} onOpenArtifact={onOpenArtifact} t={t} />}
      {activeTab === 'chat' && <ChatPanel {...props} />}
      {activeTab === 'browser' && <BrowserPanel {...props} />}
      {activeTab === 'terminal' && <TerminalPanel {...props} />}
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
    </>
  )
}
