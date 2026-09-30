import { useState } from 'react'
import { ChevronDown, Play, RotateCw, Server, Square, Wand2 } from 'lucide-react'

import usePreviewServer from './usePreviewServer.js'

const STATUS_KEYS = Object.freeze({
  stopped: 'workbench.previewStatusStopped',
  starting: 'workbench.previewStatusStarting',
  ready: 'workbench.previewStatusReady',
  failed: 'workbench.previewStatusFailed',
  exited: 'workbench.previewStatusExited',
  killed: 'workbench.previewStatusKilled',
})

const STATUS_DOT = Object.freeze({
  stopped: 'bg-skel-2',
  starting: 'bg-running',
  ready: 'bg-accent',
  failed: 'bg-danger',
  exited: 'bg-skel-2',
  killed: 'bg-skel-2',
})

const ACTION = 'inline-flex h-7 items-center gap-1.5 rounded-control px-2 text-xs text-ink-soft transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent'

function logTail(text, lines = 8) {
  return String(text || '').split('\n').filter((line) => line.trim()).slice(-lines).join('\n')
}

/**
 * The dev server this project runs, and the switch that makes verification automatic.
 *
 * A bar rather than a menu item: the server's state is the thing a reader wants to
 * know while looking at a blank frame — "is it starting, did it die, is the port
 * wrong" — and a state you have to open a menu to see is a state nobody checks.
 * The commands behind it are the ones launch.json declares; nothing here composes
 * a command of its own.
 */
export default function PreviewServerBar({ active = true, t, workspacePath = '' }) {
  const [open, setOpen] = useState(false)
  const preview = usePreviewServer({ active, workspaceRoot: workspacePath })
  const server = preview.state?.server || { status: workspacePath ? 'stopped' : '' }
  const configurations = preview.state?.configurations || []
  const missing = preview.state?.missing === true
  const problems = preview.state?.problems || []
  const status = server.status || 'stopped'
  const running = ['starting', 'ready'].includes(status)
  const selected = configurations.find((entry) => entry.name === server.name) || configurations[0] || null

  if (!workspacePath) {
    return (
      <p data-testid="preview-server-bar" className="shrink-0 border-b border-ink/10 px-3 py-2 text-xs leading-5 text-ink-fade">
        {t('workbench.previewNeedsWorkspace')}
      </p>
    )
  }

  return (
    <div data-testid="preview-server-bar" className="shrink-0 border-b border-ink/10">
      <div className="flex h-9 items-center gap-2 px-2">
        <button
          type="button"
          data-testid="preview-server-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-1.5 py-1 text-left text-xs text-ink transition-colors hover:bg-ink/[0.05]"
        >
          <Server className="h-3.5 w-3.5 shrink-0 text-ink-fade" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium" title={t('workbench.previewServer')}>
            {missing ? t('workbench.previewUnconfigured') : (selected?.name || t('workbench.previewUnconfigured'))}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-ink-fade">
            <span data-testid="preview-server-status-dot" data-status={status} className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status] || 'bg-skel-2'}`} aria-hidden="true" />
            <span className="preview-server-detail">{t(STATUS_KEYS[status] || 'workbench.previewStatusStopped')}</span>
          </span>
          {server.port > 0 && <span className="preview-server-detail shrink-0 font-mono text-ink-fade">{t('workbench.previewPort', { port: server.port })}</span>}
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink-fade transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
        {missing ? (
          <button type="button" data-testid="preview-setup" disabled={preview.busy === 'setup'}
            title={t('workbench.previewSetup')} onClick={() => preview.setup()} className={ACTION}>
            <Wand2 className="h-3.5 w-3.5" aria-hidden="true" /><span className="preview-server-label">{t('workbench.previewSetup')}</span>
          </button>
        ) : (
          <>
            {!running && (
              <button type="button" data-testid="preview-start" disabled={Boolean(preview.busy)}
                title={t('workbench.previewStart')} onClick={() => preview.start(selected?.name || '')} className={ACTION}>
                <Play className="h-3.5 w-3.5" aria-hidden="true" /><span className="preview-server-label">{t('workbench.previewStart')}</span>
              </button>
            )}
            {running && (
              <>
                <button type="button" data-testid="preview-restart" disabled={Boolean(preview.busy)}
                  title={t('workbench.previewRestart')} onClick={() => preview.restart(selected?.name || '')} className={ACTION}>
                  <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /><span className="preview-server-label">{t('workbench.previewRestart')}</span>
                </button>
                <button type="button" data-testid="preview-stop" disabled={Boolean(preview.busy)}
                  title={t('workbench.previewStop')} onClick={() => preview.stop()} className={ACTION}>
                  <Square className="h-3 w-3" aria-hidden="true" /><span className="preview-server-label">{t('workbench.previewStop')}</span>
                </button>
              </>
            )}
          </>
        )}
      </div>

      {open && (
        <div data-testid="preview-server-panel" className="border-t border-ink/10 px-3 py-2 text-xs leading-5">
          {missing && <p className="mb-2 text-ink-soft">{t('workbench.previewMissingHint')}</p>}
          {problems.length > 0 && (
            <div className="mb-2" data-testid="preview-problems">
              <p className="font-medium text-danger">{t('workbench.previewProblems')}</p>
              <ul className="mt-0.5 list-disc pl-4 text-ink-soft">
                {problems.map((problem) => <li key={problem}>{problem}</li>)}
              </ul>
            </div>
          )}
          {preview.error && (
            <p data-testid="preview-error" role="alert" className="mb-2 text-danger">{preview.error.message}</p>
          )}
          {/* Why the server itself is not running — the reason a start failed, or
              the reason a running one died — is the state's own error, not this
              panel's last action's. */}
          {server.error && !preview.error && (
            <p data-testid="preview-server-error" role="alert" className="mb-2 text-danger">{server.error}</p>
          )}
          {configurations.length > 1 && (
            <div className="mb-2">
              <p className="text-ink-fade">{t('workbench.previewConfigurations')}</p>
              <ul className="mt-0.5 space-y-0.5">
                {configurations.map((configuration) => (
                  <li key={configuration.name} className="flex items-center gap-2">
                    <span className={`min-w-0 flex-1 truncate font-mono ${configuration.name === server.name ? 'text-ink' : 'text-ink-soft'}`} title={configuration.command}>
                      {configuration.name}
                    </span>
                    <span className="shrink-0 font-mono text-ink-fade">{configuration.port}</span>
                    {configuration.name !== server.name && (
                      <button type="button" data-testid={`preview-start-${configuration.name}`} disabled={Boolean(preview.busy)}
                        onClick={() => preview.restart(configuration.name)} className={ACTION}>
                        {t('workbench.previewStart')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label className="flex items-start gap-2">
            <input type="checkbox" data-testid="preview-auto-verify" className="mt-0.5"
              checked={preview.state?.autoVerify === true} disabled={Boolean(preview.busy)}
              onChange={(event) => preview.setAutoVerify(event.target.checked)} />
            <span className="min-w-0">
              <span className="font-medium text-ink">{t('workbench.previewAutoVerify')}</span>
              <span className="block text-ink-fade">{t('workbench.previewAutoVerifyHint')}</span>
            </span>
          </label>
          <div className="mt-2">
            <p className="text-ink-fade">{t('workbench.previewLog')}</p>
            <pre data-testid="preview-log" className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-control border border-ink/10 bg-paper-2/40 p-1.5 font-mono text-xs leading-4 text-ink-soft">
              {logTail(preview.state?.log) || t('workbench.previewLogEmpty')}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
