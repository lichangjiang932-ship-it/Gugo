import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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
  { id: 'ollama', key: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', kind: 'ollama' },
  { id: 'lm-studio', key: 'lm-studio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', kind: 'lmstudio' },
  // llama.cpp 默认不声明支持 tools —— 它的 server 支不支持取决于启动参数和
  // chat template,发了不支持的 tools 会整轮 400。留 kind 让后端按保守值推断。
  { id: 'llamacpp', key: 'llamacpp', label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1', kind: 'llamacpp' },
  { id: 'vllm', key: 'vllm', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', kind: 'vllm' },
])

const KIND_OPTIONS = ['', 'ollama', 'lmstudio', 'llamacpp', 'vllm', 'openai-compatible']

/** 三态能力开关:'' = 自动推断 / '1' = 支持 / '0' = 不支持 */
const TRIBOOL_VALUES = ['', '1', '0']

function emptyProvider() {
  return {
    id: '', key: '', label: '', baseUrl: '', apiKey: '', modelsText: '', defaultModel: '',
    headersText: '', enabled: true, isDefault: false,
    // v28 能力字段,全部留空 = 自动检测
    kind: '', contextWindow: '', supportsTools: '', supportsStreaming: '', supportsVision: '',
    firstTokenTimeoutMs: '', idleTimeoutMs: '', failoverEnabled: '', keepAlive: '',
  }
}

/** DB 的 true/false/null 转成 select 用的 ''/'1'/'0' */
function triboolToSelect(value) {
  if (value === null || value === undefined) return ''
  return value ? '1' : '0'
}

/** select 的 ''/'1'/'0' 转回提交用的 null/true/false */
function selectToTribool(value) {
  if (value === '') return null
  return value === '1'
}

function numberOrNull(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const num = Number(text)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null
}

function toEditor(provider) {
  return {
    ...provider,
    apiKey: '',
    modelsText: (provider.models || []).join('\n'),
    headersText: '',
    kind: provider.kind || '',
    contextWindow: provider.contextWindow ?? '',
    supportsTools: triboolToSelect(provider.supportsTools),
    supportsStreaming: triboolToSelect(provider.supportsStreaming),
    supportsVision: triboolToSelect(provider.supportsVision),
    firstTokenTimeoutMs: provider.firstTokenTimeoutMs ?? '',
    idleTimeoutMs: provider.idleTimeoutMs ?? '',
    failoverEnabled: triboolToSelect(provider.failoverEnabled),
    keepAlive: provider.keepAlive || '',
  }
}

/**
 * 预览「实际会请求哪个地址」。
 *
 * ★ 后端会给本地端点自动补 /v1(用户填 http://localhost:11434 时),
 * 但原来这个补全对用户完全不可见 —— 填错了也不知道自己填的和实际发的不一样。
 * 这里用同样的规则做个预览。
 */
function effectiveUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const isLoopback = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(url.hostname)
    const path = url.pathname.replace(/\/+$/, '')
    if (isLoopback && (path === '' || path === '/')) {
      url.pathname = '/v1'
      return `${url.toString().replace(/\/+$/, '')}/chat/completions`
    }
    return `${raw}/chat/completions`
  } catch {
    return raw
  }
}

export default function ModelProvidersPanel({ onChanged }) {
  const { t } = useT()
  const [providers, setProviders] = useState([])
  const [editing, setEditing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [diagnostics, setDiagnostics] = useState(null)

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
        // v28 能力字段。空字符串 → null(交给后端自动推断),不是 0。
        kind: editing.kind || null,
        contextWindow: numberOrNull(editing.contextWindow),
        supportsTools: selectToTribool(editing.supportsTools),
        supportsStreaming: selectToTribool(editing.supportsStreaming),
        supportsVision: selectToTribool(editing.supportsVision),
        firstTokenTimeoutMs: numberOrNull(editing.firstTokenTimeoutMs),
        idleTimeoutMs: numberOrNull(editing.idleTimeoutMs),
        failoverEnabled: selectToTribool(editing.failoverEnabled),
        keepAlive: String(editing.keepAlive || '').trim() || null,
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
    setMessage('')
    setDiagnostics({ providerId: provider.id, running: true, steps: [], profile: null })
    try {
      const data = await testModelProvider(provider.id)
      setDiagnostics({
        providerId: provider.id,
        running: false,
        ok: data.ok,
        steps: data.steps || [],
        profile: data.profile || null,
      })
    } catch (error) {
      // ★ 诊断失败本身就是有用的信息 —— 把后端逐项结果显示出来,
      // 而不是像原来那样只弹一句「连不上」让用户自己猜。
      setDiagnostics({
        providerId: provider.id,
        running: false,
        ok: false,
        steps: error?.payload?.steps || [],
        profile: error?.payload?.profile || null,
        error: error.message,
      })
    } finally { setBusy(false) }
  }

  const applyPreset = (preset) => {
    setEditing((current) => ({
      ...current,
      key: current.id ? current.key : preset.key,
      label: current.label || preset.label,
      baseUrl: preset.baseUrl,
      kind: preset.kind || '',
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
      // ★ Ollama 会通过 /api/show 回真实的 context_length / 能力 ——
      // 直接填进表单,用户不用再猜「我这个模型窗口多大」。
      // 猜错(或者不填走 100 万的旧默认值)正是长对话必然 400 的根源。
      const detected = data.detected || null
      setEditing((current) => ({
        ...current,
        modelsText: models.join('\n'),
        defaultModel: models.includes(current.defaultModel) ? current.defaultModel : models[0],
        ...(data.kind && !current.kind ? { kind: data.kind } : {}),
        ...(detected?.contextWindow ? { contextWindow: String(detected.contextWindow) } : {}),
        ...(detected?.supportsTools !== null && detected?.supportsTools !== undefined
          ? { supportsTools: detected.supportsTools ? '1' : '0' } : {}),
        ...(detected?.supportsVision !== null && detected?.supportsVision !== undefined
          ? { supportsVision: detected.supportsVision ? '1' : '0' } : {}),
      }))
      const found = t('modelProviders.discovered').replace('{count}', String(models.length))
      setMessage(detected?.contextWindow
        ? `${found} ${t('modelProviders.detectedFrom')}: ${detected.contextWindow} token`
        : found)
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

      {diagnostics && (
        <div className="border border-ink/15 rounded-md p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink">{t('modelProviders.diagnostics')}</span>
            {diagnostics.running && <span className="text-[11px] text-ink-fade">{t('modelProviders.diagRunning')}</span>}
            <button type="button" onClick={() => setDiagnostics(null)} className="ml-auto p-0.5 text-ink-fade hover:text-ink">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {(diagnostics.steps || []).map((step) => (
            <div key={step.name} className="flex items-start gap-2 text-[11px]">
              <span className={step.ok ? 'text-emerald-700' : step.advisory ? 'text-amber-600' : 'text-rose-700'}>
                {step.ok ? '✓' : step.advisory ? '!' : '✕'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-ink-soft">
                  {step.label}
                  {step.latency ? <span className="text-ink-fade"> · {step.latency} ms</span> : null}
                  {!step.ok && step.advisory ? <span className="text-ink-fade"> · {t('modelProviders.diagAdvisory')}</span> : null}
                </div>
                {!step.ok && (step.error || step.hint) && (
                  <div className="text-ink-fade mt-0.5 break-words">{step.hint || step.error}</div>
                )}
              </div>
            </div>
          ))}
          {diagnostics.profile && (
            <div className="text-[11px] text-ink-fade border-t border-ink/10 pt-2 flex flex-wrap gap-x-3 gap-y-1">
              <span>{diagnostics.profile.kind}</span>
              <span>{t('modelProviders.contextWindow')}: {diagnostics.profile.contextWindow}</span>
              <span>{t('modelProviders.supportsTools')}: {diagnostics.profile.supportsTools ? t('modelProviders.capYes') : t('modelProviders.capNo')}</span>
              <span>{t('modelProviders.firstTokenTimeout')}: {diagnostics.profile.firstTokenTimeoutMs}</span>
              {diagnostics.profile.keepAlive && <span>{t('modelProviders.keepAlive')}: {diagnostics.profile.keepAlive}</span>}
            </div>
          )}
          {diagnostics.error && !diagnostics.steps?.length && (
            <div className="text-[11px] text-rose-700">{diagnostics.error}</div>
          )}
        </div>
      )}

      {editing && createPortal(
        // ★ 必须挂到 body。父级 section 带 animate-float-up,它的 keyframes 用了
        // transform —— 有 transform 的祖先会成为 position:fixed 的包含块,
        // 于是 inset-0 量的是那个 section 而不是视口,弹窗只盖住页面上半部分,
        // 下半截(模型列表、保存按钮)直接被切掉。portal 出去就绕开了这个约束。
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

            {/* ★ 能力与超时。全部留空 = 自动检测(endpointProfile.js 按端点类型推断)。
                这些原来只有全局 env 一份,同时接本地和云端时必然有一边配不对:
                按云端配 → 本地模型正在吐字就被砍断;按本地配 → 云端白等十分钟。 */}
            <div className="flex flex-col gap-3 p-3 rounded-md border border-ink-fade/30 bg-paper-2">
              <div>
                <div className="text-xs font-medium text-ink">{t('modelProviders.capsTitle')}</div>
                <div className="text-[11px] text-ink-fade mt-0.5">{t('modelProviders.capsHint')}</div>
              </div>
              {editing.baseUrl.trim() && (
                <div className="text-[11px] text-ink-fade break-all">
                  {t('modelProviders.effectiveUrl')}: <code>{effectiveUrl(editing.baseUrl)}</code>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label={t('modelProviders.kind')}>
                  <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })}>
                    {KIND_OPTIONS.map((kind) => (
                      <option key={kind || 'auto'} value={kind}>{kind || t('modelProviders.kindAuto')}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t('modelProviders.contextWindow')}>
                  <input type="number" min="1024" value={editing.contextWindow} onChange={(e) => setEditing({ ...editing, contextWindow: e.target.value })} placeholder="8192" />
                </Field>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <TriboolField label={t('modelProviders.supportsTools')} value={editing.supportsTools} onChange={(value) => setEditing({ ...editing, supportsTools: value })} t={t} />
                <TriboolField label={t('modelProviders.supportsStreaming')} value={editing.supportsStreaming} onChange={(value) => setEditing({ ...editing, supportsStreaming: value })} t={t} />
                <TriboolField label={t('modelProviders.supportsVision')} value={editing.supportsVision} onChange={(value) => setEditing({ ...editing, supportsVision: value })} t={t} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label={t('modelProviders.firstTokenTimeout')}>
                  <input type="number" min="1000" value={editing.firstTokenTimeoutMs} onChange={(e) => setEditing({ ...editing, firstTokenTimeoutMs: e.target.value })} placeholder="600000" />
                </Field>
                <Field label={t('modelProviders.idleTimeout')}>
                  <input type="number" min="1000" value={editing.idleTimeoutMs} onChange={(e) => setEditing({ ...editing, idleTimeoutMs: e.target.value })} placeholder="120000" />
                </Field>
              </div>
              {(editing.kind === 'ollama' || /:11434/.test(editing.baseUrl)) && (
                <Field label={`${t('modelProviders.keepAlive')} · ${t('modelProviders.keepAliveHint')}`}>
                  <input value={editing.keepAlive} onChange={(e) => setEditing({ ...editing, keepAlive: e.target.value })} placeholder="30m" />
                </Field>
              )}
              <Field label={t('modelProviders.failoverEnabled')}>
                <select value={editing.failoverEnabled} onChange={(e) => setEditing({ ...editing, failoverEnabled: e.target.value })}>
                  {TRIBOOL_VALUES.map((value) => (
                    <option key={value || 'auto'} value={value}>
                      {value === '' ? t('modelProviders.capAuto') : value === '1' ? t('modelProviders.capYes') : t('modelProviders.capNo')}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="text-[11px] text-ink-fade">{t('modelProviders.failoverHint')}</div>
            </div>

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
        </div>,
        document.body,
      )}
    </div>
  )
}

function Field({ label, children }) {
  return <label className="text-xs text-ink-soft flex flex-col gap-1">{label}<span className="[&_input]:w-full [&_input]:h-9 [&_input]:px-3 [&_input]:bg-paper-2 [&_input]:border [&_input]:border-ink/15 [&_input]:rounded-md [&_select]:w-full [&_select]:h-9 [&_select]:px-3 [&_select]:bg-paper-2 [&_select]:border [&_select]:border-ink/15 [&_select]:rounded-md [&_textarea]:w-full [&_textarea]:p-3 [&_textarea]:bg-paper-2 [&_textarea]:border [&_textarea]:border-ink/15 [&_textarea]:rounded-md [&_textarea]:font-mono">{children}</span></label>
}

/** 三态能力下拉:自动 / 支持 / 不支持。「自动」是留空,交给后端按端点类型推断。 */
function TriboolField({ label, value, onChange, t }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {TRIBOOL_VALUES.map((option) => (
          <option key={option || 'auto'} value={option}>
            {option === '' ? t('modelProviders.capAuto') : option === '1' ? t('modelProviders.capYes') : t('modelProviders.capNo')}
          </option>
        ))}
      </select>
    </Field>
  )
}
