import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { saveLlmCredential, saveLlmProvider } from '../../lib/llmConfigClient.js'

const INPUT = 'h-9 w-full rounded-control border border-ink/15 bg-paper px-2.5 text-sm text-ink outline-none focus:border-focus'
const LABEL = 'text-xs font-medium text-ink'
const TAB = 'rounded-control px-3 py-1.5 text-sm transition-colors'
const PRIMARY = 'h-9 rounded-control bg-ink px-4 text-sm text-paper disabled:opacity-40'
const SECONDARY = 'h-9 rounded-control border border-ink/15 bg-paper px-4 text-sm text-ink'

function Field({ children, hint, label }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-fade">{hint}</span>}
    </label>
  )
}

/**
 * One panel, two honest shapes: a provider from the built-in catalogue (its
 * endpoint and protocol are known; only the key and the model list are asked),
 * or a hand-declared gateway (id, address, protocol, key). Both end in the same
 * settings.yaml entry.
 */
export default function AddProviderPanel({ catalog, editing, initialCatalogEntryId = '', onCancel, onSaved, t }) {
  const [tab, setTab] = useState(editing?.custom ? 'custom' : 'catalog')
  const [customOpen, setCustomOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [catalogId, setCatalogId] = useState(editing?.id || initialCatalogEntryId || 'openai')
  const [form, setForm] = useState(() => ({
    apiKey: '',
    baseURL: editing?.baseURL || '',
    id: editing?.id || '',
    displayName: editing?.displayName || '',
    api: editing?.api || 'openai-completions',
  }))
  const patch = (values) => setForm((current) => ({ ...current, ...values }))

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const provider = tab === 'custom'
        ? { id: form.id.trim().toLowerCase(), displayName: form.displayName.trim() || form.id.trim(), api: form.api, baseURL: form.baseURL.trim(), custom: true }
        : { id: catalogId, ...(customOpen && form.baseURL.trim() ? { baseURL: form.baseURL.trim() } : {}) }
      if (!provider.id) throw new Error(t('settingsModels.providerIdRequired'))
      if (form.apiKey.trim()) await saveLlmCredential(provider.id, form.apiKey.trim())
      await saveLlmProvider(provider)
      await onSaved?.()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-3" data-testid="add-provider-panel" onSubmit={submit}>
      <div className="inline-flex w-fit gap-1 rounded-control bg-paper p-1" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'catalog'} data-testid="tab-catalog"
          className={`${TAB} ${tab === 'catalog' ? 'bg-ink/[0.07] font-medium text-ink' : 'text-ink-fade hover:text-ink'}`}
          onClick={() => setTab('catalog')}>{t('settingsModels.tabCatalog')}</button>
        <button type="button" role="tab" aria-selected={tab === 'custom'} data-testid="tab-custom"
          className={`${TAB} ${tab === 'custom' ? 'bg-ink/[0.07] font-medium text-ink' : 'text-ink-fade hover:text-ink'}`}
          onClick={() => setTab('custom')}>{t('settingsModels.tabCustom')}</button>
      </div>

      {tab === 'catalog' ? (
        <>
          <p className="text-xs text-ink-fade">{t('settingsModels.catalogHint')}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="catalog-grid">
            {(catalog?.cloud || []).map((entry) => (
              <button key={entry.id} type="button" data-testid="catalog-entry" data-provider={entry.id}
                aria-pressed={catalogId === entry.id}
                onClick={() => setCatalogId(entry.id)}
                className={`flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors ${
                  catalogId === entry.id ? 'border-accent bg-accent/8' : 'border-ink/12 bg-surface hover:border-ink/30'}`}>
                <span className="text-sm font-medium text-ink">{entry.displayName}</span>
                <span className="text-xs text-ink-fade">{t('settingsModels.modelCount', { count: entry.models.length })}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5" data-testid="local-presets">
            {(catalog?.local || []).map((entry) => (
              <button key={entry.id} type="button" data-testid="catalog-local" data-provider={entry.id}
                aria-pressed={catalogId === entry.id} onClick={() => setCatalogId(entry.id)}
                className={`rounded-control border px-2.5 py-1 text-xs ${
                  catalogId === entry.id ? 'border-accent text-accent-ink' : 'border-ink/15 text-ink-soft hover:text-ink'}`}>
                {entry.displayName}
              </button>
            ))}
          </div>
          <Field label={t('settingsModels.apiKey')}>
            <input className={INPUT} data-testid="provider-api-key" type="password" autoComplete="off"
              value={form.apiKey} onChange={(event) => patch({ apiKey: event.target.value })}
              placeholder={t('settingsModels.apiKeyPlaceholder')} />
          </Field>
          <button type="button" className="inline-flex w-fit items-center gap-1 text-xs text-ink-soft hover:text-ink"
            data-testid="toggle-custom-settings" onClick={() => setCustomOpen((open) => !open)}>
            {customOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {t('settingsModels.customSettings')}
          </button>
          {customOpen && (
            <Field label={t('settingsModels.baseURL')} hint={t('settingsModels.baseURLHint')}>
              <input className={INPUT} data-testid="provider-base-url" value={form.baseURL}
                onChange={(event) => patch({ baseURL: event.target.value })} placeholder={t('settingsModels.providerDefault')} />
            </Field>
          )}
        </>
      ) : (
        <>
          <p className="text-xs text-ink-fade">{t('settingsModels.customHint')}</p>
          <Field label="Provider ID" hint={t('settingsModels.providerIdHint')}>
            <input className={INPUT} data-testid="custom-provider-id" value={form.id} placeholder="acme-gateway"
              onChange={(event) => patch({ id: event.target.value })} />
          </Field>
          <Field label={t('settingsModels.displayName')}>
            <input className={INPUT} data-testid="custom-display-name" value={form.displayName}
              onChange={(event) => patch({ displayName: event.target.value })} placeholder={t('settingsModels.displayName')} />
          </Field>
          <Field label={t('settingsModels.baseURL')}>
            <input className={INPUT} data-testid="custom-base-url" value={form.baseURL} placeholder="https://gateway.example/v1"
              onChange={(event) => patch({ baseURL: event.target.value })} />
          </Field>
          <Field label={t('settingsModels.protocol')}>
            <select className={INPUT} data-testid="custom-protocol" value={form.api} onChange={(event) => patch({ api: event.target.value })}>
              {(catalog?.protocols || []).map((protocol) => <option key={protocol.id} value={protocol.id}>{protocol.label}</option>)}
            </select>
          </Field>
          <Field label={t('settingsModels.apiKey')}>
            <input className={INPUT} data-testid="custom-api-key" type="password" autoComplete="off" value={form.apiKey}
              onChange={(event) => patch({ apiKey: event.target.value })} placeholder={t('settingsModels.apiKeyPlaceholderCustom')} />
          </Field>
        </>
      )}

      {error && <p role="alert" className="text-xs text-danger" data-testid="add-provider-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={SECONDARY} data-testid="add-provider-cancel" onClick={onCancel}>{t('settingsModels.cancel')}</button>
        <button type="submit" className={PRIMARY} data-testid="add-provider-save" disabled={busy}>
          {t(editing ? 'settingsModels.save' : tab === 'custom' ? 'settingsModels.create' : 'settingsModels.save')}
        </button>
      </div>
    </form>
  )
}
