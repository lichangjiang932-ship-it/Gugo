import { useEffect, useMemo, useState } from 'react'
import { ShieldAlert, Trash2 } from 'lucide-react'
import { fetchApprovalSettings, TOOL_RISK_CLASSES, updateApprovalSettings } from '../lib/approvalClient.js'
import { useT } from '../i18n/I18nProvider.jsx'

export default function RiskOverridesPanel() {
  const { t } = useT()
  const [overrides, setOverrides] = useState([])
  const [toolName, setToolName] = useState('')
  const [riskClass, setRiskClass] = useState('read')
  const [busyTool, setBusyTool] = useState('')
  const [error, setError] = useState('')
  const riskLabels = useMemo(() => ({
    read: t('permissionsDashboard.riskRead'),
    write_local: t('permissionsDashboard.riskWriteLocal'),
    exec: t('permissionsDashboard.riskExec'),
    external: t('permissionsDashboard.riskExternal'),
  }), [t])

  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => fetchApprovalSettings()).then((settings) => {
      if (alive) setOverrides(settings.riskOverrides || [])
    }).catch((loadError) => {
      if (alive) setError(loadError?.message || t('permissionsDashboard.riskLoadFailed'))
    })
    return () => { alive = false }
  }, [t])

  const saveOverride = async (name, nextRiskClass) => {
    const normalized = String(name || '').trim()
    if (!normalized) return
    setBusyTool(normalized)
    setError('')
    try {
      const settings = await updateApprovalSettings({
        riskOverride: { toolName: normalized, riskClass: nextRiskClass },
      })
      setOverrides(settings.riskOverrides || [])
      if (normalized === toolName.trim()) setToolName('')
    } catch (saveError) {
      setError(saveError?.message || t('permissionsDashboard.riskSaveFailed'))
    } finally {
      setBusyTool('')
    }
  }

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">RISK OVERRIDES</span>
        <span className="font-semibold text-base text-ink-soft">{t('permissionsDashboard.riskOverridesTitle')}</span>
      </div>
      <p className="mb-2 text-xs text-ink-fade">{t('permissionsDashboard.riskOverridesHint')}</p>
      {error && <div className="mb-2 rounded-md border border-dashed border-danger/45 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</div>}
      <div className="overflow-hidden rounded-md border border-ink/30">
        <form
          className="grid gap-2 border-b border-dashed border-ink-fade/40 bg-paper-2 p-3 sm:grid-cols-[1fr_180px_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            saveOverride(toolName, riskClass)
          }}
        >
          <input
            value={toolName}
            onChange={(event) => setToolName(event.target.value)}
            placeholder={t('permissionsDashboard.riskToolPlaceholder')}
            className="h-9 rounded-md border border-ink-fade/50 bg-paper px-3 font-mono text-xs text-ink outline-none focus:border-focus"
          />
          <select
            value={riskClass}
            onChange={(event) => setRiskClass(event.target.value)}
            className="h-9 rounded-md border border-ink-fade/50 bg-paper px-2 text-xs text-ink outline-none focus:border-focus"
          >
            {TOOL_RISK_CLASSES.map((value) => <option key={value} value={value}>{riskLabels[value]}</option>)}
          </select>
          <button
            type="submit"
            disabled={!toolName.trim() || !!busyTool}
            className="h-9 rounded-md bg-ink px-4 text-xs text-paper disabled:opacity-50"
          >
            {busyTool ? t('permissionsDashboard.riskSaving') : t('permissionsDashboard.riskAdd')}
          </button>
        </form>
        {overrides.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-5 text-sm text-ink-fade">
            <ShieldAlert className="h-4 w-4" />
            {t('permissionsDashboard.riskEmpty')}
          </div>
        ) : overrides.map((item, index) => (
          <div key={item.toolName} className={`grid items-center gap-3 px-4 py-3 sm:grid-cols-[1fr_180px_auto] ${index < overrides.length - 1 ? 'border-b border-dashed border-ink-fade/40' : ''}`}>
            <span className="truncate font-mono text-xs text-ink" title={item.toolName}>{item.toolName}</span>
            <select
              value={item.riskClass}
              disabled={busyTool === item.toolName}
              onChange={(event) => saveOverride(item.toolName, event.target.value)}
              className="h-8 rounded-md border border-ink-fade/50 bg-paper px-2 text-xs text-ink disabled:opacity-50"
            >
              {TOOL_RISK_CLASSES.map((value) => <option key={value} value={value}>{riskLabels[value]}</option>)}
            </select>
            <button
              type="button"
              disabled={busyTool === item.toolName}
              onClick={() => saveOverride(item.toolName, null)}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-ink-fade/50 px-2 text-xs text-ink-soft hover:text-accent-ink disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
              {t('permissionsDashboard.riskClear')}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
