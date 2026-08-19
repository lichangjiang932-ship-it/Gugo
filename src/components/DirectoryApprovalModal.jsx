import { FolderOpen, Loader2, ShieldCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '../i18n/I18nProvider.jsx'
import InlineDirectoryBrowser from './InlineDirectoryBrowser.jsx'

function initialPath(request) {
  return String(request?.suggestGrantPath || request?.suggestedPath || request?.path || '').trim()
}

function initialAccessMode(request) {
  return request?.requiredAccessMode === 'read_write' || request?.accessMode === 'read_write'
    ? 'read_write'
    : 'read_only'
}

export default function DirectoryApprovalModal({ open, request, busy, error, onAuthorize, onReject }) {
  const { t } = useT()
  const [path, setPath] = useState(() => initialPath(request))
  const [accessMode, setAccessMode] = useState(() => initialAccessMode(request))
  const [authorizationScope, setAuthorizationScope] = useState('session')
  const [trustWorkspaceConfig, setTrustWorkspaceConfig] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const requiresWrite = initialAccessMode(request) === 'read_write'

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onReject?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onReject, open])

  if (!open || !request) return null

  return (
    <div
      className="mx-auto w-full max-w-[872px] px-4 pb-2"
      data-testid="directory-approval-modal"
    >
      <section
        className="w-full overflow-hidden rounded-md border border-sky-600/25 bg-paper"
        data-testid="directory-approval-card"
        role="region"
        aria-busy={!!busy}
        aria-labelledby="directory-approval-title"
      >
        <div className="flex items-start gap-3 border-b border-ink/10 bg-sky-500/5 px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-sky-500/10 text-sky-700">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="directory-approval-title" className="text-sm font-semibold text-ink">{t('taskSteering.directoryRequestTitle')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-fade">
              {requiresWrite ? t('taskSteering.directoryReadWrite') : t('taskSteering.directoryReadOnly')}
            </p>
          </div>
          <button
            type="button"
            onClick={onReject}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-paper hover:text-ink"
            aria-label={t('taskSteering.cancelDirectoryAuthorization')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_150px]">
          <div className="min-w-0">
            <label htmlFor="directory-approval-path" className="mb-1.5 block text-xs text-ink-soft">
              {t('localFiles.addTitle')}
            </label>
            <input
              id="directory-approval-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && path.trim() && !busy) {
                  onAuthorize?.({ path: path.trim(), accessMode, authorizationScope, trustWorkspaceConfig })
                }
              }}
              disabled={!!busy}
              placeholder={t('taskSteering.directoryPathPlaceholder')}
              className="h-10 w-full rounded-md border border-ink/15 bg-paper px-3 font-mono text-xs text-ink outline-none transition-colors focus:border-sky-600 disabled:opacity-60"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="directory-approval-mode" className="mb-1.5 block text-xs text-ink-soft">
              {t('localFiles.accessMode')}
            </label>
            <select
              id="directory-approval-mode"
              value={accessMode}
              onChange={(event) => setAccessMode(event.target.value)}
              disabled={!!busy || requiresWrite}
              className="h-10 w-full rounded-md border border-ink/15 bg-paper px-3 text-sm text-ink disabled:opacity-60"
            >
              <option value="read_only">{t('taskSteering.directoryReadOnly')}</option>
              <option value="read_write">{t('taskSteering.directoryReadWrite')}</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="directory-approval-scope" className="mb-1.5 block text-xs text-ink-soft">
              {t('localFiles.authorizationLifetime')}
            </label>
            <select
              id="directory-approval-scope"
              value={authorizationScope}
              onChange={(event) => setAuthorizationScope(event.target.value)}
              disabled={!!busy}
              className="h-10 w-full rounded-md border border-ink/15 bg-paper px-3 text-sm text-ink disabled:opacity-60"
            >
              <option value="session">{t('localFiles.authorizationSession')}</option>
              <option value="persistent">{t('localFiles.authorizationPersistent')}</option>
            </select>
          </div>

          {error && (
            <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700 sm:col-span-2" role="alert">
              {error}
            </p>
          )}
          {browserOpen && (
            <div className="sm:col-span-2">
              <InlineDirectoryBrowser
                initialPath={path}
                onSelect={(selectedPath) => {
                  setPath(selectedPath)
                  setBrowserOpen(false)
                }}
                onCancel={() => setBrowserOpen(false)}
                t={t}
              />
            </div>
          )}
          <label className="flex items-start gap-2 rounded-md border border-ink/10 bg-paper-2/60 px-3 py-2.5 text-xs leading-relaxed text-ink-soft sm:col-span-2">
            <input
              type="checkbox"
              checked={trustWorkspaceConfig}
              onChange={(event) => setTrustWorkspaceConfig(event.target.checked)}
              disabled={!!busy}
              className="mt-0.5 h-4 w-4 rounded border-ink/25 accent-sky-700"
            />
            <span>
              <strong className="block font-medium text-ink">{t('localFiles.workspaceTrustTitle')}</strong>
              <span className="mt-0.5 block text-ink-fade">{t('localFiles.workspaceTrustHint')}</span>
            </span>
          </label>
          <p className="text-xs leading-relaxed text-ink-fade sm:col-span-2">{t('localFiles.securityHint')}</p>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-ink/10 bg-paper-2/70 px-4 py-3">
          <button
            type="button"
            onClick={onReject}
            data-testid="directory-approval-cancel"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-ink/15 bg-paper px-4 text-sm text-ink-soft transition-colors hover:text-ink"
          >
            <X className="h-4 w-4" />
            {t('taskSteering.cancelDirectoryAuthorization')}
          </button>
          <button
            type="button"
            onClick={() => setBrowserOpen((current) => !current)}
            disabled={!!busy}
            data-testid="directory-approval-picker"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-sky-600/40 px-4 text-sm text-sky-800 transition-colors hover:bg-sky-500/5 disabled:opacity-50"
          >
            <FolderOpen className="h-4 w-4" />
            {t('taskSteering.chooseDirectory')}
          </button>
          <button
            type="button"
            onClick={() => onAuthorize?.({
              path: path.trim(),
              accessMode,
              authorizationScope,
              trustWorkspaceConfig,
            })}
            disabled={!!busy || !path.trim()}
            data-testid="directory-approval-authorize"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm text-paper transition-colors hover:bg-ink-soft disabled:opacity-60"
          >
            {busy === 'grant' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {t('taskSteering.authorizeDirectory')}
          </button>
        </div>
      </section>
    </div>
  )
}
