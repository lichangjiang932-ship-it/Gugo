import { useState } from 'react'
import { FolderOpen, LoaderCircle } from 'lucide-react'
import InlineDirectoryBrowser from '../../components/InlineDirectoryBrowser.jsx'

export default function DirectoryRequestCard({ request, busy, error = '', onAuthorize, t, browseDirectories }) {
  const [path, setPath] = useState(request.suggested_path || request.suggestedPath || '')
  const [browserOpen, setBrowserOpen] = useState(false)
  const requestedMode = request.access_mode || request.accessMode
  const [accessMode, setAccessMode] = useState(requestedMode === 'read_write' ? 'read_write' : 'read_only')
  const [authorizationScope, setAuthorizationScope] = useState('session')

  const authorize = () => onAuthorize({ path, accessMode, authorizationScope })

  return (
    <div className="mt-3 rounded-md border border-dashed border-running/45 bg-running/5 p-3" data-testid="directory-request-card">
      <div className="flex items-start gap-2">
        <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-running" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-running">{t('taskSteering.directoryRequestTitle')}</p>
          <p className="mt-1 text-sm text-ink">{request.why || request.purpose || request.question}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2 md:flex-row">
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && path.trim() && !busy) authorize()
          }}
          placeholder={t('taskSteering.directoryPathPlaceholder')}
          className="h-9 min-w-0 flex-1 rounded-md border border-running/30 bg-paper px-3 font-mono text-xs text-ink outline-none focus:border-focus"
        />
        <select
          value={accessMode}
          onChange={(event) => setAccessMode(event.target.value)}
          disabled={!!busy}
          aria-label={t('taskSteering.directoryAccessMode')}
          className="h-9 rounded-md border border-running/30 bg-paper px-2 text-xs text-ink"
        >
          <option value="read_only">{t('taskSteering.directoryReadOnly')}</option>
          <option value="read_write">{t('taskSteering.directoryReadWrite')}</option>
        </select>
        <select
          value={authorizationScope}
          onChange={(event) => setAuthorizationScope(event.target.value)}
          disabled={!!busy}
          aria-label={t('localFiles.authorizationLifetime')}
          className="h-9 rounded-md border border-running/30 bg-paper px-2 text-xs text-ink"
        >
          <option value="session">{t('localFiles.authorizationSession')}</option>
          <option value="persistent">{t('localFiles.authorizationPersistent')}</option>
        </select>
        <button
          type="button"
          onClick={authorize}
          disabled={!!busy || !path.trim()}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-running/50 px-3 text-xs text-running disabled:opacity-40"
        >
          {busy === 'grant' && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
          {t('taskSteering.authorizeDirectory')}
        </button>
        <button
          type="button"
          onClick={() => setBrowserOpen((open) => !open)}
          disabled={!!busy}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-running px-3 text-xs text-paper disabled:opacity-40"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t('taskSteering.chooseDirectory')}
        </button>
      </div>
      {browserOpen && (
        <InlineDirectoryBrowser
          initialPath={path}
          onSelect={(selectedPath) => {
            setPath(selectedPath)
            setBrowserOpen(false)
          }}
          onCancel={() => setBrowserOpen(false)}
          t={t}
          browseDirectories={browseDirectories}
        />
      )}
      {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
      <p className="mt-2 text-xs text-ink-fade">{t('taskSteering.directorySecurityHint')}</p>
    </div>
  )
}
