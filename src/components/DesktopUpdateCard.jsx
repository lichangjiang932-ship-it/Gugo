import { useEffect, useState } from 'react'
import { Download, RefreshCw, RotateCw } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (!bytes) return '0 MB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function DesktopUpdateCard({ compact = false }) {
  const { t } = useT()
  const [update, setUpdate] = useState(() => (
    window.gugoDesktop?.isDesktop ? { status: 'manual' } : null
  ))

  useEffect(() => {
    const desktop = window.gugoDesktop
    if (!desktop?.isDesktop || typeof desktop.onUpdateStatus !== 'function') return undefined
    let resetTimer = null
    const unsubscribe = desktop.onUpdateStatus((next) => {
      setUpdate(next)
      if (resetTimer) window.clearTimeout(resetTimer)
      if (next?.status === 'current') {
        resetTimer = window.setTimeout(() => setUpdate({ status: 'manual' }), 2500)
      }
    })
    return () => {
      if (resetTimer) window.clearTimeout(resetTimer)
      unsubscribe?.()
    }
  }, [])

  if (!window.gugoDesktop?.isDesktop || !update) return null
  const requestUpdateCheck = async () => {
    const desktop = window.gugoDesktop
    if (typeof desktop?.checkForUpdates !== 'function') return
    setUpdate({ status: 'checking' })
    try {
      const result = await desktop.checkForUpdates()
      if (result?.supported === false) setUpdate(null)
    } catch (error) {
      setUpdate({ status: 'error', message: error?.message || 'update check failed' })
    }
  }
  const percent = Math.max(0, Math.min(100, Number(update.percent || 0)))
  const manual = update.status === 'manual'
  const downloading = update.status === 'downloading'
  const ready = update.status === 'ready'
  const installing = update.status === 'installing'
  const error = update.status === 'error'
  const passive = manual || update.status === 'checking' || update.status === 'current'
  const statusLabel = t(`desktopUpdate.${update.status}`)

  if (compact) {
    const icon = ready || installing
      ? <RotateCw className={`h-3.5 w-3.5 ${installing ? 'animate-spin' : ''}`} />
      : error || manual
        ? <RefreshCw className="h-3.5 w-3.5" />
        : <Download className="h-3.5 w-3.5" />
    const indicatorClass = passive
      ? 'bg-ink/5 text-ink-soft'
      : 'bg-accent/[0.12] text-accent-ink ring-1 ring-accent/20'
    const action = ready
      ? () => window.gugoDesktop.installUpdate()
      : error || manual
        ? requestUpdateCheck
        : null
    return <section className="mb-1 flex justify-center" aria-live="polite" aria-atomic="true" data-desktop-update-notice="compact">
      {action ? <button type="button" onClick={action} title={statusLabel} aria-label={statusLabel} className={`relative flex h-9 w-9 items-center justify-center rounded-lg ${indicatorClass}`}>
        {icon}<span aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />
      </button> : <span role="status" title={statusLabel} aria-label={statusLabel} className={`relative flex h-9 w-9 items-center justify-center rounded-lg ${indicatorClass}`}>
        {icon}{!passive && <span aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>}
    </section>
  }

  return (
    <section
      className={`mb-2 rounded-xl border p-3 shadow-sm ${passive ? 'border-ink/10 bg-paper-2' : 'border-accent/35 bg-accent/10 ring-1 ring-accent/10'}`}
      aria-live="polite"
      aria-atomic="true"
      data-desktop-update-notice="primary"
    >
      <div className="flex items-start gap-2.5">
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${passive ? 'bg-ink/5 text-ink-soft' : 'bg-accent text-accent-contrast shadow-sm'}`}>
          {ready || installing ? <RotateCw className={`h-3.5 w-3.5 ${installing ? 'animate-spin' : ''}`} /> : <Download className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className={`text-xs font-semibold ${passive ? 'text-ink' : 'text-accent-ink'}`}>{statusLabel}</div>
          {update.version && <div className="mt-0.5 text-[10px] font-medium text-ink-soft">Gugo v{update.version}</div>}
          {manual && <div className="mt-0.5 text-xs leading-4 text-ink-fade">{t('desktopUpdate.manualHint')}</div>}
        </div>
      </div>
      {downloading && (
        <div className="mt-2.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-ink/10">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-ink-fade">
            <span>{formatBytes(update.transferred)} / {formatBytes(update.total)}</span>
            <span>{percent.toFixed(1)}% · {formatBytes(update.bytesPerSecond)}/s</span>
          </div>
        </div>
      )}
      {ready && <button type="button" onClick={() => window.gugoDesktop.installUpdate()} className="mt-2.5 h-9 w-full rounded-lg bg-accent text-xs font-semibold text-accent-contrast shadow-sm transition-colors hover:bg-accent/90">{t('desktopUpdate.restartInstall')}</button>}
      {installing && <div className="mt-2 text-[10px] leading-4 text-ink-fade">{t('desktopUpdate.installingHint')}</div>}
      {(manual || error) && <button type="button" onClick={requestUpdateCheck} className={`mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border bg-paper text-xs font-medium ${error ? 'border-danger/30 text-danger hover:bg-danger/5' : 'border-ink/15 text-ink-soft hover:bg-paper-2'}`}><RefreshCw className="h-3 w-3" />{t(error ? 'desktopUpdate.retry' : 'desktopUpdate.checkNow')}</button>}
    </section>
  )
}
