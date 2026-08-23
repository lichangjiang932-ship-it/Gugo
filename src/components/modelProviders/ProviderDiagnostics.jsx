import { X } from 'lucide-react'

export default function ProviderDiagnostics({ diagnostics, onClose, t }) {
  if (!diagnostics) return null
  return <div className="border border-ink/15 rounded-md p-3 flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-ink">{t('modelProviders.diagnostics')}</span>
      {diagnostics.modelName && <span className="text-xs text-ink-fade">{t('modelProviders.testTarget', { model: diagnostics.modelName })}</span>}
      {diagnostics.running && <span className="text-xs text-ink-fade">{t('modelProviders.diagRunning')}</span>}
      <button type="button" onClick={onClose} className="ml-auto p-0.5 text-ink-fade hover:text-ink"><X className="w-3.5 h-3.5" /></button>
    </div>
    {(diagnostics.steps || []).map((step) => <div key={step.name} className="flex items-start gap-2 text-xs">
      <span className={step.ok ? 'text-emerald-700' : step.advisory ? 'text-amber-600' : 'text-rose-700'}>{step.ok ? '✓' : step.advisory ? '!' : '✕'}</span>
      <div className="flex-1 min-w-0">
        <div className="text-ink-soft">{step.label}{step.latency ? <span className="text-ink-fade"> · {step.latency} ms</span> : null}{!step.ok && step.advisory ? <span className="text-ink-fade"> · {t('modelProviders.diagAdvisory')}</span> : null}</div>
        {!step.ok && (step.error || step.hint) && <div className="text-ink-fade mt-0.5 break-words">{step.hint || step.error}</div>}
      </div>
    </div>)}
    {diagnostics.profile && <div className="text-xs text-ink-fade border-t border-ink/10 pt-2 flex flex-wrap gap-x-3 gap-y-1">
      <span>{diagnostics.profile.kind}</span><span>{t('modelProviders.contextWindow')}: {diagnostics.profile.contextWindow}</span>
      <span>{t('modelProviders.supportsTools')}: {diagnostics.profile.supportsTools ? t('modelProviders.capYes') : t('modelProviders.capNo')}</span>
      <span>{t('modelProviders.supportsPdf')}: {diagnostics.profile.supportsPdf ? t('modelProviders.capYes') : t('modelProviders.capNo')}</span>
      <span>{t('modelProviders.supportsParallelTools')}: {diagnostics.profile.supportsParallelTools ? t('modelProviders.capYes') : t('modelProviders.capNo')}</span>
      <span>{t('modelProviders.firstTokenTimeout')}: {diagnostics.profile.firstTokenTimeoutMs}</span>
      {diagnostics.profile.keepAlive && <span>{t('modelProviders.keepAlive')}: {diagnostics.profile.keepAlive}</span>}
    </div>}
    {diagnostics.error && !diagnostics.steps?.length && <div className="text-xs text-danger">{diagnostics.error}</div>}
  </div>
}
