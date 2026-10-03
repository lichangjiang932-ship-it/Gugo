import {
  Play,
  Trash2,
} from 'lucide-react'
import { UiContributionRenderer } from '../../../plugins/uiContributionRegistry.js'
import EmbeddedBrowser from '../../../components/EmbeddedBrowser.jsx'
import { createTerminalTranscript } from '../../../lib/terminalTranscript.js'
import { isDesktopTerminalAvailable } from '../../../lib/desktopTerminalClient.js'
import PtyTerminalPanel from './PtyTerminalPanel.jsx'
import PreviewServerBar from './PreviewServerBar.jsx'
import WorkbenchEntry from './WorkbenchEntry.jsx'
import WorkbenchFiles from './WorkbenchFiles.jsx'

// Labels are used rather than colour alone to tell the streams apart: the console
// is a dark surface in every theme, so a themed colour token would be unreadable in
// at least one of them.
const STREAM_LABEL_KEYS = Object.freeze({
  stderr: 'workbench.terminalStderr',
  error: 'workbench.terminalError',
})

function TerminalPanel({ command, cwd, runCommand, setCommand, setCwd, setTerminalTranscript, t, terminalBusy, terminalTranscript }) {
  const entries = Array.isArray(terminalTranscript?.entries) ? terminalTranscript.entries : []
  const dropped = Number(terminalTranscript?.dropped) || 0
  return (
    <section className="workbench-terminal-surface flex min-h-0 flex-1 flex-col bg-ink text-paper">
      <div className="flex items-center gap-2 border-b border-paper/10 p-2"><input value={cwd} onChange={(event) => setCwd(event.target.value)} aria-label={t('workbench.cwd')} className="h-8 min-w-0 flex-1 rounded border border-paper/10 bg-paper/10 px-2 font-mono text-xs outline-none focus:border-focus" /><button type="button" onClick={() => setTerminalTranscript(createTerminalTranscript())} aria-label={t('workbench.clearTerminal')} title={t('workbench.clearTerminal')} className="flex h-8 w-8 items-center justify-center rounded text-paper/65 hover:bg-paper/10 hover:text-paper"><Trash2 className="h-3.5 w-3.5" /></button></div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-5" data-testid="workbench-terminal-transcript">
        {entries.length === 0 && <p className="text-paper/60">{t('workbench.terminalHint')}</p>}
        {dropped > 0 && (
          <p data-testid="workbench-terminal-elided" className="mb-1 text-paper/60">
            {t('workbench.terminalElided', { count: dropped })}
          </p>
        )}
        {entries.map((entry) => (
          <pre key={entry.id} data-testid="workbench-terminal-entry" data-stream={entry.stream} className={entry.stream === 'command' ? 'text-paper/70' : 'text-paper'}>
            {entry.stream === 'command'
              ? `${t('workbench.terminalPrompt')} ${entry.text}`
              : `${STREAM_LABEL_KEYS[entry.stream] ? `${t(STREAM_LABEL_KEYS[entry.stream])} ` : ''}${entry.text}`}
          </pre>
        ))}
        {terminalBusy && <p className="text-paper/60">{t('workbench.terminalRunning')}</p>}
      </div>
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
    onTabChange,
    t,
    workspacePath,
  } = props

  return (
    <>
      {activeTab === 'entry' && <WorkbenchEntry contributedTabs={contributedTabs} onTabChange={onTabChange} t={t} />}
      {activeTab === 'files' && <WorkbenchFiles artifacts={artifacts} onOpenArtifact={onOpenArtifact} t={t} />}
      {activeTab === 'browser' && (
        <section className="flex min-h-0 flex-1 flex-col">
          <PreviewServerBar active t={t} workspacePath={workspacePath} />
          <EmbeddedBrowser t={t} />
        </section>
      )}
      {/* The desktop app gets a real shell; the web build keeps the command console.
          The shell panel is mounted as soon as the workbench exists but starts only
          when the tab is opened, and it stays mounted afterwards so switching tabs
          does not kill a running command. */}
      {isDesktopTerminalAvailable() ? (
        <PtyTerminalPanel active={activeTab === 'terminal'} cwd={workspacePath} t={t} />
      ) : (
        activeTab === 'terminal' && <TerminalPanel {...props} />
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
    </>
  )
}
