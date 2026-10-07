import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Server } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import {
  deleteModelProvider, discoverModelProvider, getCatalogProviderModels, listCatalogProviders,
  listModelProviders, refreshModelCatalog, saveModelProvider, testModelProvider,
} from '../lib/modelClient.js'
import ProviderDiagnostics from './modelProviders/ProviderDiagnostics.jsx'
import ProviderEditor from './modelProviders/ProviderEditor.jsx'
import ProviderList from './modelProviders/ProviderList.jsx'
import { formatProviderError } from './modelProviders/providerError.js'
import {
  CATALOG_BASE_URLS, emptyProvider, findConfiguredPresetProvider, mergeDiscoveredModelProfiles, normalizeEditorModelProfiles, numberOrNull,
  parseModelList, providerBaseUrlError, PROVIDER_PRESETS, resolveProviderDefaultModel, seedCustomEditor, selectToTribool, toEditor,
} from './modelProviders/providerConfig.js'
import { buildProviderValidation, isAgentReady, readinessFromTestResult } from './modelProviders/providerPanelValidation.js'

/**
 * The catalogue-only provider list the picker can browse.
 *
 * The index is fetched once from the catalogue, so a provider with no bundled
 * preset (amazon-bedrock, cerebras, baseten, …) is discoverable by browsing
 * rather than by already knowing its id. Providers the reader then opens are
 * folded back in with their live model count, newest-first, so the most recently
 * used entry is the one nearest the top.
 */
function rememberCatalogProvider(known, provider) {
  const id = String(provider?.id || '').trim()
  if (!id) return known
  const entry = {
    id,
    name: provider.name || id,
    ...(typeof provider.modelCount === 'number' ? { modelCount: provider.modelCount } : {}),
  }
  return [entry, ...known.filter((item) => item.id !== id)]
}

export default function ModelProvidersPanel({ onChanged, onReady }) {
  const { t } = useT()
  const [providers, setProviders] = useState([])
  const [editing, setEditing] = useState(null)
  const [editorPortalTarget, setEditorPortalTarget] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [diagnostics, setDiagnostics] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [catalogProviders, setCatalogProviders] = useState([])
  const [catalogModels, setCatalogModels] = useState([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [catalogRefreshError, setCatalogRefreshError] = useState('')
  const [catalogMessage, setCatalogMessage] = useState('')
  const catalogRequestVersion = useRef(0)
  const discoverRequestVersion = useRef(0)
  const updateEditing = useCallback((next) => {
    discoverRequestVersion.current += 1
    setDetecting(false)
    setEditing(next)
  }, [])
  const {
    baseUrlError, canSave, contextWindowError, firstTokenTimeoutError, hasCredentials,
    headersError, idleTimeoutError, keyError, labelError, modelContextErrors, modelsError, numericValidationError,
  } = buildProviderValidation(editing, t)

  const notifyChanged = () => {
    onChanged?.()
    window.dispatchEvent(new Event('model-providers:changed'))
  }

  const reload = useCallback(async () => {
    const data = await listModelProviders()
    setProviders(data?.providers || [])
  }, [])

  useEffect(() => {
    let active = true
    Promise.resolve().then(async () => {
      try {
        const data = await listModelProviders()
        if (active) setProviders(data?.providers || [])
      } catch (error) {
        if (active) setMessage(formatProviderError(error, t))
      }
    })
    return () => { active = false }
  }, [t])

  // Provenance is read once, on mount: it is the label on the knowledge base, and
  // the surface must keep working when it cannot be read at all. The provider
  // index rides along so the picker can offer every catalogue provider, not only
  // the ones this app happens to ship a preset for.
  useEffect(() => {
    let active = true
    Promise.resolve().then(async () => {
      try {
        const { providers: indexed, catalog: status } = await listCatalogProviders()
        if (!active) return
        if (status) setCatalog(status)
        if (indexed.length) setCatalogProviders(indexed)
      } catch {
        if (active) setCatalog((current) => current || { available: false, source: 'none', generatedAt: '', error: '' })
      }
    })
    return () => { active = false }
  }, [])

  const loadCatalogModels = useCallback(async (providerId) => {
    const id = String(providerId || '').trim()
    if (!id) return
    const requestVersion = catalogRequestVersion.current + 1
    catalogRequestVersion.current = requestVersion
    setCatalogLoading(true)
    setCatalogError('')
    try {
      const data = await getCatalogProviderModels(id)
      if (catalogRequestVersion.current !== requestVersion) return
      setCatalogModels(data.models)
      setCatalogProviders((current) => rememberCatalogProvider(current, {
        id: data.provider?.id || id,
        name: data.provider?.name || id,
        modelCount: data.models.length,
      }))
      if (data.catalog) setCatalog(data.catalog)
    } catch (error) {
      if (catalogRequestVersion.current !== requestVersion) return
      setCatalogModels([])
      setCatalogError(error?.code === 'CATALOG_PROVIDER_UNKNOWN'
        ? t('modelProviders.knowledgeBaseUnknownProvider')
        : t('modelProviders.catalogProviderFailed', { error: formatProviderError(error, t) }))
    } finally {
      if (catalogRequestVersion.current === requestVersion) setCatalogLoading(false)
    }
  }, [t])

  const refreshCatalog = useCallback(async () => {
    setRefreshingCatalog(true)
    setCatalogRefreshError('')
    setCatalogMessage('')
    try {
      const status = await refreshModelCatalog()
      if (status) setCatalog(status)
      if (status?.error) setCatalogRefreshError(status.error)
      else setCatalogMessage(t('modelProviders.catalogRefreshOk'))
    } catch (error) {
      // A refresh only improves data the app already has, so a failure is shown
      // beside the list rather than replacing it.
      setCatalogRefreshError(formatProviderError(error, t))
    } finally {
      setRefreshingCatalog(false)
    }
  }, [t])

  /**
   * Choose a provider the bundled presets never covered.
   *
   * It enters through the `custom` path — service URL plus API key — instead of
   * inventing a second activation model, so everything downstream (validation,
   * saving, testing, discovery) is the behavior a custom endpoint already has.
   */
  const chooseCatalogProvider = (provider) => {
    const id = String(provider?.id || '').trim()
    if (!id) return
    const name = String(provider?.name || id).trim()
    updateEditing((current) => {
      const seeded = current && typeof current === 'object' && current.presetId
        ? seedCustomEditor(current, { key: id, label: name })
        : { ...emptyProvider(), presetId: 'custom', key: id, label: name, isDefault: true }
      return {
        ...seeded,
        ...(CATALOG_BASE_URLS[id] ? { baseUrl: CATALOG_BASE_URLS[id] } : {}),
        catalogProviderId: id,
      }
    })
    setCatalogProviders((current) => rememberCatalogProvider(current, provider))
    setCatalogModels([])
    setCatalogError('')
  }

  const save = async () => {
    setBusy(true)
    setMessage('')
    try {
      const validationError = keyError || labelError || baseUrlError || modelsError || headersError || numericValidationError
      if (validationError) throw new Error(validationError)
      const models = parseModelList(editing.modelsText)
      const preset = PROVIDER_PRESETS.find((item) => item.id === editing.presetId)
      if (preset && !preset.local && !hasCredentials) throw new Error(t('modelProviders.apiKeyRequired'))
      const existingPresetProvider = editing.id ? null : findConfiguredPresetProvider(providers, preset)
      let headers
      let headerUpdates
      let removeHeaderKeys
      if (editing.clearHeaders === true) headers = {}
      else if (editing.headersText.trim()) {
        const parsedHeaders = JSON.parse(editing.headersText)
        if (editing.id) headerUpdates = parsedHeaders
        else headers = parsedHeaders
      }
      if (editing.id && editing.clearHeaders !== true && Array.isArray(editing.removedHeaderKeys)
        && editing.removedHeaderKeys.length) removeHeaderKeys = editing.removedHeaderKeys
      const defaultModel = resolveProviderDefaultModel(models, editing.defaultModel)
      const saved = await saveModelProvider({
        id: editing.id || existingPresetProvider?.id || undefined, key: editing.key, label: editing.label, baseUrl: editing.baseUrl,
        ...((editing.id || existingPresetProvider?.id)
          ? { configRevision: editing.configRevision ?? existingPresetProvider?.configRevision }
          : {}),
        apiKey: editing.apiKey, clearApiKey: editing.clearApiKey === true, models,
        defaultModel, enabled: editing.enabled,
        isDefault: editing.isDefault, ...(headers !== undefined ? { headers } : {}),
        ...(headerUpdates !== undefined ? { headerUpdates } : {}), kind: editing.kind || null,
        ...(removeHeaderKeys !== undefined ? { removeHeaderKeys } : {}),
        contextWindow: numberOrNull(editing.contextWindow, 'contextWindow'), supportsTools: selectToTribool(editing.supportsTools),
        supportsStreaming: selectToTribool(editing.supportsStreaming), supportsVision: selectToTribool(editing.supportsVision),
        supportsPdf: selectToTribool(editing.supportsPdf), firstTokenTimeoutMs: numberOrNull(editing.firstTokenTimeoutMs, 'firstTokenTimeoutMs'),
        idleTimeoutMs: numberOrNull(editing.idleTimeoutMs, 'idleTimeoutMs'), failoverEnabled: selectToTribool(editing.failoverEnabled),
        keepAlive: String(editing.keepAlive || '').trim() || null, modelProfiles: normalizeEditorModelProfiles(editing.modelProfiles),
      })
      updateEditing(null)
      // The mutation is already durable at this point. Broadcast it before a
      // best-effort list refresh so other model consumers never retain a stale
      // catalog merely because the follow-up GET failed.
      notifyChanged()
      const savedProvider = saved?.provider || null
      const providerId = savedProvider?.id || editing.id || existingPresetProvider?.id || ''
      const testedModel = savedProvider?.defaultModel || defaultModel
      setMessage(t('modelProviders.savedTesting'))
      try {
        if (!providerId || !testedModel) throw new Error(t('modelProviders.savedTestFailed'))
        const data = await testModelProvider(providerId, testedModel)
        const readiness = readinessFromTestResult(data, testedModel)
        const nextDiagnostics = {
          providerId,
          modelName: data.modelName || testedModel,
          running: false,
          ok: data.ok,
          steps: data.steps || [],
          profile: data.profile || null,
        }
        notifyChanged()
        try {
          await reload()
        } catch {
          // The test response is authoritative; a list refresh failure must
          // not turn a persisted readiness receipt back into "untested".
        }
        if (isAgentReady(readiness)) {
          setDiagnostics(null)
          setMessage(t('modelProviders.savedReady'))
          onReady?.({
            provider: data.provider || savedProvider,
            modelName: data.modelName || testedModel,
            readiness,
          })
        } else {
          setDiagnostics(nextDiagnostics)
          setMessage(t(readiness?.mode === 'chat_only'
            ? 'modelProviders.savedChatOnly'
            : 'modelProviders.savedTestFailed'))
        }
      } catch (error) {
        setDiagnostics({
          providerId,
          modelName: testedModel,
          running: false,
          ok: false,
          steps: error?.payload?.steps || [],
          profile: error?.payload?.profile || null,
          error: formatProviderError(error, t),
        })
        notifyChanged()
        try { await reload() } catch { /* keep the saved provider and diagnostics visible */ }
        setMessage(`${t('modelProviders.savedTestFailed')} ${formatProviderError(error, t)}`)
      }
    } catch (error) { setMessage(formatProviderError(error, t)) } finally { setBusy(false) }
  }

  const remove = async (provider) => {
    if (!window.confirm(t('modelProviders.confirmDelete'))) return
    setBusy(true)
    try {
      await deleteModelProvider(provider.id)
      notifyChanged()
      try {
        await reload()
      } catch (error) {
        setMessage(formatProviderError(error, t))
      }
    } catch (error) { setMessage(formatProviderError(error, t)) } finally { setBusy(false) }
  }

  const test = async (provider, modelName) => {
    setBusy(true)
    setMessage('')
    setDiagnostics({ providerId: provider.id, modelName, running: true, steps: [], profile: null })
    try {
      const data = await testModelProvider(provider.id, modelName)
      setDiagnostics({ providerId: provider.id, modelName: data.modelName || modelName, running: false, ok: data.ok, steps: data.steps || [], profile: data.profile || null })
    } catch (error) {
      setDiagnostics({ providerId: provider.id, modelName, running: false, ok: false, steps: error?.payload?.steps || [], profile: error?.payload?.profile || null, error: formatProviderError(error, t) })
    } finally {
      try {
        await reload()
        notifyChanged()
      } catch (error) {
        setMessage(formatProviderError(error, t))
      }
      setBusy(false)
    }
  }

  const discover = async () => {
    if (!editing?.baseUrl?.trim()) return
    if (headersError) {
      setMessage(headersError)
      return
    }
    const invalidBaseUrl = providerBaseUrlError(editing.baseUrl)
    if (invalidBaseUrl) {
      setMessage(t(`modelProviders.baseUrlError${invalidBaseUrl[0].toUpperCase()}${invalidBaseUrl.slice(1)}`))
      return
    }
    const requestVersion = discoverRequestVersion.current + 1
    discoverRequestVersion.current = requestVersion
    setDetecting(true)
    setMessage(t('modelProviders.detecting'))
    try {
      let headers = {}
      if (editing.headersText.trim()) headers = JSON.parse(editing.headersText)
      const data = await discoverModelProvider({
        id: editing.id || undefined,
        baseUrl: editing.baseUrl,
        apiKey: editing.apiKey,
        headers,
        clearApiKey: editing.clearApiKey === true,
        clearHeaders: editing.clearHeaders === true,
        removeHeaderKeys: editing.clearHeaders === true ? [] : editing.removedHeaderKeys,
      })
      const models = data.models || data.endpoint?.remoteModels || []
      if (!models.length) throw new Error(t('modelProviders.noModels'))
      if (discoverRequestVersion.current !== requestVersion) return
      const detected = data.detected || null
      const discoveredProfiles = data.modelProfiles && typeof data.modelProfiles === 'object' ? data.modelProfiles : {}
      setEditing((current) => ({
        ...current, modelsText: models.join('\n'), defaultModel: resolveProviderDefaultModel(models, current.defaultModel),
        modelProfiles: mergeDiscoveredModelProfiles(current.modelProfiles, discoveredProfiles, models),
        ...(data.kind && !current.kind ? { kind: data.kind } : {}),
        ...(models.length === 1 && detected?.contextWindow ? { contextWindow: String(detected.contextWindow) } : {}),
        ...(models.length === 1 && detected?.supportsTools != null ? { supportsTools: detected.supportsTools ? '1' : '0' } : {}),
        ...(models.length === 1 && detected?.supportsVision != null ? { supportsVision: detected.supportsVision ? '1' : '0' } : {}),
      }))
      const found = t('modelProviders.discovered').replace('{count}', String(models.length))
      setMessage(detected?.contextWindow ? `${found} ${t('modelProviders.detectedFrom')}: ${detected.contextWindow} token` : found)
    } catch (error) {
      if (discoverRequestVersion.current === requestVersion) setMessage(formatProviderError(error, t))
    } finally {
      if (discoverRequestVersion.current === requestVersion) setDetecting(false)
    }
  }

  // Keep the nested editor inside the React root that owns this panel: a portal
  // that escapes to `document.body` sits outside the container React delegates
  // events from, so a controlled input portalled there can never report a change.
  const capturePanel = useCallback((node) => {
    if (!node) return
    setEditorPortalTarget(node.closest('[role="dialog"]') || node.parentElement || document.body)
  }, [])

  return <div ref={capturePanel} className="border border-ink/20 rounded-md bg-paper p-4 flex flex-col gap-3">
    <div className="flex items-start gap-3">
      <Server className="w-4 h-4 text-accent-ink mt-0.5" />
      <div className="flex-1"><div className="text-sm font-semibold text-ink">{t('modelProviders.title')}</div><div className="text-xs text-ink-fade mt-0.5">{t('modelProviders.subtitle')}</div></div>
      <button type="button" onClick={() => updateEditing(emptyProvider())} className="h-8 px-3 bg-ink text-paper rounded-md text-xs flex items-center gap-1"><Plus className="w-3.5 h-3.5" />{t('modelProviders.add')}</button>
    </div>
    <ProviderList providers={providers} busy={busy} onTest={test} onEdit={(provider) => updateEditing(toEditor(provider))} onRemove={remove} t={t} />
    {message && <div className="text-xs text-ink-soft border border-ink/10 rounded-md p-2">{message}</div>}
    <ProviderDiagnostics diagnostics={diagnostics} onClose={() => setDiagnostics(null)} t={t} />
    {editing && <ProviderEditor
      key={`${editing.id || 'new'}:${editing.presetId || 'picker'}`}
      editing={editing} setEditing={updateEditing} providers={providers} busy={busy} detecting={detecting} canSave={canSave}
      hasCredentials={hasCredentials}
      keyError={keyError} labelError={labelError} baseUrlError={baseUrlError} modelsError={modelsError} headersError={headersError}
      contextWindowError={contextWindowError} firstTokenTimeoutError={firstTokenTimeoutError}
      idleTimeoutError={idleTimeoutError} modelContextErrors={modelContextErrors}
      message={message} onSave={save} onDiscover={discover} portalTarget={editorPortalTarget} t={t}
      catalog={catalog} catalogProviders={catalogProviders} catalogModels={catalogModels}
      catalogLoading={catalogLoading} catalogError={catalogError} refreshingCatalog={refreshingCatalog}
      catalogRefreshError={catalogRefreshError} catalogMessage={catalogMessage}
      onRefreshCatalog={refreshCatalog} onChooseCatalogProvider={chooseCatalogProvider}
      onLoadCatalogModels={loadCatalogModels} onCatalogMessage={setCatalogMessage}
    />}
  </div>
}
