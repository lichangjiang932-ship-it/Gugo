import { CheckCircle2, Pencil, RefreshCw, Trash2 } from 'lucide-react'

function readinessBadge(provider, t) {
  const mode = provider?.readiness?.mode
  if (mode === 'agent') return { label: t('modelProviders.readinessAgent'), className: 'bg-success/5 text-success' }
  if (mode === 'chat_only') return { label: t('modelProviders.readinessChatOnly'), className: 'bg-warning/5 text-warning' }
  if (mode === 'unavailable') return { label: t('modelProviders.readinessUnavailable'), className: 'bg-danger/5 text-danger' }
  return { label: t('modelProviders.readinessUntested'), className: 'bg-paper-2 text-ink-fade' }
}

function ProviderRow({ provider, busy, onTest, onEdit, onRemove, t }) {
  const models = Array.isArray(provider.models) ? provider.models : []
  const testModel = models.includes(provider.defaultModel) ? provider.defaultModel : (models[0] || '')
  const selectedReadiness = provider.modelReadiness?.[testModel] || provider.readiness || null
  const readiness = readinessBadge({ readiness: selectedReadiness }, t)
  return <div className="border border-ink/15 rounded-md p-3 flex items-center gap-3">
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 text-sm text-ink">
        <span className="font-medium">{provider.label}</span><code className="text-[10px] text-ink-fade">{provider.key}</code>
        {provider.isDefault && <span className="text-[10px] text-success flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{t('modelProviders.default')}</span>}
        <span className={`rounded-full px-2 py-0.5 text-xs ${readiness.className}`}>{readiness.label}</span>
      </div>
      <div className="text-xs text-ink-fade truncate mt-1">{testModel || t('modelProviders.notConfigured')}{models.length > 1 ? ` · ${t('modelProviders.modelsCount', { count: models.length })}` : ''}</div>
    </div>
    {selectedReadiness?.mode !== 'agent' && <button type="button" aria-label={t('modelProviders.test')} title={t('modelProviders.test')} disabled={busy || !testModel} onClick={() => onTest(provider, testModel)} className="rounded-md p-1.5 text-ink-fade hover:bg-ink/[0.04] hover:text-ink disabled:opacity-40"><RefreshCw className="w-3.5 h-3.5" /></button>}
    <button type="button" aria-label={t('modelProviders.edit')} title={t('modelProviders.edit')} onClick={() => onEdit(provider)} className="p-1 text-ink-fade hover:text-ink"><Pencil className="w-3.5 h-3.5" /></button>
    <button type="button" aria-label={t('modelProviders.delete')} title={t('modelProviders.delete')} onClick={() => onRemove(provider)} className="p-1 text-danger"><Trash2 className="w-3.5 h-3.5" /></button>
  </div>
}

export default function ProviderList({ providers, busy, onTest, onEdit, onRemove, t }) {
  if (!providers.length) return <div className="text-xs text-ink-fade py-3 text-center">{t('modelProviders.empty')}</div>
  return providers.map((provider) => <ProviderRow key={provider.id} provider={provider} busy={busy} onTest={onTest} onEdit={onEdit} onRemove={onRemove} t={t} />)
}
