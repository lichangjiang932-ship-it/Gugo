import { useCallback, useEffect, useState } from 'react'
import { Plus, Server } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import { deleteModelProvider, discoverModelProvider, listModelProviders, saveModelProvider, testModelProvider } from '../lib/modelClient.js'
import ProviderDiagnostics from './modelProviders/ProviderDiagnostics.jsx'
import ProviderEditor from './modelProviders/ProviderEditor.jsx'
import ProviderList from './modelProviders/ProviderList.jsx'
import {
  emptyProvider, findConfiguredPresetProvider, mergeDiscoveredModelProfiles, numberOrNull, PROVIDER_PRESETS, selectToTribool, toEditor,
} from './modelProviders/providerConfig.js'

export default function ModelProvidersPanel({ onChanged }) {
  const { t } = useT()
  const [providers, setProviders] = useState([])
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [diagnostics, setDiagnostics] = useState(null)
  const selectedPreset = editing ? PROVIDER_PRESETS.find((preset) => preset.id === editing.presetId) : null
  const isLocalPreset = selectedPreset?.local === true
  const modelsReady = Boolean(editing?.modelsText?.split(/[\n,]/).some((model) => model.trim()))
  const canSave = Boolean(editing?.baseUrl?.trim() && modelsReady
    && (isLocalPreset || editing?.presetId === 'custom' || editing?.apiKey?.trim() || editing?.hasApiKey))

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
        if (active) setMessage(error.message)
      }
    })
    return () => { active = false }
  }, [])

  const save = async () => {
    setBusy(true)
    setMessage('')
    try {
      const models = editing.modelsText.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
      const preset = PROVIDER_PRESETS.find((item) => item.id === editing.presetId)
      if (preset && !preset.local && !editing.apiKey.trim() && !editing.hasApiKey) throw new Error(t('modelProviders.apiKeyRequired'))
      const existingPresetProvider = editing.id ? null : findConfiguredPresetProvider(providers, preset)
      let headers
      if (editing.headersText.trim()) headers = JSON.parse(editing.headersText)
      await saveModelProvider({
        id: editing.id || existingPresetProvider?.id || undefined, key: editing.key, label: editing.label, baseUrl: editing.baseUrl,
        apiKey: editing.apiKey, models, defaultModel: editing.defaultModel || models[0], enabled: editing.enabled,
        isDefault: editing.isDefault, ...(headers ? { headers } : {}), kind: editing.kind || null,
        contextWindow: numberOrNull(editing.contextWindow), supportsTools: selectToTribool(editing.supportsTools),
        supportsStreaming: selectToTribool(editing.supportsStreaming), supportsVision: selectToTribool(editing.supportsVision),
        supportsPdf: selectToTribool(editing.supportsPdf), firstTokenTimeoutMs: numberOrNull(editing.firstTokenTimeoutMs),
        idleTimeoutMs: numberOrNull(editing.idleTimeoutMs), failoverEnabled: selectToTribool(editing.failoverEnabled),
        keepAlive: String(editing.keepAlive || '').trim() || null, modelProfiles: editing.modelProfiles || {},
      })
      setEditing(null)
      await reload()
      notifyChanged()
      setMessage(t('modelProviders.saved'))
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }

  const remove = async (provider) => {
    if (!window.confirm(t('modelProviders.confirmDelete'))) return
    setBusy(true)
    try {
      await deleteModelProvider(provider.id)
      await reload()
      notifyChanged()
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }

  const test = async (provider) => {
    setBusy(true)
    setMessage('')
    setDiagnostics({ providerId: provider.id, running: true, steps: [], profile: null })
    try {
      const data = await testModelProvider(provider.id)
      setDiagnostics({ providerId: provider.id, running: false, ok: data.ok, steps: data.steps || [], profile: data.profile || null })
    } catch (error) {
      setDiagnostics({ providerId: provider.id, running: false, ok: false, steps: error?.payload?.steps || [], profile: error?.payload?.profile || null, error: error.message })
    } finally { setBusy(false) }
  }

  const discover = async () => {
    if (!editing?.baseUrl?.trim()) return
    setDetecting(true)
    setMessage(t('modelProviders.detecting'))
    try {
      let headers = {}
      if (editing.headersText.trim()) headers = JSON.parse(editing.headersText)
      const data = await discoverModelProvider({ id: editing.id || undefined, baseUrl: editing.baseUrl, apiKey: editing.apiKey, headers })
      const models = data.models || data.endpoint?.remoteModels || []
      if (!models.length) throw new Error(t('modelProviders.noModels'))
      const detected = data.detected || null
      const discoveredProfiles = data.modelProfiles && typeof data.modelProfiles === 'object' ? data.modelProfiles : {}
      setEditing((current) => ({
        ...current, modelsText: models.join('\n'), defaultModel: models.includes(current.defaultModel) ? current.defaultModel : models[0],
        modelProfiles: mergeDiscoveredModelProfiles(current.modelProfiles, discoveredProfiles, models),
        ...(data.kind && !current.kind ? { kind: data.kind } : {}),
        ...(models.length === 1 && detected?.contextWindow ? { contextWindow: String(detected.contextWindow) } : {}),
        ...(models.length === 1 && detected?.supportsTools != null ? { supportsTools: detected.supportsTools ? '1' : '0' } : {}),
        ...(models.length === 1 && detected?.supportsVision != null ? { supportsVision: detected.supportsVision ? '1' : '0' } : {}),
      }))
      const found = t('modelProviders.discovered').replace('{count}', String(models.length))
      setMessage(detected?.contextWindow ? `${found} ${t('modelProviders.detectedFrom')}: ${detected.contextWindow} token` : found)
    } catch (error) { setMessage(error.message) } finally { setDetecting(false) }
  }

  return <div className="border border-ink/20 rounded-md bg-paper p-4 flex flex-col gap-3">
    <div className="flex items-start gap-3">
      <Server className="w-4 h-4 text-accent-ink mt-0.5" />
      <div className="flex-1"><div className="text-sm font-semibold text-ink">{t('modelProviders.title')}</div><div className="text-xs text-ink-fade mt-0.5">{t('modelProviders.subtitle')}</div></div>
      <button type="button" onClick={() => setEditing(emptyProvider())} className="h-8 px-3 bg-ink text-paper rounded-md text-xs flex items-center gap-1"><Plus className="w-3.5 h-3.5" />{t('modelProviders.add')}</button>
    </div>
    <ProviderList providers={providers} busy={busy} onTest={test} onEdit={(provider) => setEditing(toEditor(provider))} onRemove={remove} t={t} />
    {message && <div className="text-xs text-ink-soft border border-ink/10 rounded-md p-2">{message}</div>}
    <ProviderDiagnostics diagnostics={diagnostics} onClose={() => setDiagnostics(null)} t={t} />
    {editing && <ProviderEditor editing={editing} setEditing={setEditing} providers={providers} busy={busy} detecting={detecting} canSave={canSave} onSave={save} onDiscover={discover} t={t} />}
  </div>
}
