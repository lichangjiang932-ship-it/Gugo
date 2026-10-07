import { RefreshCw } from 'lucide-react'

/**
 * Where the provider/model knowledge base currently comes from.
 *
 * Two layers exist on purpose: the snapshot shipped with this build works
 * offline, and a refresh replaces it with the live models.dev document. The
 * reader is told which one they are looking at, because a preset list read from
 * a months-old snapshot is a different promise from one read from upstream.
 *
 * A failed refresh is reported here and changes nothing else: the last
 * known-good list stays in place and every control remains usable.
 */
export default function ProviderKnowledgeBaseStatus({
  catalog = null, refreshing = false, error = '', refreshError = '', onRefresh, t,
}) {
  const available = catalog?.available !== false
  const source = catalog?.source || 'none'
  const sourceLabel = t(source === 'models.dev'
    ? 'modelProviders.catalogSourceModelsDev'
    : source === 'bundled' ? 'modelProviders.catalogSourceBundled' : 'modelProviders.catalogSourceNone')
  const generatedAt = String(catalog?.generatedAt || '').trim()
  const counts = catalog && Number.isFinite(Number(catalog.providers))
    ? t('modelProviders.catalogCounts', { providers: catalog.providers, models: catalog.models })
    : ''
  return <div data-testid="provider-knowledge-base-status" className="flex flex-col gap-2 rounded-xl border border-ink/15 bg-paper-2 p-3">
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-ink">{t('modelProviders.knowledgeBase')}</div>
        <div className="mt-0.5 text-xs text-ink-fade">{t('modelProviders.knowledgeBaseHint')}</div>
      </div>
      <button
        type="button"
        disabled={refreshing}
        onClick={onRefresh}
        aria-label={t('modelProviders.catalogRefresh')}
        title={t('modelProviders.catalogRefresh')}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-ink/20 bg-paper px-3 text-xs text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-40"
      ><RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />{refreshing ? t('modelProviders.catalogRefreshing') : t('modelProviders.catalogRefresh')}</button>
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-fade">
      <span data-catalog-source={source}>{t('modelProviders.catalogSource')}: <span className={available ? 'text-ink-soft' : 'text-danger'}>{sourceLabel}</span></span>
      {generatedAt && <span data-catalog-generated-at>{t('modelProviders.catalogGeneratedAt', { date: generatedAt })}</span>}
      {counts && <span data-catalog-counts>{counts}</span>}
    </div>
    {!available && <div role="alert" className="text-xs text-danger">{t('modelProviders.catalogUnavailable')}</div>}
    {refreshError && <div role="alert" data-catalog-refresh-error className="text-xs text-danger">{t('modelProviders.catalogRefreshFailed', { error: refreshError })}</div>}
    {!refreshError && error && <div role="alert" data-catalog-error className="text-xs text-danger">{error}</div>}
  </div>
}
