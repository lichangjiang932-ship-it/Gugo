import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Pencil, Plus, RefreshCw, Save, Server, Trash2, X } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import {
  deleteModelProvider,
  discoverModelProvider,
  listModelProviders,
  saveModelProvider,
  testModelProvider,
} from '../lib/modelClient.js'

const LOCAL_PRESETS = Object.freeze([
  { id: 'ollama', key: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { id: 'lm-studio', key: 'lm-studio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
])

function emptyProvider() {
  return {
    id: '', key: '', label: '', baseUrl: '', apiKey: '', modelsText: '', defaultModel: '',
    headersText: '', enabled: true, isDefault: false,
  }
}

function toEditor(provider) {
  return {
    ...provider,
    apiKey: '',
    modelsText: (provider.models || []).join('\n'),
    headersText: '',
  }
}

export default function ModelProvidersPanel({ onChanged }) {
  const { t } = useT()
  const [providers, setProviders] = useState([])
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [detecting, setDetecting] = useState(false)

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
      let headers
      if (editing.headersText.trim()) headers = JSON.parse(editing.headersText)
      await saveModelProvider({
        id: editing.id || undefined,
        key: editing.key,
        label: editing.label,
        baseUrl: editing.baseUrl,
        apiKey: editing.apiKey,
        models,
        defaultModel: editing.defaultModel || models[0],
        enabled: editing.enabled,
        isDefault: editing.isDefault,
        ...(headers ? { headers } : {}),
      })
      setEditing(null)
      await reload()
      notifyChanged()
      setMessage(t('modelProviders.saved'))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setBusy(false)
    }
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
    setMessage(t('modelProviders.testing'))
    try {
      const data = await testModelProvider(provider.id)
      setMessage(`${t('modelProviders.testOk')} ${data.endpoint?.latency ?? 0} ms`)
    } catch (error) { setMessage(error.message) } finally { setBusy(false) }
  }

  const applyPreset = (preset) => {
    setEditing((current) => ({
      ...current,
      key: current.id ? current.key : preset.key,
      label: current.label || preset.label,
      baseUrl: preset.baseUrl,
    }))
    setMessage('')
  }

  const discover = async () => {
    if (!editing?.baseUrl?.trim()) return
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
      })
      const models = data.models || data.endpoint?.remoteModels || []
      if (!models.length) throw new Error(t('modelProviders.noModels'))
      setEditing((current) => ({
        ...current,
        modelsText: models.join('\n'),
        defaultModel: models.includes(current.defaultModel) ? current.defaultModel : models[0],
      }))
      setMessage(t('modelProviders.discovered').replace('{count}', String(models.length)))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="border border-ink/20 rounded-md bg-paper p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Server className="w-4 h-4 text-ember mt-0.5" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-ink">{t('modelProviders.title')}</div>
          <div className="text-xs text-ink-fade mt-0.5">{t('modelProviders.subtitle')}</div>
        </div>
        <button type="button" onClick={() => setEditing(emptyProvider())} className="h-8 px-3 bg-ink text-paper rounded-md text-xs flex items-center gap-1">
          <Plus className="w-3.5 h-3.5" />{t('modelProviders.add')}
        </button>
      </div>

      {providers.map((provider) => (
        <div key={provider.id} className="border border-ink/15 rounded-md p-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-sm text-ink">
              <span className="font-medium">{provider.label}</span>
              <code className="text-[10px] text-ink-fade">{provider.key}</code>
              {provider.isDefault && <span className="text-[10px] text-emerald-700 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{t('modelProviders.default')}</span>}
            </div>
            <div className="text-[11px] text-ink-fade truncate mt-1">{provider.baseUrl} · {(provider.models || []).join(', ')}</div>
          </div>
          <button type="button" disabled={busy} onClick={() => test(provider)} className="text-xs text-ember hover:underline">{t('modelProviders.test')}</button>
          <button type="button" onClick={() => setEditing(toEditor(provider))} className="p-1 text-ink-fade hover:text-ink"><Pencil className="w-3.5 h-3.5" /></button>
          <button type="button" onClick={() => remove(provider)} className="p-1 text-rose-700"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      ))}
      {!providers.length && <div className="text-xs text-ink-fade py-3 text-center">{t('modelProviders.empty')}</div>}
      {message && <div className="text-xs text-ink-soft border border-ink/10 rounded-md p-2">{message}</div>}

      {editing && (
        <div className="fixed inset-0 z-50 bg-ink/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto">
          <div className="w-[620px] max-w-full max-h-[92vh] my-auto bg-paper border border-ink/20 rounded-md flex flex-col overflow-hidden">
            {/* 标题栏固定,不随表单滚动 */}
            <div className="flex items-center shrink-0 px-5 pt-5 pb-3 border-b border-ink/10">
              <div className="font-semibold text-ink flex-1">{t('modelProviders.editor')}</div>
              <button type="button" onClick={() => setEditing(null)}><X className="w-4 h-4" /></button>
            </div>
            {/* 只有表单区滚动,长内容不会把标题和保存按钮顶出视口 */}
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-3">
            <div className="flex flex-col gap-2 p-3 rounded-md border border-ink-fade/30 bg-paper-2">
              <span className="text-xs text-ink-soft">{t('modelProviders.localPreset')}</span>
              <div className="flex flex-wrap gap-2">
                {LOCAL_PRESETS.map((preset) => (
                  <button key={preset.id} type="button" onClick={() => applyPreset(preset)} className="h-8 px-3 rounded-md border border-ink-fade/50 bg-paper text-xs text-ink hover:border-ink">
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Provider ID"><input disabled={!!editing.id} value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value.toLowerCase() })} placeholder="my-provider" /></Field>
              <Field label={t('modelProviders.name')}><input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} placeholder="My Provider" /></Field>
            </div>
            <Field label="Base URL"><input value={editing.baseUrl} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
            <Field label={`API Key · ${t('modelProviders.optional')}${editing.hasApiKey ? ` (${t('modelProviders.keepSecret')})` : ''}`}><input type="password" value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} placeholder={editing.hasApiKey ? '••••••••' : t('modelProviders.localNoKey')} /></Field>
            <Field label={t('modelProviders.models')}><textarea rows="4" value={editing.modelsText} onChange={(e) => setEditing({ ...editing, modelsText: e.target.value })} placeholder={'model-a\nmodel-b'} /></Field>
            <Field label={t('modelProviders.defaultModel')}><input value={editing.defaultModel} onChange={(e) => setEditing({ ...editing, defaultModel: e.target.value })} placeholder="model-a" /></Field>
            <Field label={t('modelProviders.headers')}><textarea rows="3" value={editing.headersText} onChange={(e) => setEditing({ ...editing, headersText: e.target.value })} placeholder={'{"X-Custom-Header":"value"}'} /></Field>
            <div className="flex gap-4 text-xs text-ink-soft">
              <label><input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> {t('modelProviders.enabled')}</label>
              <label><input type="checkbox" checked={editing.isDefault} onChange={(e) => setEditing({ ...editing, isDefault: e.target.checked })} /> {t('modelProviders.makeDefault')}</label>
            </div>
            </div>
            {/* 操作栏固定在底部,表单再长也点得到保存 */}
            <div className="flex justify-end gap-2 shrink-0 px-5 py-4 border-t border-ink/10 bg-paper">
              <button type="button" disabled={busy || detecting || !editing.baseUrl.trim()} onClick={discover} className="h-9 px-4 border border-ink/50 text-ink rounded-md text-sm flex items-center gap-1 disabled:opacity-40"><RefreshCw className={`w-4 h-4 ${detecting ? 'animate-spin' : ''}`} />{detecting ? t('modelProviders.detecting') : t('modelProviders.discover')}</button>
              <button type="button" disabled={busy || detecting} onClick={save} className="h-9 px-4 bg-ember text-paper rounded-md text-sm flex items-center gap-1 disabled:opacity-40"><Save className="w-4 h-4" />{t('modelProviders.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }) {
  return <label className="text-xs text-ink-soft flex flex-col gap-1">{label}<span className="[&_input]:w-full [&_input]:h-9 [&_input]:px-3 [&_input]:bg-paper-2 [&_input]:border [&_input]:border-ink/15 [&_input]:rounded-md [&_textarea]:w-full [&_textarea]:p-3 [&_textarea]:bg-paper-2 [&_textarea]:border [&_textarea]:border-ink/15 [&_textarea]:rounded-md [&_textarea]:font-mono">{children}</span></label>
}
