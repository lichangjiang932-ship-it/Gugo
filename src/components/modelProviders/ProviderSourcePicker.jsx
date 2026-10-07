import { useState } from 'react'
import { Cloud, Server } from 'lucide-react'

import ProviderKnowledgeBaseStatus from './ProviderKnowledgeBaseStatus.jsx'
import { catalogIdForPreset } from '../../../shared/modelCatalogSnapshot.js'
import { CLOUD_PRESETS, LOCAL_PRESETS } from './providerConfig.js'

/**
 * Choosing where a model comes from.
 *
 * Two sources, mirroring the two things a reader can actually have:
 *
 * - The model knowledge base, which knows every provider this app can name and
 *   what each one currently serves. This is the normal path: pick the provider,
 *   paste a key, save. It exists because a hand-maintained preset grid can only
 *   ever list the providers someone remembered to type in — `amazon-bedrock`,
 *   `cerebras` and friends were previously not configurable at all.
 * - A custom endpoint, for a relay, a self-hosted server, or anything the
 *   knowledge base does not know.
 *
 * The known providers stay reachable from the knowledge-base tab rather than
 * disappearing: they are what most readers want, so they are listed first by
 * name instead of being hidden behind a search box.
 */
export default function ProviderSourcePicker({
  editing, catalog = null, catalogProviders = [], catalogError = '', catalogLoading = false,
  refreshingCatalog = false, catalogRefreshError = '', catalogMessage = '',
  onRefreshCatalog, onChooseCatalogProvider, onApplyPreset, onUseCustomPath, t,
}) {
  const [tab, setTab] = useState('catalog')
  const [query, setQuery] = useState('')

  const needle = query.trim().toLowerCase()
  const typedId = query.trim().toLowerCase()
  const byId = new Map(catalogProviders.map((provider) => [String(provider.id || '').toLowerCase(), provider]))
  const matches = needle
    ? catalogProviders.filter((provider) => (
      String(provider.id).toLowerCase().includes(needle)
      || String(provider.name || '').toLowerCase().includes(needle)
    ))
    : []
  /**
   * What the tab lists before anyone searches.
   *
   * Built from this app's own presets rather than from the catalogue index, so the
   * names a reader already knows (`Google Gemini`, `阿里云通义千问`) are what they
   * see, and the model count is only shown once the catalogue has confirmed the
   * provider. The catalogue id travels alongside because that is what the
   * knowledge-base lookup is keyed by — for four providers the two ids differ.
   */
  const known = CLOUD_PRESETS.map((preset) => {
    const catalogId = catalogIdForPreset(preset.id)
    const entry = byId.get(catalogId)
    return {
      id: catalogId,
      preset,
      name: preset.labelKey ? t(`modelProviders.${preset.labelKey}`) : preset.label,
      modelCount: entry?.modelCount,
    }
  })
  const typedPreset = CLOUD_PRESETS.find((preset) => preset.id === typedId || catalogIdForPreset(preset.id) === typedId)

  const tabClass = (active) => `h-8 rounded-md px-3 text-xs ${active ? 'bg-paper text-ink shadow-sm' : 'text-ink-soft hover:text-ink'}`

  return <div className="flex flex-col gap-3">
    <div className="flex items-center gap-2 text-xs font-medium text-ink">
      <Cloud className="h-4 w-4 text-accent-ink" />{t('modelProviders.chooseProvider')}
    </div>
    <div data-testid="provider-source-tabs" role="tablist" className="flex w-fit items-center gap-1 rounded-lg bg-paper-2 p-1">
      <button type="button" role="tab" aria-selected={tab === 'catalog'} className={tabClass(tab === 'catalog')} onClick={() => setTab('catalog')}>{t('modelProviders.sourceTabCatalog')}</button>
      <button type="button" role="tab" aria-selected={tab === 'custom'} className={tabClass(tab === 'custom')} onClick={() => setTab('custom')}>{t('modelProviders.sourceTabCustom')}</button>
    </div>

    {tab === 'catalog' && <div data-testid="provider-catalog-tab" className="flex flex-col gap-3">
      <div className="text-xs text-ink-fade">{t('modelProviders.sourceTabCatalogHint')}</div>
      <ProviderKnowledgeBaseStatus
        catalog={catalog}
        refreshing={refreshingCatalog}
        error={catalogError}
        refreshError={catalogRefreshError}
        onRefresh={onRefreshCatalog}
        t={t}
      />
      <div className="flex flex-col gap-2 rounded-xl border border-ink/15 p-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onInput={(event) => setQuery(event.currentTarget.value)}
          aria-label={t('modelProviders.catalogSearchProvider')}
          placeholder={t('modelProviders.catalogSearchProviderPlaceholder')}
          className="h-8 w-full rounded-md border border-ink/15 bg-paper-2 px-2 text-xs"
        />
        {matches.length > 0 && <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
          {matches.map((provider) => <button
            key={provider.id}
            type="button"
            onClick={() => onChooseCatalogProvider(provider)}
            className="min-h-14 rounded-lg border border-ink/15 bg-paper px-3 py-2 text-left text-xs flex flex-col gap-1 hover:border-ink/40"
          >
            <span className="truncate font-medium text-ink">{provider.name || provider.id}</span>
            <span className="truncate text-xs text-ink-fade">{provider.id}{typeof provider.modelCount === 'number' ? ` · ${t('modelProviders.catalogProviderModelCount', { count: provider.modelCount })}` : ''}</span>
          </button>)}
        </div>}
        {/* An id the reader already knows can be used even before the catalogue has
            been searched: the lookup resolves it, and the custom path catches the
            ones the catalogue does not describe at all. */}
        {typedId && <button
          type="button"
          onClick={() => (typedPreset ? onApplyPreset(typedPreset) : onChooseCatalogProvider({ id: typedId }))}
          className="self-start rounded-md border border-ink/20 bg-paper px-3 py-1.5 text-left text-xs text-ink-soft hover:border-ink/40 hover:text-ink"
        >{t('modelProviders.catalogUseProviderId', { id: typedId })}</button>}
        {needle && matches.length === 0 && <div role="status" className="text-xs text-ink-fade">{t('modelProviders.catalogNoMatch', { query: query.trim() })}</div>}
        {!needle && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {known.map((provider) => <button
            key={provider.id}
            type="button"
            onClick={() => onApplyPreset(provider.preset)}
            className={`min-h-14 rounded-lg border px-3 py-2 text-left text-xs flex flex-col gap-1 ${editing.presetId === provider.preset.id ? 'border-accent bg-accent-soft/30 text-ink' : 'border-ink/15 bg-paper hover:border-ink/40 text-ink'}`}
          >
            <span className="truncate font-medium">{provider.name}</span>
            <span className="text-[10px] text-ink-fade">{typeof provider.modelCount === 'number' ? t('modelProviders.catalogProviderModelCount', { count: provider.modelCount }) : provider.id}</span>
          </button>)}
        </div>}
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-ink-soft">{t('modelProviders.localPreset')}</div>
        <div className="flex flex-wrap gap-2">
          {LOCAL_PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => onApplyPreset(preset)} className={`h-8 rounded-md border px-3 text-xs ${editing.presetId === preset.id ? 'border-accent bg-accent-soft/30 text-ink' : 'border-ink-fade/50 bg-paper text-ink hover:border-ink'}`}>{preset.label}</button>)}
          {/* The custom path is an escape hatch, not a third source: it stays one
              click away from whichever tab the reader is on. */}
          <button type="button" onClick={onUseCustomPath} className={`h-8 rounded-md border px-3 text-xs ${editing.presetId === 'custom' ? 'border-accent bg-accent-soft/30 text-ink' : 'border-ink-fade/50 bg-paper text-ink hover:border-ink'}`}>{t('modelProviders.custom')}</button>
        </div>
      </div>
      <div className="text-xs text-ink-fade">{t('modelProviders.catalogKnownHint')}</div>
      <button type="button" onClick={() => setTab('custom')} className="flex items-center gap-1.5 self-start text-xs text-ink-soft hover:text-ink">
        <Server className="h-3.5 w-3.5" />{t('modelProviders.customApiHint')}
      </button>
      {catalogMessage && <div role="status" className="text-xs text-ink-soft">{catalogMessage}</div>}
      {catalogLoading && <div role="status" className="text-xs text-ink-fade">{t('modelProviders.detecting')}</div>}
    </div>}

    {tab === 'custom' && <div data-testid="provider-custom-tab" className="flex flex-col gap-3">
      <div className="text-xs text-ink-fade">{t('modelProviders.customTabHint')}</div>
      <button type="button" onClick={onUseCustomPath} className={`flex min-h-14 flex-col gap-1 self-start rounded-lg border px-3 py-2 text-left text-xs ${editing.presetId === 'custom' ? 'border-accent bg-accent-soft/30 text-ink' : 'border-ink/15 bg-paper hover:border-ink/40 text-ink'}`}>
        <span className="font-medium">{t('modelProviders.custom')}</span>
        <span className="text-[10px] text-ink-fade">{t('modelProviders.customTabHint')}</span>
      </button>
      <button type="button" onClick={() => setTab('catalog')} className="flex items-center gap-1.5 self-start text-xs text-ink-soft hover:text-ink">
        <Server className="h-3.5 w-3.5" />{t('modelProviders.backToCatalog')}
      </button>
    </div>}
  </div>
}
