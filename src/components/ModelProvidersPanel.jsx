import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Server } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import { deleteModelProvider, discoverModelProvider, listModelProviders, saveModelProvider, testModelProvider } from '../lib/modelClient.js'
import ProviderDiagnostics from './modelProviders/ProviderDiagnostics.jsx'
import ProviderEditor from './modelProviders/ProviderEditor.jsx'
import ProviderList from './modelProviders/ProviderList.jsx'
import { formatProviderError } from './modelProviders/providerError.js'
import {
  emptyProvider, findConfiguredPresetProvider, mergeDiscoveredModelProfiles, normalizeEditorModelProfiles, numberOrNull,
  providerBaseUrlError, PROVIDER_PRESETS, resolveProviderDefaultModel, selectToTribool, toEditor,
} from './modelProviders/providerConfig.js'
import { buildProviderValidation, isAgentReady, readinessFromTestResult } from './modelProviders/providerPanelValidation.js'

export default function ModelProvidersPanel({ onChanged, onReady }) {
  const { t } = useT()
  const [providers, setProviders] = useState([])
  const [editing, setEditing] = useState(null)
  const [editorPortalTarget, setEditorPortalTarget] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [diagnostics, setDiagnostics] = useState(null)
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

  const save = async () => {
    setBusy(true)
    setMessage('')
    try {
      const validationError = keyError || labelError || baseUrlError || modelsError || headersError || numericValidationError
      if (validationError) throw new Error(validationError)
      const models = editing.modelsText.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
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

  const capturePanel = useCallback((node) => {
    if (node) setEditorPortalTarget(node.closest('[role="dialog"]') || document.body)
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
    />}
  </div>
}
