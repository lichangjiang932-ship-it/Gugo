import { useEffect, useState } from 'react'
import { Download, RefreshCw, RotateCw } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (!bytes) return '0 MB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function DesktopUpdateCard() {
  const { t } = useT()
  const [update, setUpdate] = useState(null)

  useEffect(() => {
    const desktop = window.gugoDesktop
    if (!desktop?.isDesktop || typeof desktop.onUpdateStatus !== 'function') return undefined
    return desktop.onUpdateStatus((next) => {
      setUpdate(next)
      if (next?.status === 'current') window.setTimeout(() => setUpdate(null), 2500)
    })
  }, [])

  if (!window.gugoDesktop?.isDesktop || !update) return null
  const percent = Math.max(0, Math.min(100, Number(update.percent || 0)))
  const downloading = update.status === 'downloading'
  const ready = update.status === 'ready'
  const installing = update.status === 'installing'
  const error = update.status === 'error'

  return (
    <section className="mb-2 rounded-xl border border-ink/10 bg-paper-2/80 p-3 shadow-sm" aria-live="polite">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ember/10 text-ember">
          {ready || installing ? <RotateCw className={`h-3.5 w-3.5 ${installing ? 'animate-spin' : ''}`} /> : <Download className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-ink">{t(`desktopUpdate.${update.status}`)}</div>
          {update.version && <div className="mt-0.5 text-[10px] text-ink-fade">v{update.version}</div>}
        </div>
      </div>
      {downloading && (
        <div className="mt-2.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-ink/10">
            <div className="h-full rounded-full bg-ember transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-ink-fade">
            <span>{formatBytes(update.transferred)} / {formatBytes(update.total)}</span>
            <span>{percent.toFixed(1)}% · {formatBytes(update.bytesPerSecond)}/s</span>
          </div>
        </div>
      )}
      {ready && <button type="button" onClick={() => window.gugoDesktop.installUpdate()} className="mt-2.5 h-8 w-full rounded-lg bg-ink text-xs text-paper hover:bg-ink-soft">{t('desktopUpdate.restartInstall')}</button>}
      {installing && <div className="mt-2 text-[10px] leading-4 text-ink-fade">{t('desktopUpdate.installingHint')}</div>}
      {error && <button type="button" onClick={() => window.gugoDesktop.checkForUpdates()} className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-ink/15 text-xs text-ink-soft hover:bg-paper"><RefreshCw className="h-3 w-3" />{t('desktopUpdate.retry')}</button>}
    </section>
  )
}
