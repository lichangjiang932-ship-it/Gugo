import { useState } from 'react'
import { ChevronDown, Cloud, RefreshCw, Save, X } from 'lucide-react'
import Modal from '../Modal.jsx'
import {
  CLOUD_PRESETS, effectiveUrl, emptyProvider, findConfiguredPresetProvider, formatContextTokens, KIND_OPTIONS, LOCAL_PRESETS,
  nextCustomProviderKey, PROVIDER_PRESETS, toEditor, TRIBOOL_VALUES,
} from './providerConfig.js'

function Field({ label, children, error = '' }) {
  return <label className="text-xs text-ink-soft flex flex-col gap-1">{label}<span className={`[&_input]:w-full [&_input]:h-9 [&_input]:px-3 [&_input]:bg-paper-2 [&_input]:border [&_input]:rounded-md [&_select]:w-full [&_select]:h-9 [&_select]:px-3 [&_select]:bg-paper-2 [&_select]:border [&_select]:rounded-md [&_textarea]:w-full [&_textarea]:p-3 [&_textarea]:bg-paper-2 [&_textarea]:border [&_textarea]:rounded-md [&_textarea]:font-mono ${error ? '[&_input]:border-danger/50 [&_select]:border-danger/50 [&_textarea]:border-danger/50' : '[&_input]:border-ink/15 [&_select]:border-ink/15 [&_textarea]:border-ink/15'}`}>{children}</span>{error && <span className="text-danger" role="alert">{error}</span>}</label>
}

function SavedHeaders({ editing, setEditing, t }) {
  const keys = Array.isArray(editing.savedHeaderKeys)
    ? editing.savedHeaderKeys.map((key) => String(key || '').trim()).filter(Boolean)
    : []
  if (!keys.length) return null
  const removed = new Set((Array.isArray(editing.removedHeaderKeys) ? editing.removedHeaderKeys : [])
    .map((key) => String(key || '').trim().toLowerCase()).filter(Boolean))
  const toggleRemoved = (key) => {
    const normalized = key.toLowerCase()
    const next = new Set(removed)
    if (next.has(normalized)) next.delete(normalized)
    else next.add(normalized)
    setEditing({
      ...editing,
      clearHeaders: false,
      removedHeaderKeys: keys.filter((savedKey) => next.has(savedKey.toLowerCase())),
    })
  }
  return <div className="rounded-md border border-ink/15 bg-paper-2 p-3 text-xs text-ink-soft">
    <div className="font-medium text-ink">{t('modelProviders.headers')}</div>
    <div className="mt-2 flex flex-wrap gap-2" data-saved-provider-headers>
      {keys.map((key) => {
        const willRemove = editing.clearHeaders === true || removed.has(key.toLowerCase())
        return <span key={key} className={`inline-flex items-center gap-1 rounded bg-paper px-2 py-1 ${willRemove ? 'text-ink-fade line-through' : 'text-ink-soft'}`}>
          <code>{key}: ••••••••</code>
          <button
            type="button"
            disabled={editing.clearHeaders === true}
            aria-label={t(willRemove ? 'modelProviders.restoreSavedHeader' : 'modelProviders.removeSavedHeader', { key })}
            title={t(willRemove ? 'modelProviders.restoreSavedHeader' : 'modelProviders.removeSavedHeader', { key })}
            onClick={() => toggleRemoved(key)}
            className="ml-1 no-underline disabled:opacity-40"
          >{willRemove ? '↶' : '×'}</button>
        </span>
      })}
    </div>
    <label className="mt-3 flex items-start gap-2">
      <input
        type="checkbox"
        aria-label={t('modelProviders.clearHeaders')}
        checked={editing.clearHeaders === true}
        onChange={(event) => setEditing({
          ...editing,
          clearHeaders: event.target.checked,
          removedHeaderKeys: event.target.checked ? keys : [],
          headersText: event.target.checked ? '' : editing.headersText,
        })}
      />
      <span><span className="block text-danger">{t('modelProviders.clearHeaders')}</span><span className="block text-ink-fade">{t('modelProviders.clearHeadersHint')}</span></span>
    </label>
  </div>
}

function TriboolField({ label, value, onChange, t }) {
  return <Field label={label}><select value={value} onChange={(event) => onChange(event.target.value)}>
    {TRIBOOL_VALUES.map((option) => <option key={option || 'auto'} value={option}>{option === '' ? t('modelProviders.capAuto') : option === '1' ? t('modelProviders.capYes') : t('modelProviders.capNo')}</option>)}
  </select></Field>
}

function PresetPicker({ editing, setEditing, setShowAdvanced, providers, t }) {
  const presetLabel = (preset) => preset.labelKey ? t(`modelProviders.${preset.labelKey}`) : preset.label
  const applyPreset = (preset) => {
    const caps = preset.caps || {}
    setEditing((current) => {
      if (current.presetId === preset.id) return current
      const existing = current.id ? null : findConfiguredPresetProvider(providers, preset)
      if (existing) return { ...toEditor(existing), presetId: preset.id }
      const fresh = emptyProvider()
      return {
        ...fresh,
        ...(current.id ? {
          id: current.id,
          key: current.key,
          label: current.label,
          enabled: current.enabled,
          isDefault: current.isDefault,
          clearApiKey: Boolean(current.hasApiKey),
          savedHeaderKeys: current.savedHeaderKeys || [],
          removedHeaderKeys: current.savedHeaderKeys || [],
          clearHeaders: Boolean(current.savedHeaderKeys?.length),
        } : {}),
        presetId: preset.id,
        key: current.id ? current.key : preset.key,
        label: current.id ? current.label : presetLabel(preset),
        baseUrl: preset.baseUrl,
        kind: preset.kind || '',
        modelsText: preset.models?.join('\n') || '',
        defaultModel: preset.models?.[0] || '',
        isDefault: current.id ? current.isDefault : true,
        contextWindow: preset.contextWindow != null ? String(preset.contextWindow) : '',
        supportsTools: caps.supportsTools ?? '',
        supportsStreaming: caps.supportsStreaming ?? '',
        supportsVision: caps.supportsVision ?? '',
        supportsPdf: caps.supportsPdf ?? '',
      }
    })
    setShowAdvanced(false)
  }
  const contextBadge = (preset) => {
    const tokens = formatContextTokens(preset.contextWindow)
    if (!tokens) return null
    return <span className="ml-auto shrink-0 rounded bg-paper-2 px-1.5 py-0.5 text-[10px] text-ink-fade">{tokens}</span>
  }
  return <div className="flex flex-col gap-3">
    <div className="flex items-center gap-2 text-xs font-medium text-ink"><Cloud className="h-4 w-4 text-accent-ink" />{t('modelProviders.chooseProvider')}</div>
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{CLOUD_PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => applyPreset(preset)} className={`min-h-14 rounded-lg border px-3 py-2 text-left text-xs flex flex-col gap-1 ${editing.presetId === preset.id ? 'border-accent bg-accent-soft/30 text-ink' : 'border-ink/15 bg-paper hover:border-ink/40 text-ink-soft'}`}><span className="flex items-center gap-2"><span className="font-medium">{presetLabel(preset)}</span>{contextBadge(preset)}</span><span className="text-[10px] text-ink-fade">{preset.models?.length ? t('modelProviders.modelsCount', { count: preset.models.length }) : '—'}</span></button>)}</div>
    <div className="text-xs font-medium text-ink-soft">{t('modelProviders.localPreset')}</div>
    <div className="flex flex-wrap gap-2">
      {LOCAL_PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => applyPreset(preset)} className={`h-8 px-3 rounded-md border text-xs ${editing.presetId === preset.id ? 'border-accent bg-accent-soft/30 text-ink' : 'border-ink-fade/50 bg-paper text-ink hover:border-ink'}`}>{preset.label}</button>)}
      <button type="button" onClick={() => {
        setEditing((current) => {
          if (current.presetId === 'custom') return current
          const fresh = emptyProvider()
          return {
            ...fresh,
            ...(current.id ? {
              id: current.id,
              key: current.key,
              label: current.label,
              enabled: current.enabled,
              isDefault: current.isDefault,
              clearApiKey: Boolean(current.hasApiKey),
              savedHeaderKeys: current.savedHeaderKeys || [],
              removedHeaderKeys: current.savedHeaderKeys || [],
              clearHeaders: Boolean(current.savedHeaderKeys?.length),
            } : {
              key: nextCustomProviderKey(providers),
              label: t('modelProviders.custom'),
              isDefault: true,
            }),
            presetId: 'custom',
          }
        })
        setShowAdvanced(true)
      }} className={`h-8 px-3 rounded-md border text-xs ${editing.presetId === 'custom' ? 'border-accent bg-accent-soft/30' : 'border-ink-fade/50 bg-paper'}`}>{t('modelProviders.custom')}</button>
    </div>
  </div>
}

function CapabilityFields({
  editing,
  setEditing,
  contextWindowError = '',
  firstTokenTimeoutError = '',
  idleTimeoutError = '',
  modelContextErrors = {},
  t,
}) {
  const models = [...new Set(editing.modelsText.split(/[\n,]/).map((model) => model.trim()).filter(Boolean))]
  const updateModelContext = (model, value) => {
    const modelProfiles = { ...(editing.modelProfiles || {}) }
    const current = modelProfiles[model] && typeof modelProfiles[model] === 'object'
      ? modelProfiles[model]
      : {}
    if (value === '') {
      const next = { ...current }
      delete next.contextWindow
      if (Object.keys(next).length) modelProfiles[model] = next
      else delete modelProfiles[model]
    } else {
      modelProfiles[model] = { ...current, contextWindow: Number(value) }
    }
    setEditing({ ...editing, modelProfiles })
  }
  return <div className="flex flex-col gap-3 p-3 rounded-md border border-ink-fade/30 bg-paper-2">
    <div><div className="text-xs font-medium text-ink">{t('modelProviders.capsTitle')}</div><div className="text-xs text-ink-fade mt-0.5">{t('modelProviders.capsHint')}</div></div>
    {editing.baseUrl.trim() && <div className="text-xs text-ink-fade break-all">{t('modelProviders.effectiveUrl')}: <code>{effectiveUrl(editing.baseUrl)}</code></div>}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Field label={t('modelProviders.kind')}><select value={editing.kind} onChange={(event) => setEditing({ ...editing, kind: event.target.value })}>{KIND_OPTIONS.map((kind) => <option key={kind || 'auto'} value={kind}>{kind || t('modelProviders.kindAuto')}</option>)}</select></Field>
      <Field label={t('modelProviders.contextWindow')} error={contextWindowError}><input aria-invalid={Boolean(contextWindowError)} type="number" min="1024" step="1" value={editing.contextWindow} onChange={(event) => setEditing({ ...editing, contextWindow: event.target.value })} placeholder="8192" /></Field>
    </div>
    {models.length > 0 && <div className="flex flex-col gap-2">
      <div className="text-xs text-ink-fade">{t('modelProviders.contextWindow')} / model</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {models.map((model) => <Field key={model} label={model} error={modelContextErrors[model]}><input aria-invalid={Boolean(modelContextErrors[model])} type="number" min="1024" step="1" value={editing.modelProfiles?.[model]?.contextWindow ?? ''} onChange={(event) => updateModelContext(model, event.target.value)} placeholder={editing.contextWindow || '128000'} /></Field>)}
      </div>
    </div>}
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
      {['supportsTools', 'supportsStreaming', 'supportsVision', 'supportsPdf'].map((key) => <TriboolField key={key} label={t(`modelProviders.${key}`)} value={editing[key]} onChange={(value) => setEditing({ ...editing, [key]: value })} t={t} />)}
    </div>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Field label={t('modelProviders.firstTokenTimeout')} error={firstTokenTimeoutError}><input aria-invalid={Boolean(firstTokenTimeoutError)} type="number" min="1000" step="1" value={editing.firstTokenTimeoutMs} onChange={(event) => setEditing({ ...editing, firstTokenTimeoutMs: event.target.value })} placeholder="600000" /></Field>
      <Field label={t('modelProviders.idleTimeout')} error={idleTimeoutError}><input aria-invalid={Boolean(idleTimeoutError)} type="number" min="1000" step="1" value={editing.idleTimeoutMs} onChange={(event) => setEditing({ ...editing, idleTimeoutMs: event.target.value })} placeholder="120000" /></Field>
    </div>
    {(editing.kind === 'ollama' || /:11434/.test(editing.baseUrl)) && <Field label={`${t('modelProviders.keepAlive')} · ${t('modelProviders.keepAliveHint')}`}><input value={editing.keepAlive} onChange={(event) => setEditing({ ...editing, keepAlive: event.target.value })} placeholder="30m" /></Field>}
    <Field label={t('modelProviders.failoverEnabled')}><select value={editing.failoverEnabled} onChange={(event) => setEditing({ ...editing, failoverEnabled: event.target.value })}>{TRIBOOL_VALUES.map((value) => <option key={value || 'auto'} value={value}>{value === '' ? t('modelProviders.capAuto') : value === '1' ? t('modelProviders.capYes') : t('modelProviders.capNo')}</option>)}</select></Field>
    <div className="text-xs text-ink-fade">{t('modelProviders.failoverHint')}</div>
  </div>
}

export default function ProviderEditor({
  editing, setEditing, providers = [], busy, detecting, canSave, keyError = '', labelError = '', baseUrlError = '',
  modelsError = '', headersError = '', contextWindowError = '', firstTokenTimeoutError = '', idleTimeoutError = '',
  modelContextErrors = {}, message = '', onSave, onDiscover, portalTarget, t,
}) {
  const [showAdvanced, setShowAdvanced] = useState(editing.presetId === 'custom')
  const [touchedFields, setTouchedFields] = useState({})
  const selectedPreset = PROVIDER_PRESETS.find((preset) => preset.id === editing.presetId)
  const isLocalPreset = selectedPreset?.local === true
  const isCloudPreset = Boolean(selectedPreset && !isLocalPreset)
  const isLocalOrCustom = isLocalPreset || editing.presetId === 'custom'
  const modelList = [...new Set(String(editing.modelsText || '').split(/[\n,]/).map((model) => model.trim()).filter(Boolean))]
  const selectedModel = modelList.includes(editing.defaultModel) ? editing.defaultModel : (modelList[0] || '')
  const updateSingleModel = (value) => setEditing({ ...editing, modelsText: value, defaultModel: value })
  const canDiscover = isLocalOrCustom && editing.baseUrl.trim() && !baseUrlError && !headersError
  const touchField = (field) => setTouchedFields((current) => (
    current[field] ? current : { ...current, [field]: true }
  ))
  const visibleError = (field, error) => touchedFields[field] ? error : ''
  const visibleBaseUrlError = visibleError('baseUrl', baseUrlError)
  const visibleModelsError = visibleError('models', modelsError)
  const visibleHeadersError = visibleError('headers', headersError)
  const visibleKeyError = visibleError('key', keyError)
  const visibleLabelError = visibleError('label', labelError)
  return <Modal
    onClose={() => setEditing(null)}
    closeOnBackdrop={false}
    ariaLabel={t('modelProviders.editor')}
    dataModalLayer="nested"
    portalTarget={portalTarget}
    overlayClassName="items-start sm:items-center"
    className="w-[620px] max-w-full max-h-[92vh] my-auto border-ink/20 flex flex-col overflow-hidden"
  >
      <div className="flex items-center shrink-0 px-5 pt-5 pb-3 border-b border-ink/10"><div className="font-semibold text-ink flex-1">{t('modelProviders.editor')}</div><button type="button" onClick={() => setEditing(null)}><X className="w-4 h-4" /></button></div>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        {!editing.presetId ? (
          <PresetPicker editing={editing} setEditing={setEditing} setShowAdvanced={setShowAdvanced} providers={providers} t={t} />
        ) : <div className="flex items-center gap-3 rounded-lg border border-ink/10 bg-paper-2 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-ink">{editing.label || selectedPreset?.label || t('modelProviders.custom')}</div>
            <div className="mt-0.5 text-xs text-ink-fade">{isCloudPreset ? t('modelProviders.presetFilled') : isLocalPreset ? t('modelProviders.localDetectHint') : t('modelProviders.custom')}</div>
          </div>
          {!editing.id && <button type="button" onClick={() => { setEditing(emptyProvider()); setShowAdvanced(false) }} className="shrink-0 text-xs text-ink-soft hover:text-ink">{t('modelProviders.chooseProvider')}</button>}
        </div>}
        {editing.presetId && <div className="flex flex-col gap-4 rounded-xl border border-ink/15 p-4">
          {isLocalOrCustom && <Field label="Base URL" error={visibleBaseUrlError}><input aria-invalid={Boolean(visibleBaseUrlError)} value={editing.baseUrl} onInput={(event) => { touchField('baseUrl'); setEditing({ ...editing, baseUrl: event.currentTarget.value }) }} placeholder="https://api.example.com/v1" /></Field>}
          <Field label={`API Key${isLocalOrCustom ? ` · ${t('modelProviders.optional')}` : ''}${editing.hasApiKey ? ` · ${t('modelProviders.keepSecret')}` : ''}`}><input type="password" disabled={Boolean(editing.hasApiKey && editing.clearApiKey)} value={editing.apiKey} onInput={(event) => setEditing({ ...editing, apiKey: event.currentTarget.value, clearApiKey: false })} placeholder={editing.hasApiKey ? '••••••••' : isLocalPreset ? t('modelProviders.localNoKey') : t('modelProviders.apiKeyPlaceholder')} /></Field>
          {editing.hasApiKey && <label className="flex items-start gap-2 text-xs text-ink-soft"><input type="checkbox" checked={editing.clearApiKey} onChange={(event) => setEditing({ ...editing, clearApiKey: event.target.checked, apiKey: event.target.checked ? '' : editing.apiKey })} /><span><span className="block text-danger">{t('modelProviders.clearApiKey')}</span><span className="block text-ink-fade">{t('modelProviders.clearApiKeyHint')}</span></span></label>}
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              {modelList.length > 1 || isCloudPreset ? (
                <Field label={t('modelProviders.defaultModel')} error={visibleModelsError}><select aria-invalid={Boolean(visibleModelsError)} value={selectedModel} onChange={(event) => { touchField('models'); setEditing({ ...editing, defaultModel: event.target.value }) }}>{modelList.map((model) => <option key={model} value={model}>{model}{selectedPreset?.legacyModels?.includes(model) ? ' · legacy' : ''}</option>)}</select></Field>
              ) : (
                <Field label={t('modelProviders.defaultModel')} error={visibleModelsError}><input aria-invalid={Boolean(visibleModelsError)} value={selectedModel} onInput={(event) => { touchField('models'); updateSingleModel(event.currentTarget.value) }} placeholder="model-name" /></Field>
              )}
            </div>
            {isLocalOrCustom && <button type="button" disabled={busy || detecting || !canDiscover} onClick={onDiscover} className="mb-0.5 inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-ink/20 px-3 text-xs text-ink-soft hover:bg-ink/[0.04] hover:text-ink disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${detecting ? 'animate-spin' : ''}`} />{detecting ? t('modelProviders.detecting') : t('modelProviders.discover')}</button>}
          </div>
        </div>}
        {editing.presetId && <button type="button" onClick={() => setShowAdvanced((value) => !value)} className="flex items-center gap-2 text-xs text-ink-soft hover:text-ink self-start"><ChevronDown className={`h-4 w-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />{t('modelProviders.advanced')}</button>}
        {editing.presetId && showAdvanced && <div className="flex flex-col gap-3 rounded-xl border border-ink/15 p-4">
          {isCloudPreset && <Field label="Base URL" error={visibleBaseUrlError}><input aria-invalid={Boolean(visibleBaseUrlError)} value={editing.baseUrl} onInput={(event) => { touchField('baseUrl'); setEditing({ ...editing, baseUrl: event.currentTarget.value }) }} placeholder="https://api.example.com/v1" /></Field>}
          <Field label={t('modelProviders.models')} error={visibleModelsError}><textarea aria-invalid={Boolean(visibleModelsError)} rows="3" value={editing.modelsText} onInput={(event) => { touchField('models'); setEditing({ ...editing, modelsText: event.currentTarget.value }) }} placeholder={'model-a\nmodel-b'} /></Field>
          <SavedHeaders editing={editing} setEditing={setEditing} t={t} />
          <Field label={t('modelProviders.headers')} error={visibleHeadersError}><textarea aria-invalid={Boolean(visibleHeadersError)} rows="3" value={editing.headersText} onInput={(event) => { touchField('headers'); setEditing({ ...editing, headersText: event.currentTarget.value, clearHeaders: false }) }} placeholder={'{"X-Custom-Header":"value"}'} /></Field>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3"><Field label="Provider ID" error={visibleKeyError}><input aria-invalid={Boolean(visibleKeyError)} disabled={!!editing.id} maxLength="40" value={editing.key} onInput={(event) => { touchField('key'); setEditing({ ...editing, key: event.currentTarget.value.toLowerCase() }) }} placeholder="my-provider" /></Field><Field label={t('modelProviders.name')} error={visibleLabelError}><input aria-invalid={Boolean(visibleLabelError)} value={editing.label} onInput={(event) => { touchField('label'); setEditing({ ...editing, label: event.currentTarget.value }) }} placeholder="My Provider" /></Field></div>
          <CapabilityFields
            editing={editing}
            setEditing={setEditing}
            contextWindowError={contextWindowError}
            firstTokenTimeoutError={firstTokenTimeoutError}
            idleTimeoutError={idleTimeoutError}
            modelContextErrors={modelContextErrors}
            t={t}
          />
          <div className="flex gap-4 text-xs text-ink-soft"><label><input type="checkbox" checked={editing.enabled} onChange={(event) => setEditing({ ...editing, enabled: event.target.checked })} /> {t('modelProviders.enabled')}</label><label><input type="checkbox" checked={editing.isDefault} onChange={(event) => setEditing({ ...editing, isDefault: event.target.checked })} /> {t('modelProviders.makeDefault')}</label></div>
        </div>}
      </div>
      {message && <div data-model-provider-editor-message role="status" aria-live="polite" className="shrink-0 mx-5 mt-3 rounded-md border border-ink/15 bg-paper-2 px-3 py-2 text-xs text-ink-soft">{message}</div>}
      <div className="flex justify-end gap-2 shrink-0 px-5 py-4 border-t border-ink/10 bg-paper">
        {editing.presetId && <button type="button" disabled={busy || detecting || !canSave} onClick={onSave} className="h-9 px-4 bg-accent text-accent-contrast rounded-md text-sm flex items-center gap-1 disabled:opacity-40"><Save className="w-4 h-4" />{t('modelProviders.save')}</button>}
      </div>
  </Modal>
}
