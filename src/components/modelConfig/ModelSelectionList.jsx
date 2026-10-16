import { Check } from 'lucide-react'

/** Selection is not deletion: unchecked candidates remain available to re-select. */
export default function ModelSelectionList({ models, onChange, busy = false, t, renderActions }) {
  const selected = models.filter(model => model.enabled !== false).length
  const changeAll = enabled => onChange(models.map(model => ({ ...model, enabled })))
  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" data-testid="models-select-all" disabled={busy || selected === models.length} onClick={() => changeAll(true)} className="h-8 rounded-control border border-ink/15 px-2 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-40">{t('settingsModels.selectAll')}</button>
      <button type="button" data-testid="models-select-none" disabled={busy || selected === 0} onClick={() => changeAll(false)} className="h-8 rounded-control border border-ink/15 px-2 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-40">{t('settingsModels.selectNone')}</button>
      <span className="text-xs text-ink-fade" role="status">{t('settingsModels.selectedCount', { selected, total: models.length })}</span>
    </div>
    <p className="text-xs text-ink-fade">{t('settingsModels.modelSelectionHint')}</p>
    <ul className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
      {models.map(model => {
        const enabled = model.enabled !== false
        return <li key={model.id} className="flex max-w-full items-center gap-1">
          <button type="button" data-testid="model-choice" data-model={model.id} aria-pressed={enabled} disabled={busy} title={model.id}
            onClick={() => onChange(models.map(entry => entry.id === model.id ? { ...entry, enabled: !enabled } : entry))}
            className={`inline-flex min-h-8 max-w-full items-center gap-1 rounded-pill border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${enabled ? 'border-accent/35 bg-accent-soft/30 text-accent-ink' : 'border-ink/15 bg-paper text-ink-fade hover:bg-paper-2'}`}>
            {enabled && <Check className="h-3 w-3 shrink-0" aria-hidden="true" />}<span className="truncate">{model.id}</span>
          </button>
          {renderActions?.(model, enabled)}
        </li>
      })}
    </ul>
  </div>
}
