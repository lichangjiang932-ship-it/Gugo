import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { probeLlmDraft, saveLlmCredential, saveLlmProvider } from '../../lib/llmConfigClient.js'

const INPUT = 'h-9 w-full rounded-control border border-ink/15 bg-paper px-2.5 text-sm text-ink outline-none focus:border-focus'
// A select with no options renders blank, so the protocol list never depends on
// a successful catalogue fetch.
const FALLBACK_PROTOCOLS = Object.freeze([
  { id: 'openai-completions', label: 'OpenAI Chat Completions' },
  { id: 'openai-responses', label: 'OpenAI Responses' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
])
const LABEL = 'text-xs font-medium text-ink'
const TAB = 'rounded-control px-3 py-1.5 text-sm transition-colors'
const PRIMARY = 'h-9 rounded-control bg-ink px-4 text-sm text-paper disabled:opacity-40'
const SECONDARY = 'h-9 rounded-control border border-ink/15 bg-paper px-4 text-sm text-ink'
const LINK = 'inline-flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-50'

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
 * One panel, two honest shapes: a provider from the built-in catalogue (endpoint
 * and protocol are known; the key and the model list are asked), or a
 * hand-declared gateway (id, address, protocol, key). Both end in the same
 * settings.yaml entry.
 *
 * The model directory is part of the form on purpose: "获取可用模型" probes the
 * endpoint before anything is saved, and the picked list is written with the
 * provider — so the picker is never empty right after adding one.
 */
export default function AddProviderPanel({ catalog, editing, initialCatalogEntryId = '', onCancel, onSaved, t }) {
  const [tab, setTab] = useState(editing?.custom ? 'custom' : 'catalog')
  const [customOpen, setCustomOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [catalogId, setCatalogId] = useState(editing?.id || initialCatalogEntryId || 'openai')
  const [models, setModels] = useState(() => (editing?.models || []).map((model) => String(model.id || model)))
  const [modelDraft, setModelDraft] = useState('')
  const [form, setForm] = useState(() => ({
    apiKey: '',
    baseURL: editing?.baseURL || '',
    id: editing?.id || '',
    displayName: editing?.displayName || '',
    api: editing?.api || 'openai-completions',
  }))
  const patch = (values) => setForm((current) => ({ ...current, ...values }))
  const preset = (catalog?.cloud || []).find((entry) => entry.id === catalogId)
    || (catalog?.local || []).find((entry) => entry.id === catalogId)
    || null
  const target = tab === 'custom'
    ? { api: form.api, baseURL: form.baseURL.trim() }
    : { api: preset?.api || 'openai-completions', baseURL: form.baseURL.trim() || preset?.baseURL || '' }

  const probe = async () => {
    setBusy(true)
    setNote('')
    try {
      const result = await probeLlmDraft({ ...target, apiKey: form.apiKey.trim() })
      const discovered = result.discovered || []
      setModels((current) => [...new Set([...current, ...discovered])])
      setNote(t('settingsModels.probeFound', { count: discovered.length }))
    } catch (failure) {
      setNote(failure.message)
    } finally {
      setBusy(false)
    }
  }
  const addModel = () => {
    const id = modelDraft.trim()
    if (!id) return
    setModels((current) => [...new Set([...current, id])])
    setModelDraft('')
  }
  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const provider = tab === 'custom'
        ? { id: form.id.trim().toLowerCase(), displayName: form.displayName.trim() || form.id.trim(), api: form.api, baseURL: form.baseURL.trim(), custom: true }
        : { id: catalogId, ...(form.baseURL.trim() ? { baseURL: form.baseURL.trim() } : {}) }
      if (!provider.id) throw new Error(t('settingsModels.providerIdRequired'))
      if (models.length > 0) provider.models = models.map((id) => ({ id }))
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
                aria-pressed={catalogId === entry.id} onClick={() => setCatalogId(entry.id)}
                className={`flex items-center rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                  catalogId === entry.id ? 'border-accent bg-accent/8 font-medium text-ink' : 'border-ink/12 bg-surface text-ink hover:border-ink/30'}`}>
                {entry.displayName}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-fade">{t('settingsModels.localPresets')}</p>
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
                onChange={(event) => patch({ baseURL: event.target.value })} placeholder={preset?.baseURL || t('settingsModels.providerDefault')} />
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
              {(catalog?.protocols?.length ? catalog.protocols : FALLBACK_PROTOCOLS).map((protocol) => (
                <option key={protocol.id} value={protocol.id}>{protocol.label}</option>
              ))}
            </select>
          </Field>
          <Field label={t('settingsModels.apiKey')}>
            <input className={INPUT} data-testid="custom-api-key" type="password" autoComplete="off" value={form.apiKey}
              onChange={(event) => patch({ apiKey: event.target.value })} placeholder={t('settingsModels.apiKeyPlaceholderCustom')} />
          </Field>
        </>
      )}

      {/* While editing a saved provider, the card below already shows the live
          directory; a second, draft-only copy here would silently disagree with
          it and made "delete a model" look like it did nothing. */}
      {!editing && (
      <div className="flex flex-col gap-2 border-t border-ink/10 pt-3" data-testid="form-model-directory">
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL}>{t('settingsModels.modelDirectory')}</span>
          <button type="button" className={LINK} data-testid="probe-draft-models" disabled={busy} onClick={probe}>
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
            {t('settingsModels.probeModels')}
          </button>
        </div>
        <span className="text-xs text-ink-fade" data-testid="adapter-default-models">
          {models.length === 0 ? t('settingsModels.adapterDefaultModels') : t('settingsModels.modelCount', { count: models.length })}
        </span>
        {models.length === 0 ? (
          <p className="rounded-control border border-dashed border-ink/20 px-3 py-2 text-center text-xs text-ink-fade" data-testid="form-model-empty">
            {t('settingsModels.modelsEmptyHint')}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {models.map((modelId) => (
              <li key={modelId} className="flex items-center gap-1 rounded-pill bg-paper-2 px-2 py-0.5 text-xs text-ink-soft">
                <span>{modelId}</span>
                <button type="button" aria-label={t('settingsModels.removeModel')} data-testid="draft-remove-model" data-model={modelId}
                  className="text-ink-fade hover:text-danger" onClick={() => setModels((current) => current.filter((id) => id !== modelId))}>
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input className={INPUT} data-testid="draft-model-input" value={modelDraft} placeholder={t('settingsModels.modelIdPlaceholder')}
            onChange={(event) => setModelDraft(event.target.value)} onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              addModel()
            }} />
          <button type="button" className={`${SECONDARY} whitespace-nowrap`} data-testid="draft-add-model" disabled={!modelDraft.trim()} onClick={addModel}>
            <Plus className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
            {t('settingsModels.addModel')}
          </button>
        </div>
        {note && <p role="status" className="text-xs text-ink-fade" data-testid="probe-note">{note}</p>}
      </div>
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
