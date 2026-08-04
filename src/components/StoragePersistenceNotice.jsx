import { AlertTriangle, Download, X } from 'lucide-react'
import { useAppContext } from '../store/AppContext.jsx'
import { wrapSessionsExport } from '../store/exportSchema.js'
import { useT } from '../i18n/I18nProvider.jsx'

function downloadSessions(sessions) {
  const blob = new Blob([JSON.stringify(wrapSessionsExport(sessions), null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `sessions-backup-${Date.now()}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function StoragePersistenceNotice() {
  const { state, dispatch } = useAppContext()
  const { t } = useT()
  const notice = state.persistenceNotice
  if (!notice) return null

  const messageKey = notice.level === 'compact-metadata'
    ? 'compacted'
    : (notice.level === 'quota' ? 'quota' : (notice.level === 'unavailable' ? 'unavailable' : 'error'))
  const title = t(`storageNotice.${messageKey}Title`)
  const body = t(`storageNotice.${messageKey}Body`)

  return (
    <div className="fixed left-1/2 top-4 z-[70] w-[min(680px,calc(100vw-2rem))] -translate-x-1/2 rounded-md border border-amber-500/50 bg-paper px-4 py-3 shadow-xl" role="alert">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-soft">{body}</p>
          <button
            type="button"
            onClick={() => downloadSessions(state.sessions)}
            className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-ink/30 px-3 text-xs text-ink hover:bg-paper-2"
          >
            <Download className="h-3.5 w-3.5" />
            {t('storageNotice.exportSessions')}
          </button>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: null })}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-fade hover:bg-ink/10 hover:text-ink"
          aria-label={t('storageNotice.dismiss')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
