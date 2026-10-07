import { useCallback, useEffect, useState } from 'react'
import { Check, FileCog, Plus, Trash2 } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import { importLegacyLlmProviders, listLlmCatalog, listLlmProviders, openLlmConfigFile, refreshLlmModelsDev, removeLlmProvider, setLlmDefaultModel } from '../../lib/llmConfigClient.js'
import AddProviderPanel from './AddProviderPanel.jsx'
import ProviderModelDirectory from './ProviderModelDirectory.jsx'

const CARD = 'flex items-center gap-3 rounded-xl border border-ink/12 bg-surface px-4 py-3'
const BUTTON = 'h-8 rounded-control border border-ink/15 bg-paper px-3 text-xs text-ink transition-colors hover:bg-paper-2'
const DASHED = 'flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-ink/25 px-4 py-3 text-sm text-ink-soft transition-colors hover:border-ink/40 hover:text-ink'

function ProviderCard({ defaultModel, expanded, onChangeDefault, onDelete, onExpand, onSaved, provider, t }) {
  return (
    <li className="flex flex-col gap-2">
      <div className={CARD}>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{provider.displayName}</span>
        {provider.custom && (
          <span className="shrink-0 rounded border border-ink/15 px-1.5 py-0.5 text-xs text-ink-fade" data-testid="provider-custom-badge">
            {t('settingsModels.customBadge')}
          </span>
        )}
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${provider.credential?.configured ? 'bg-success' : 'bg-skel-2'}`}
          data-testid="provider-configured-dot"
          aria-label={t(provider.credential?.configured ? 'settingsModels.configured' : 'settingsModels.notConfigured')}
        />
        <button type="button" className={BUTTON} data-testid="provider-edit" onClick={() => onExpand(provider)}>
          {t('settingsModels.edit')}
        </button>
        <button type="button" className={`${BUTTON} text-danger`} data-testid="provider-delete" onClick={() => onDelete(provider)}>
          <Trash2 className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
          {t('settingsModels.remove')}
        </button>
      </div>
      {expanded && (
        <div className="rounded-xl bg-paper-2/60 p-3">
          <AddProviderPanel editing={provider} initialCatalogEntryId={provider.id} onCancel={() => onExpand(provider)} onSaved={onSaved} t={t} />
          <ProviderModelDirectory defaultModel={defaultModel} onChangeDefault={onChangeDefault} onChanged={onSaved} provider={provider} t={t} />
        </div>
      )}
    </li>
  )
}

export default function ModelConfigPanel({ onReady }) {
  const { t } = useT()
  const [state, setState] = useState({ status: 'loading', providers: [], defaultModel: { provider: '', model: '' } })
  const [catalog, setCatalog] = useState(null)
  const [adding, setAdding] = useState(false)
  const [expandedId, setExpandedId] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const reload = useCallback(async () => {
    // One microtask of separation: the effect below must not set state in its
    // own body (react-hooks/set-state-in-effect), so the load defers first.
    await Promise.resolve()
    try {
      const [providers, catalogPayload] = await Promise.all([listLlmProviders(), listLlmCatalog()])
      setState({ status: 'ready', providers: providers.providers || [], defaultModel: providers.defaultModel || { provider: '', model: '' } })
      setCatalog(catalogPayload.catalog || null)
      setError('')
    } catch (failure) {
      setState((current) => ({ ...current, status: 'ready' }))
      setError(failure.message)
    }
  }, [])

  useEffect(() => {
    // Deferred out of the effect body: the load sets state when it lands, and
    // an effect must not set state synchronously (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => { void reload() }, 0)
    return () => clearTimeout(timer)
  }, [reload])

  const afterChange = async () => {
    setAdding(false)
    setExpandedId('')
    await reload()
    onReady?.()
  }
  const handleDelete = async (provider) => {
    if (!globalThis.confirm?.(t('settingsModels.confirmRemove', { name: provider.displayName }))) return
    try {
      await removeLlmProvider(provider.id)
      await reload()
    } catch (failure) {
      setError(failure.message)
    }
  }
  const handleDefault = async (providerId, modelId) => {
    try {
      await setLlmDefaultModel({ provider: providerId, model: modelId })
      await reload()
    } catch (failure) {
      setError(failure.message)
    }
  }

  const openConfig = async () => {
    try {
      const result = await openLlmConfigFile('settings')
      if (result.ok) {
        setNote(t('settingsModels.configOpened'))
        return
      }
      // No desktop opener (web build): the path is still useful, so hand it over.
      if (catalog?.settingsPath) await globalThis.navigator?.clipboard?.writeText?.(catalog.settingsPath)
      setNote(t('settingsModels.configPathCopied'))
    } catch (failure) {
      setError(failure.message)
    }
  }
  const refreshMetadata = async () => {
    try {
      const result = await refreshLlmModelsDev()
      setNote(result.ok
        ? t('settingsModels.modelsDevRefreshed', { count: result.count })
        : t('settingsModels.modelsDevFailed'))
      await reload()
    } catch (failure) {
      setError(failure.message)
    }
  }

  return (
    <section data-testid="model-config-panel" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{t('settingsModels.title')}</h2>
          <p className="mt-0.5 text-xs text-ink-fade">{t('settingsModels.description')}</p>
        </div>
        <button
          type="button"
          className={BUTTON}
          data-testid="import-legacy-providers"
          onClick={async () => {
            try {
              const result = await importLegacyLlmProviders()
              setError('')
              setNote(t('settingsModels.importLegacyDone', { imported: result.imported, skipped: result.skipped }))
              await reload()
            } catch (failure) {
              setError(failure.message)
            }
          }}
        >
          {t('settingsModels.importLegacy')}
        </button>
        <button
          type="button"
          className={BUTTON}
          data-testid="open-config-file"
          title={catalog?.settingsPath || ''}
          onClick={openConfig}
        >
          <FileCog className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
          {t('settingsModels.openConfigFile')}
        </button>
      </div>

      {error && <p role="alert" className="rounded-control bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      {note && <p role="status" className="text-xs text-ink-fade" data-testid="model-config-note">{note}</p>}
      {catalog?.modelsDev && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-fade" data-testid="models-dev-status">
          <span>
            {t('settingsModels.modelsDevStatus', { count: catalog.modelsDev.count, hours: catalog.modelsDev.cacheTtlHours })}
          </span>
          <button type="button" className="text-accent hover:underline" data-testid="refresh-models-dev" onClick={refreshMetadata}>
            {t('settingsModels.modelsDevRefresh')}
          </button>
        </p>
      )}

      <ul className="flex flex-col gap-2" data-testid="provider-list">
        {state.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            defaultModel={state.defaultModel}
            expanded={expandedId === provider.id}
            onChangeDefault={handleDefault}
            onDelete={handleDelete}
            onExpand={(entry) => setExpandedId((current) => (current === entry.id ? '' : entry.id))}
            onSaved={afterChange}
            provider={provider}
            t={t}
          />
        ))}
      </ul>

      {state.status === 'ready' && state.providers.length === 0 && (
        <p className="px-1 text-xs text-ink-fade" data-testid="provider-list-empty">{t('settingsModels.empty')}</p>
      )}

      {!adding && (
        <button type="button" className={DASHED} data-testid="add-provider" onClick={() => { setExpandedId(''); setAdding(true) }}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('settingsModels.addProvider')}
        </button>
      )}
      {adding && (
        <div className="rounded-xl bg-paper-2/60 p-3">
          <AddProviderPanel catalog={catalog} onCancel={() => setAdding(false)} onSaved={afterChange} t={t} />
        </div>
      )}

      {state.defaultModel.provider && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-ink-fade" data-testid="default-model">
          <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          {t('settingsModels.defaultModel', { provider: state.defaultModel.provider, model: state.defaultModel.model })}
        </p>
      )}

    </section>
  )
}
