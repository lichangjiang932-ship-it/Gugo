import { CheckCircle2, Pencil, Trash2 } from 'lucide-react'

export default function ProviderList({ providers, busy, onTest, onEdit, onRemove, t }) {
  if (!providers.length) return <div className="text-xs text-ink-fade py-3 text-center">{t('modelProviders.empty')}</div>
  return providers.map((provider) => <div key={provider.id} className="border border-ink/15 rounded-md p-3 flex items-center gap-3">
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 text-sm text-ink">
        <span className="font-medium">{provider.label}</span><code className="text-[10px] text-ink-fade">{provider.key}</code>
        {provider.isDefault && <span className="text-[10px] text-emerald-700 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{t('modelProviders.default')}</span>}
      </div>
      <div className="text-xs text-ink-fade truncate mt-1">{provider.baseUrl} · {(provider.models || []).join(', ')}</div>
    </div>
    <button type="button" disabled={busy} onClick={() => onTest(provider)} className="text-xs text-accent-ink hover:underline">{t('modelProviders.test')}</button>
    <button type="button" onClick={() => onEdit(provider)} className="p-1 text-ink-fade hover:text-ink"><Pencil className="w-3.5 h-3.5" /></button>
    <button type="button" onClick={() => onRemove(provider)} className="p-1 text-rose-700"><Trash2 className="w-3.5 h-3.5" /></button>
  </div>)
}
