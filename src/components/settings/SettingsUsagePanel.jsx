import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { getUsageReportApi } from '../../lib/usageClient.js'

// Presets are sent as local calendar dates; the server parses them in local time
// and refuses anything it cannot read as a real date.
const WINDOWS = Object.freeze([
  { key: '7', days: 7, labelKey: 'usage.window7' },
  { key: '30', days: 30, labelKey: 'usage.window30' },
  { key: 'all', days: 0, labelKey: 'usage.windowAll' },
])

function localDateDaysAgo(days) {
  const date = new Date(Date.now() - days * 86_400_000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric.toLocaleString() : '0'
}

function formatRate(value, t) {
  return value == null ? t('usage.cacheNotReported') : `${value}%`
}

function Stat({ label, value }) {
  return (
    <div className="min-w-0 rounded-xl border border-ink/10 bg-paper px-4 py-3">
      <p className="text-xs text-ink-fade">{label}</p>
      <p className="mt-1 truncate text-xl font-semibold leading-tight text-ink">{value}</p>
    </div>
  )
}

function UsageTable({ title, nameLabel, rows, t }) {
  if (!rows.length) return null
  return (
    <div className="min-w-0 rounded-xl border border-ink/10 bg-paper p-4" data-testid="settings-usage-table">
      <h2 className="text-base font-medium text-ink">{title}</h2>
      <div className="mt-3 min-w-0 overflow-x-auto">
        <table className="w-full min-w-0 border-collapse text-xs">
          <thead>
            <tr className="text-left text-ink-fade">
              <th className="py-1.5 pr-3 font-medium">{nameLabel}</th>
              <th className="whitespace-nowrap py-1.5 pr-3 text-right font-medium">{t('usage.entries')}</th>
              <th className="whitespace-nowrap py-1.5 pr-3 text-right font-medium">{t('usage.promptTokens')}</th>
              <th className="whitespace-nowrap py-1.5 pr-3 text-right font-medium">{t('usage.completionTokens')}</th>
              <th className="whitespace-nowrap py-1.5 text-right font-medium">{t('usage.cacheHitRate')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-ink/10 text-ink">
                <td className="max-w-[22rem] truncate py-1.5 pr-3 font-mono" title={row.key}>{row.key}</td>
                <td className="py-1.5 pr-3 text-right">{formatNumber(row.count)}</td>
                <td className="py-1.5 pr-3 text-right">{formatNumber(row.usage?.promptTokens)}</td>
                <td className="py-1.5 pr-3 text-right">{formatNumber(row.usage?.completionTokens)}</td>
                <td className="py-1.5 text-right">{formatRate(row.cacheHitRatePercent, t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function SettingsUsagePanel({ t }) {
  const [windowKey, setWindowKey] = useState('30')
  const [report, setReport] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (key) => {
    const preset = WINDOWS.find((entry) => entry.key === key) || WINDOWS[1]
    try {
      const next = await getUsageReportApi({ since: preset.days > 0 ? localDateDaysAgo(preset.days) : '' })
      setReport(next)
      setError('')
    } catch (failure) {
      setReport(null)
      setError(failure?.message || String(failure))
    }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount and window changes fetch; state updates happen after the request settles.
  useEffect(() => { void load(windowKey) }, [load, windowKey])

  // Only the button marks a refresh busy, so the mount path stays free of a
  // synchronous state update.
  const refresh = useCallback(async () => {
    setBusy(true)
    try { await load(windowKey) } finally { setBusy(false) }
  }, [load, windowKey])

  const totals = report?.totals || {}
  const modelRows = (report?.byModel || []).map((entry) => ({ ...entry, count: entry.modelPhases }))
  const sessionRows = (report?.bySession || []).map((entry) => ({ ...entry, count: entry.turns }))
  const phaseTotal = Number(report?.phaseTotals?.totalTokens) || 0
  const turnTotal = Number(totals.totalTokens) || 0
  const empty = report && report.turns?.total === 0 && report.perModelPhases === 0

  return (
    <section data-testid="settings-usage" className="min-w-0 max-w-full text-ink">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="font-mono text-xs tracking-[0.22em] text-ink-fade">USAGE</span>
          <h1 className="mt-1 text-[22px] font-semibold leading-tight text-ink">{t('usage.title')}</h1>
          <p className="mt-1 text-sm text-ink-soft">{t('usage.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          data-testid="settings-usage-refresh"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-ink/15 bg-paper px-3.5 text-xs text-ink transition-colors hover:bg-paper-2 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          {t('usage.refresh')}
        </button>
      </div>

      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2" role="group" aria-label={t('usage.window')}>
        {WINDOWS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            data-testid={`settings-usage-window-${entry.key}`}
            aria-pressed={windowKey === entry.key}
            onClick={() => setWindowKey(entry.key)}
            className={`h-8 rounded-lg border px-3 text-xs transition-colors ${windowKey === entry.key ? 'border-focus bg-paper-2 text-focus' : 'border-ink/15 bg-paper text-ink-soft hover:bg-paper-2'}`}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" data-testid="settings-usage-error" className="mt-4 text-sm text-danger">
          {t('usage.failed', { message: error })}
        </p>
      )}

      {!error && !report && <p className="mt-4 text-sm text-ink-fade">{t('usage.loading')}</p>}

      {!error && report && empty && <p data-testid="settings-usage-empty" className="mt-4 text-sm text-ink-soft">{t('usage.noData')}</p>}

      {!error && report && !empty && (
        <div className="mt-4 flex min-w-0 flex-col gap-4">
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={t('usage.turns')} value={formatNumber(report.turns?.total)} />
            <Stat label={t('usage.modelCalls')} value={formatNumber(report.perModelPhases)} />
            <Stat label={t('usage.totalTokens')} value={formatNumber(totals.totalTokens)} />
            <Stat label={t('usage.cacheHitRate')} value={formatRate(report.cacheHitRatePercent, t)} />
          </div>
          <p className="text-xs text-ink-fade" data-testid="settings-usage-summary">
            {t('usage.turnsDetail', {
              total: formatNumber(report.turns?.total),
              completed: formatNumber(report.turns?.completed),
              stopped: formatNumber(report.turns?.stopped),
            })}
            {' · '}
            {t('usage.tokenSplit', {
              prompt: formatNumber(totals.promptTokens),
              completion: formatNumber(totals.completionTokens),
            })}
          </p>
          <UsageTable title={t('usage.byModel')} nameLabel={t('usage.model')} rows={modelRows} t={t} />
          <UsageTable title={t('usage.bySession')} nameLabel={t('usage.session')} rows={sessionRows} t={t} />
          {report.window?.truncated && <p className="text-xs text-ink-fade">{t('usage.truncated')}</p>}
          {phaseTotal < turnTotal && <p className="text-xs text-ink-fade" data-testid="settings-usage-note">{t('usage.breakdownSmaller')}</p>}
          {phaseTotal > turnTotal && <p className="text-xs text-ink-fade" data-testid="settings-usage-note">{t('usage.breakdownLarger')}</p>}
        </div>
      )}
    </section>
  )
}
