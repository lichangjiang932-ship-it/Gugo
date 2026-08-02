import { FolderOpen, Loader2, ShieldCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '../i18n/I18nProvider.jsx'

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
  const requiresWrite = initialAccessMode(request) === 'read_write'

  useEffect(() => {
    if (!open || busy) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onReject?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onReject, open])

  if (!open || !request) return null

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-ink/35 px-4 py-6 backdrop-blur-sm" data-testid="directory-approval-modal">
      <div className="w-full max-w-xl overflow-hidden rounded-md border border-ink/15 bg-paper shadow-2xl">
        <div className="flex items-start gap-3 border-b border-ink/10 bg-paper-2 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-sky-500/10 text-sky-700">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">{t('taskSteering.directoryRequestTitle')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-ink-fade">
              {requiresWrite ? t('taskSteering.directoryReadWrite') : t('taskSteering.directoryReadOnly')}
            </p>
          </div>
          <button
            type="button"
            onClick={onReject}
            disabled={!!busy}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-paper hover:text-ink disabled:opacity-50"
            aria-label={t('toolApproval.deny')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label htmlFor="directory-approval-path" className="mb-1.5 block text-xs text-ink-soft">
              {t('localFiles.addTitle')}
            </label>
            <input
              id="directory-approval-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && path.trim() && !busy) {
                  onAuthorize?.({ path: path.trim(), accessMode, usePicker: false })
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

          {error && (
            <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700" role="alert">
              {error}
            </p>
          )}
          <p className="text-xs leading-relaxed text-ink-fade">{t('localFiles.securityHint')}</p>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-ink/10 bg-paper-2 px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onReject}
            disabled={!!busy}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-ink/15 bg-paper px-4 text-sm text-ink-soft transition-colors hover:text-ink disabled:opacity-50"
          >
            <X className="h-4 w-4" />
            {t('toolApproval.deny')}
          </button>
          <button
            type="button"
            onClick={() => onAuthorize?.({ path: path.trim(), accessMode, usePicker: true })}
            disabled={!!busy}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-sky-600/40 px-4 text-sm text-sky-800 transition-colors hover:bg-sky-500/5 disabled:opacity-50"
          >
            {busy === 'picker' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
            {t('taskSteering.chooseDirectory')}
          </button>
          <button
            type="button"
            onClick={() => onAuthorize?.({ path: path.trim(), accessMode, usePicker: false })}
            disabled={!!busy || !path.trim()}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm text-paper transition-colors hover:bg-ink-soft disabled:opacity-60"
          >
            {busy === 'grant' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {t('taskSteering.authorizeDirectory')}
          </button>
        </div>
      </div>
    </div>
  )
}
