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
  providerBaseUrlError, providerHasCredentials, providerHeadersError, providerKeyError, providerLabelError, providerModelsError,
  providerNumericFieldError, PROVIDER_PRESETS, resolveProviderDefaultModel, selectToTribool, toEditor,
} from './modelProviders/providerConfig.js'

function requiredFieldError(label, t) {
  const template = String(t('modelProviders.baseUrlErrorRequired'))
  return template.includes('Base URL') ? template.replaceAll('Base URL', label) : `${label}: ${template}`
}

function providerKeyErrorMessage(code, t) {
  if (!code) return ''
  if (code === 'required') return requiredFieldError('Provider ID', t)
  return 'Provider ID · a-z first · a-z / 0-9 / _ / - · 1–40'
}

function numericFieldErrorMessage(error, label, t) {
  if (!error) return ''
  if (error.reason === 'min') return t('modelProviders.numericErrorMin', { field: label, min: error.min })
  if (error.reason === 'max' || error.reason === 'safeInteger') {
    return t('modelProviders.numericErrorMax', { field: label, max: error.max })
  }
  return t('modelProviders.numericErrorInteger', { field: label })
}

function readinessFromTestResult(result, modelName) {
  return result?.readiness
    || result?.provider?.modelReadiness?.[modelName]
    || (result?.provider?.defaultModel === modelName ? result?.provider?.readiness : null)
    || result?.capabilities
    || null
}

function isAgentReady(readiness) {
  return readiness?.mode === 'agent'
    && readiness.chat === true
    && readiness.tools === true
    && readiness.agent === true
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
  const discoverRequestVersion = useRef(0)
  const updateEditing = useCallback((next) => {
    discoverRequestVersion.current += 1
    setDetecting(false)
    setEditing(next)
  }, [])
  const selectedPreset = editing ? PROVIDER_PRESETS.find((preset) => preset.id === editing.presetId) : null
  const isLocalPreset = selectedPreset?.local === true
  const keyErrorCode = editing ? providerKeyError(editing.key) : ''
  const labelErrorCode = editing ? providerLabelError(editing.label) : ''
  const baseUrlErrorCode = editing ? providerBaseUrlError(editing.baseUrl) : ''
  const modelsErrorCode = editing ? providerModelsError(editing.modelsText) : ''
  const headersErrorCode = editing ? providerHeadersError(editing.headersText) : ''
  const keyError = providerKeyErrorMessage(keyErrorCode, t)
  const labelError = labelErrorCode ? requiredFieldError(t('modelProviders.name'), t) : ''
  const baseUrlError = baseUrlErrorCode ? t(`modelProviders.baseUrlError${baseUrlErrorCode[0].toUpperCase()}${baseUrlErrorCode.slice(1)}`) : ''
  const modelsError = modelsErrorCode ? requiredFieldError(t('modelProviders.models'), t) : ''
  const headersError = headersErrorCode ? t(`modelProviders.headersError${headersErrorCode[0].toUpperCase()}${headersErrorCode.slice(1)}`) : ''
  const contextWindowError = editing
    ? numericFieldErrorMessage(providerNumericFieldError(editing.contextWindow, 'contextWindow'), t('modelProviders.contextWindow'), t)
    : ''
  const firstTokenTimeoutError = editing
    ? numericFieldErrorMessage(providerNumericFieldError(editing.firstTokenTimeoutMs, 'firstTokenTimeoutMs'), t('modelProviders.firstTokenTimeout'), t)
    : ''
  const idleTimeoutError = editing
    ? numericFieldErrorMessage(providerNumericFieldError(editing.idleTimeoutMs, 'idleTimeoutMs'), t('modelProviders.idleTimeout'), t)
    : ''
  const modelContextErrors = editing ? Object.fromEntries(
    [...new Set(String(editing.modelsText || '').split(/[\n,]/).map((model) => model.trim()).filter(Boolean))]
      .flatMap((model) => {
        const error = providerNumericFieldError(editing.modelProfiles?.[model]?.contextWindow, 'contextWindow')
        const message = numericFieldErrorMessage(error, `${model} · ${t('modelProviders.contextWindow')}`, t)
        return message ? [[model, message]] : []
      }),
  ) : {}
  const numericValidationError = contextWindowError || firstTokenTimeoutError || idleTimeoutError
    || Object.values(modelContextErrors)[0] || ''
  const hasCredentials = providerHasCredentials(editing)
  const canSave = Boolean(editing && !keyErrorCode && !labelErrorCode && !baseUrlErrorCode && !modelsErrorCode && !headersErrorCode && !numericValidationError
    && (isLocalPreset || editing?.presetId === 'custom' || hasCredentials))

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
      if (typeof onReady === 'function') {
        const savedProvider = saved?.provider || null
        const providerId = savedProvider?.id || editing.id || existingPresetProvider?.id || ''
        const testedModel = savedProvider?.defaultModel || defaultModel
        setMessage(t('modelProviders.savedTesting'))
        setDiagnostics({ providerId, modelName: testedModel, running: true, steps: [], profile: null })
        try {
          if (!providerId || !testedModel) throw new Error(t('modelProviders.savedTestFailed'))
          const data = await testModelProvider(providerId, testedModel)
          const readiness = readinessFromTestResult(data, testedModel)
          setDiagnostics({
            providerId,
            modelName: data.modelName || testedModel,
            running: false,
            ok: data.ok,
            steps: data.steps || [],
            profile: data.profile || null,
          })
          notifyChanged()
          try {
            await reload()
          } catch {
            // The test response is authoritative; a list refresh failure must
            // not turn a persisted readiness receipt back into "untested".
          }
          if (isAgentReady(readiness)) {
            setMessage(t('modelProviders.savedReady'))
            onReady({
              provider: data.provider || savedProvider,
              modelName: data.modelName || testedModel,
              readiness,
            })
          } else {
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
        return
      }
      try {
        await reload()
        setMessage(t('modelProviders.saved'))
      } catch (error) {
        setMessage(`${t('modelProviders.saved')} ${formatProviderError(error, t)}`)
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
      <button type="button" onClick={() => updateEditing({ ...emptyProvider(), presetId: 'custom' })} className="h-8 px-3 bg-ink text-paper rounded-md text-xs flex items-center gap-1"><Plus className="w-3.5 h-3.5" />{t('modelProviders.add')}</button>
    </div>
    <div data-testid="model-provider-byok-notice" className="rounded-md border border-accent-ink/20 bg-accent-ink/5 px-3 py-2 text-xs leading-relaxed text-ink-soft">{t('modelProviders.byokNotice')}</div>
    <ProviderList providers={providers} busy={busy} onTest={test} onEdit={(provider) => updateEditing(toEditor(provider))} onRemove={remove} t={t} />
    {message && <div className="text-xs text-ink-soft border border-ink/10 rounded-md p-2">{message}</div>}
    <ProviderDiagnostics diagnostics={diagnostics} onClose={() => setDiagnostics(null)} t={t} />
    {editing && <ProviderEditor
      editing={editing} setEditing={updateEditing} providers={providers} busy={busy} detecting={detecting} canSave={canSave}
      hasCredentials={hasCredentials}
      keyError={keyError} labelError={labelError} baseUrlError={baseUrlError} modelsError={modelsError} headersError={headersError}
      contextWindowError={contextWindowError} firstTokenTimeoutError={firstTokenTimeoutError}
      idleTimeoutError={idleTimeoutError} modelContextErrors={modelContextErrors}
      message={message} onSave={save} onDiscover={discover} portalTarget={editorPortalTarget} t={t}
    />}
  </div>
}
