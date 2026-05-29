// ★ U1: 集成 UI + 视觉副驾 UI
// ★ T2: 微信扫码 —— 倒计时 + 自动轮询 + 错误提示 + 重试
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  Check,
  ChevronDown,
  Circle,
  MessageCircle,
  Pencil,
  Plug,
  Plus,
  TestTube2,
  Trash2,
  X,
} from 'lucide-react'
import {
  deleteIntegrationApi,
  fetchVisionAssistStatus,
  getWechatQrcodeApi,
  pollWechatQrcodeApi,
  listIntegrationsApi,
  listProvidersApi,
  testIntegrationApi,
  toggleIntegrationEnabledApi,
  upsertIntegrationApi,
} from '../lib/integrationsClient.js'
import { createPoller as createWechatQrPoller } from '../lib/wechatQrPoller.js'

const SECRET_SENTINEL = '••••'

function providerIcon(provider) {
  if (provider === 'vision_assist' || provider === 'lark_bot') return Bot
  if (['feishu', 'wechat_official', 'wechat_personal', 'dingtalk', 'qq', 'discord', 'telegram', 'slack'].includes(provider)) return MessageCircle
  return Plug
}

function fieldLabel(key) {
  return String(key || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function inferFieldType(key, secret) {
  const normalized = String(key || '').toLowerCase()
  if (secret || normalized.includes('secret') || normalized.includes('token') || normalized.includes('key')) return 'password'
  if (normalized === 'method' || normalized === 'language') return 'select'
  if (normalized.includes('url')) return 'url'
  return 'text'
}

function inferOptions(key) {
  const normalized = String(key || '').toLowerCase()
  if (normalized === 'method') return ['POST', 'GET']
  if (normalized === 'language') return ['zh', 'en', 'ja', 'ko', 'zh-TW']
  return []
}

function normalizeFields(meta) {
  const fields = meta?.fields
  if (Array.isArray(fields)) {
    return fields.map((field) => {
      const key = field.key || field.name || field.id
      const secret = field.secret || field.location === 'secret' || field.type === 'password'
      return {
        key,
        label: field.label || fieldLabel(key),
        type: field.type || inferFieldType(key, secret),
        location: secret ? 'secret' : 'config',
        options: field.options || inferOptions(key),
        optional: !!field.optional,
      }
    }).filter((field) => field.key)
  }

  const configFields = (fields?.config || []).map((key) => ({
    key,
    label: fieldLabel(key),
    type: inferFieldType(key, false),
    location: 'config',
    options: inferOptions(key),
    optional: false,
  }))
  const secretFields = (fields?.secret || []).map((key) => ({
    key,
    label: fieldLabel(key),
    type: 'password',
    location: 'secret',
    options: [],
    optional: false,
  }))
  const optionalConfigFields = (fields?.optional?.config || []).map((key) => ({
    key,
    label: fieldLabel(key),
    type: inferFieldType(key, false),
    location: 'config',
    options: inferOptions(key),
    optional: true,
  }))
  const optionalSecretFields = (fields?.optional?.secret || []).map((key) => ({
    key,
    label: fieldLabel(key),
    type: 'password',
    location: 'secret',
    options: [],
    optional: true,
  }))
  return [...configFields, ...secretFields, ...optionalConfigFields, ...optionalSecretFields]
}

function getLastTest(integration) {
  if (integration?.lastTest) return integration.lastTest
  if (integration?.last_test_at) {
    return {
      at: integration.last_test_at,
      ok: integration.last_test_ok,
      message: integration.last_test_message || '',
    }
  }
  return null
}

function formatTestTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

function emptyForm(provider, meta) {
  return {
    id: '',
    provider,
    name: meta?.label || provider,
    enabled: true,
    config: {},
    secret: {},
  }
}

function formFromIntegration(integration, meta) {
  const secret = {}
  for (const field of normalizeFields(meta)) {
    if (field.location === 'secret' && integration.secret?.[field.key]?.present) {
      secret[field.key] = SECRET_SENTINEL
    }
  }
  return {
    id: integration.id,
    provider: integration.provider,
    name: integration.name || meta?.label || integration.provider,
    enabled: integration.enabled !== false,
    config: { ...(integration.config || {}) },
    secret,
  }
}

function Toggle({ enabled, onClick, disabled, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={enabled}
      className={`relative w-10 h-5 rounded-full transition-colors shrink-0 disabled:opacity-50 ${enabled ? 'bg-ember' : 'bg-ink-fade/40'}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  )
}

export default function IntegrationsPanel({ kind, t }) {
  const [providers, setProviders] = useState([])
  const [integrations, setIntegrations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [providerMenuOpen, setProviderMenuOpen] = useState(false)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState('')
  const [testMessage, setTestMessage] = useState('')
  const [wechatQr, setWechatQr] = useState(null)
  // ★ T2: 微信扫码完整状态机
  // phase: 'idle'(还没点) | 'loading'(拿二维码中) | 'ready'(轮询中) | 'success' | 'expired' | 'timeout' | 'error'
  const [wechatState, setWechatState] = useState({
    phase: 'idle',
    secondsLeft: 0,
    expiresAt: 0,
    statusText: '',
    errorText: '',
  })
  const wechatPollerRef = useRef(null)
  const wechatExpiresAtRef = useRef(0)
  // 视觉副驾就绪状态：仅在 kind === 'vision_assist' 时调 probe 拿
  const [visionStatus, setVisionStatus] = useState(null)
  const [visionHintOpen, setVisionHintOpen] = useState(false)

  const visibleProviders = useMemo(
    () => providers.filter((provider) => provider.kind === kind),
    [providers, kind]
  )
  const providersById = useMemo(
    () => Object.fromEntries(providers.map((provider) => [provider.provider, provider])),
    [providers]
  )
  const kindLabel = kind === 'vision_assist' ? t('integrations.kindVisionAssist') : t('integrations.kindSocial')

  const reload = async () => {
    setLoading(true)
    setError('')
    // providers 端点不需要登录，必须独立请求 — 否则一旦 integrations 端点 401 / 网络挂掉，
    // providers 也跟着不会被 set，导致"+ 新建集成"下拉空白、按钮看似无响应。
    let providerErr = ''
    try {
      const providerData = await listProvidersApi()
      setProviders(providerData.providers || [])
    } catch (err) {
      providerErr = err.message || t('errors.loadFailed')
    }
    try {
      const integrationData = await listIntegrationsApi({ kind })
      setIntegrations(integrationData.integrations || [])
    } catch (err) {
      // 未登录 / token 过期等，列表展示为空但仍保留 providers 让用户可以新建
      const msg = err.message || t('errors.loadFailed')
      setError(providerErr ? `${providerErr}; ${msg}` : msg)
      setIntegrations([])
    }
    if (providerErr && !error) setError(providerErr)
    // 视觉副驾：拉 /status 判断徽章状态。失败时静默——不阻塞主面板渲染。
    if (kind === 'vision_assist') {
      try {
        const status = await fetchVisionAssistStatus()
        setVisionStatus(status)
      } catch {
        setVisionStatus(null)
      }
    }
    setLoading(false)
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  const openNew = (provider) => {
    setProviderMenuOpen(false)
    setTestMessage('')
    stopWechatPoller()
    setWechatQr(null)
    setWechatState({ phase: 'idle', secondsLeft: 0, expiresAt: 0, statusText: '', errorText: '' })
    setForm(emptyForm(provider.provider, provider))
  }

  const openEdit = (integration) => {
    setTestMessage('')
    stopWechatPoller()
    setWechatQr(null)
    setWechatState({ phase: 'idle', secondsLeft: 0, expiresAt: 0, statusText: '', errorText: '' })
    setForm(formFromIntegration(integration, providersById[integration.provider]))
  }

  const updateFormValue = (field, value) => {
    setForm((current) => {
      if (!current) return current
      if (field === 'name' || field === 'enabled') return { ...current, [field]: value }
      const bucket = field.location === 'secret' ? 'secret' : 'config'
      return {
        ...current,
        [bucket]: {
          ...current[bucket],
          [field.key]: value,
        },
      }
    })
  }

  const save = async (event) => {
    event.preventDefault()
    if (!form) return
    setSaving(true)
    setTestMessage('')
    try {
      const meta = providersById[form.provider]
      const secret = {}
      for (const field of normalizeFields(meta)) {
        if (field.location !== 'secret') continue
        const value = form.secret?.[field.key]
        if (value !== SECRET_SENTINEL && value !== undefined) secret[field.key] = value
      }
      const data = await upsertIntegrationApi({
        id: form.id || undefined,
        provider: form.provider,
        name: form.name,
        config: form.config,
        secret,
        enabled: form.enabled,
      })
      const next = data.integration
      setIntegrations((current) => {
        if (current.some((item) => item.id === next.id)) {
          return current.map((item) => item.id === next.id ? next : item)
        }
        return [next, ...current]
      })
      setForm(null)
    } catch (err) {
      setTestMessage(err.message || t('errors.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const test = async (id, { inline = false } = {}) => {
    setTestingId(id)
    if (inline) setTestMessage('')
    try {
      const data = await testIntegrationApi(id)
      const result = data.result || {}
      setIntegrations((current) => current.map((item) => {
        if (item.id !== id) return item
        return {
          ...item,
          lastTest: {
            at: Date.now(),
            ok: result.ok !== false,
            message: result.message || '',
          },
        }
      }))
      if (inline) {
        setTestMessage(result.ok === false ? t('integrations.testFail', { msg: result.message || '' }) : t('integrations.testOk'))
      }
    } catch (err) {
      setIntegrations((current) => current.map((item) => {
        if (item.id !== id) return item
        return {
          ...item,
          lastTest: {
            at: Date.now(),
            ok: false,
            message: err.message || '',
          },
        }
      }))
      if (inline) setTestMessage(t('integrations.testFail', { msg: err.message }))
    } finally {
      setTestingId('')
    }
  }

  const toggleEnabled = async (integration, enabled) => {
    const previous = integrations
    setIntegrations((current) => current.map((item) => item.id === integration.id ? { ...item, enabled } : item))
    try {
      const data = await toggleIntegrationEnabledApi(integration.id, enabled)
      setIntegrations((current) => current.map((item) => item.id === integration.id ? data.integration : item))
    } catch (err) {
      setIntegrations(previous)
      setError(err.message || t('errors.saveFailed'))
    }
  }

  const remove = async (integration) => {
    if (!confirm(t('integrations.confirmDelete', { name: integration.name || integration.provider }))) return
    try {
      await deleteIntegrationApi(integration.id)
      setIntegrations((current) => current.filter((item) => item.id !== integration.id))
    } catch (err) {
      setError(err.message || t('errors.deleteFailed'))
    }
  }

  // ★ T2: 停掉正在跑的微信扫码轮询，幂等
  const stopWechatPoller = () => {
    if (wechatPollerRef.current) {
      wechatPollerRef.current.stop()
      wechatPollerRef.current = null
    }
  }

  // ★ T2: 拿一次二维码 + 启动轮询；可重复调用（重试）
  const openWechatQr = async () => {
    stopWechatPoller()
    setTestMessage('')
    setWechatQr(null)
    setWechatState({ phase: 'loading', secondsLeft: 0, expiresAt: 0, statusText: '', errorText: '' })
    let data
    try {
      data = await getWechatQrcodeApi()
    } catch (err) {
      const httpStatus = Number(err?.status) || 0
      let errorText
      if (httpStatus >= 400 && httpStatus < 500) {
        errorText = err?.message || t('wechat.qr.serverError')
      } else if (httpStatus >= 500) {
        errorText = t('wechat.qr.serverError')
      } else {
        errorText = t('wechat.qr.networkError')
      }
      setWechatState({ phase: 'error', secondsLeft: 0, expiresAt: 0, statusText: '', errorText })
      return
    }
    setWechatQr(data)
    const expiresIn = Number(data?.expiresIn) > 0 ? Number(data.expiresIn) : 120
    const expiresAt = Date.now() + expiresIn * 1000
    wechatExpiresAtRef.current = expiresAt
    setWechatState({
      phase: 'ready',
      secondsLeft: expiresIn,
      expiresAt,
      statusText: '',
      errorText: '',
    })
    startWechatPolling(data)
  }

  // ★ T2: 启轮询；状态机由 createPoller 内部维护
  const startWechatPolling = (qr) => {
    if (!qr?.qrcodeId) return
    const poller = createWechatQrPoller({
      fetch: async () => {
        return pollWechatQrcodeApi({
          qrcodeId: qr.qrcodeId,
          integrationId: form?.id || undefined,
          name: form?.name || 'WeChat Personal',
          defaultAgentId: form?.config?.defaultAgentId || '',
        })
      },
      intervalMs: 2000,
      maxAttempts: 60,
      maxFailures: 3,
      onUpdate: (ev) => {
        if (ev.type === 'status') {
          // 中间态：scanned / pending —— 只更状态条
          setWechatState((cur) => ({ ...cur, statusText: ev.status || '', errorText: '' }))
        } else if (ev.type === 'done') {
          if (ev.status === 'confirmed' && ev.data?.integration) {
            const next = ev.data.integration
            setIntegrations((current) => {
              if (current.some((item) => item.id === next.id)) {
                return current.map((item) => item.id === next.id ? next : item)
              }
              return [next, ...current]
            })
            setForm(null)
            setWechatQr(null)
            setWechatState({ phase: 'success', secondsLeft: 0, expiresAt: 0, statusText: '', errorText: '' })
          } else if (ev.status === 'expired') {
            setWechatState((cur) => ({ ...cur, phase: 'expired', errorText: t('wechat.qr.expired') }))
          } else {
            // failed / 其他终态
            setWechatState((cur) => ({ ...cur, phase: 'error', errorText: ev.data?.message || ev.status }))
          }
        } else if (ev.type === 'error') {
          let errorText = ''
          if (ev.kind === 'networkError') errorText = t('wechat.qr.networkError')
          else if (ev.kind === 'serverError') errorText = t('wechat.qr.serverError')
          else if (ev.kind === 'clientError') errorText = ev.message || t('wechat.qr.serverError')
          else if (ev.kind === 'timeout') errorText = t('wechat.qr.timeout')
          const phase = ev.kind === 'timeout' ? 'timeout' : 'error'
          setWechatState((cur) => ({ ...cur, phase, errorText }))
        }
      },
    })
    wechatPollerRef.current = poller
    poller.start()
  }

  // ★ T2: 二维码过期倒计时 + 自然过期切 phase
  useEffect(() => {
    if (wechatState.phase !== 'ready') return undefined
    const tick = () => {
      const remaining = Math.max(0, Math.round((wechatExpiresAtRef.current - Date.now()) / 1000))
      setWechatState((cur) => {
        if (cur.phase !== 'ready') return cur
        if (remaining <= 0) {
          stopWechatPoller()
          return { ...cur, phase: 'expired', secondsLeft: 0, errorText: t('wechat.qr.expired') }
        }
        return { ...cur, secondsLeft: remaining }
      })
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wechatState.phase])

  // ★ T2: 卸载 / 关弹窗时停掉轮询
  useEffect(() => {
    return () => stopWechatPoller()
  }, [])

  const activeMeta = form ? providersById[form.provider] : null
  const activeFields = normalizeFields(activeMeta)
  const requiredFields = activeFields.filter((field) => !field.optional)
  const optionalFields = activeFields.filter((field) => field.optional)

  const renderField = (field) => {
    const value = field.location === 'secret' ? form.secret?.[field.key] || '' : form.config?.[field.key] || ''
    return (
      <label key={`${field.location}.${field.key}`} className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-fade">{field.label}</span>
        {field.type === 'select' ? (
          <select
            value={value}
            onChange={(event) => updateFormValue(field, event.target.value)}
            className="h-10 px-3 rounded-md border border-ink-fade/40 bg-paper text-sm outline-none focus:border-ember"
          >
            <option value="">-</option>
            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        ) : (
          <input
            type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'}
            value={value}
            placeholder={field.type === 'password' && form?.id ? t('integrations.secretPlaceholder') : ''}
            onFocus={() => {
              if (field.location === 'secret' && value === SECRET_SENTINEL) updateFormValue(field, '')
            }}
            onChange={(event) => updateFormValue(field, event.target.value)}
            className="h-10 px-3 rounded-md border border-ink-fade/40 bg-paper text-sm outline-none focus:border-ember"
          />
        )}
      </label>
    )
  }

  return (
    <div className="border border-ink-fade/40 rounded-md p-4 flex flex-col gap-4 bg-paper">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-hand text-lg text-ink">{kindLabel}</h3>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="font-mono text-[10px] text-ink-fade">{kind}</p>
            {kind === 'vision_assist' && visionStatus ? (
              <span className="relative inline-flex">
                <button
                  type="button"
                  onClick={() => setVisionHintOpen((open) => !open)}
                  onBlur={() => window.setTimeout(() => setVisionHintOpen(false), 120)}
                  className={`inline-flex items-center gap-1 h-5 px-2 rounded-full text-[10px] font-mono cursor-pointer transition-colors ${visionStatus.configured ? 'bg-emerald-50 text-emerald-700 border border-emerald-300 hover:bg-emerald-100' : 'bg-paper-2 text-ink-fade border border-ink-fade/40 hover:bg-paper'}`}
                  aria-label={visionStatus.configured ? t('integrations.visionAssist.badge.active') : t('integrations.visionAssist.badge.inactive')}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${visionStatus.configured ? 'bg-emerald-500' : 'bg-ink-fade'}`} />
                  {visionStatus.configured ? t('integrations.visionAssist.badge.active') : t('integrations.visionAssist.badge.inactive')}
                </button>
                {visionHintOpen ? (
                  <span className="absolute z-30 left-0 top-6 w-72 p-2.5 rounded-md border border-ink-fade/40 bg-paper shadow-lg text-[11px] text-ink-soft leading-relaxed">
                    {t('integrations.visionAssist.badge.hint')}
                    {visionStatus.models?.length ? (
                      <span className="block mt-1.5 font-mono text-[10px] text-ink-fade truncate">
                        MODEL_NAMES_VISION = {visionStatus.models.join(', ')}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setProviderMenuOpen((open) => !open)}
            className="h-9 px-3 rounded-md bg-ink text-paper text-sm hover:bg-ink-soft inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('integrations.addNew')}
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {providerMenuOpen ? (
            <div className="absolute right-0 z-30 mt-2 w-56 rounded-md border border-ink-fade/40 bg-paper shadow-xl p-1">
              {visibleProviders.map((provider) => {
                const Icon = providerIcon(provider.provider)
                return (
                  <button
                    key={provider.provider}
                    type="button"
                    onClick={() => openNew(provider)}
                    className="w-full px-2 py-2 rounded text-left hover:bg-paper-2 flex items-center gap-2"
                  >
                    <Icon className="w-4 h-4 text-ink-fade" />
                    <span className="min-w-0">
                      <span className="block text-sm text-ink truncate">{provider.label}</span>
                      <span className="block font-mono text-[10px] text-ink-fade truncate">{provider.provider}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      </div>

      {error ? <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
      {loading ? <div className="text-sm text-ink-fade">{t('common.loading')}</div> : null}

      {!loading && integrations.length === 0 ? (
        <div className="border border-dashed border-ink-fade/40 rounded-md p-6 flex flex-col items-center text-center gap-3 bg-paper-2/60">
          <Plug className="w-9 h-9 text-ink-fade" />
          <div>
            <div className="font-hand text-xl text-ink">{t('integrations.empty', { kind: kindLabel })}</div>
            <p className="text-sm text-ink-soft mt-1 max-w-lg">
              {kind === 'vision_assist' ? t('integrations.visionAssistHint') : t('settings.integrationsSubtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => visibleProviders[0] && openNew(visibleProviders[0])}
            disabled={!visibleProviders.length}
            className="h-9 px-4 rounded-md bg-ember text-paper text-sm hover:bg-ember/90 disabled:opacity-50"
          >
            {t('integrations.emptyCta')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {integrations.map((integration) => {
            const meta = providersById[integration.provider]
            const Icon = providerIcon(integration.provider)
            const lastTest = getLastTest(integration)
            const statusTone = lastTest?.ok === true ? 'text-emerald-700' : lastTest?.ok === false ? 'text-red-700' : 'text-ink-fade'
            const StatusIcon = lastTest?.ok === true ? Check : lastTest?.ok === false ? X : Circle
            return (
              <div key={integration.id} className="p-3 border border-ink-fade/30 rounded-md flex flex-col md:flex-row md:items-center gap-3">
                <div className="flex items-center gap-3 min-w-0 md:w-64">
                  <span className="w-9 h-9 rounded-md border border-ink-fade/40 flex items-center justify-center shrink-0 bg-paper-2">
                    <Icon className="w-4 h-4 text-ink-soft" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm text-ink truncate">{integration.name || meta?.label || integration.provider}</span>
                    <span className="inline-flex mt-1 h-5 px-1.5 rounded border border-ink-fade/40 bg-paper-2 font-mono text-[10px] text-ink-fade items-center">
                      {meta?.label || integration.provider}
                    </span>
                  </span>
                </div>
                <div className="flex-1 min-w-0 font-mono text-[10px] text-ink-fade flex items-center gap-2" title={lastTest?.message || ''}>
                  <StatusIcon className={`w-3.5 h-3.5 ${statusTone}`} />
                  <span className={statusTone}>
                    {lastTest ? t('integrations.lastTest', { time: formatTestTime(lastTest.at) }) : t('integrations.lastTestNever')}
                  </span>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={() => test(integration.id)} disabled={testingId === integration.id} className="h-8 px-2 rounded-md border border-ink-fade/40 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-50 inline-flex items-center gap-1">
                    <TestTube2 className="w-3.5 h-3.5" />
                    {testingId === integration.id ? t('integrations.testing') : t('integrations.test')}
                  </button>
                  <button type="button" onClick={() => openEdit(integration)} className="w-8 h-8 rounded-md border border-ink-fade/40 text-ink-soft hover:bg-paper-2 inline-flex items-center justify-center" title={t('common.save')}>
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <Toggle
                    enabled={integration.enabled !== false}
                    onClick={() => toggleEnabled(integration, integration.enabled === false)}
                    label={integration.enabled === false ? t('integrations.disabled') : t('integrations.enabled')}
                  />
                  <button type="button" onClick={() => remove(integration)} className="w-8 h-8 rounded-md border border-ember-line text-ember hover:bg-ember-soft inline-flex items-center justify-center" title={t('integrations.delete')}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {form ? (
        <div className="fixed inset-0 z-50 bg-ink/35 flex items-center justify-center p-4">
          <form onSubmit={save} className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-md border border-ink bg-paper shadow-xl p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-xl text-ink">{activeMeta?.label || form.provider}</h2>
                <div className="font-mono text-[10px] text-ink-fade">{form.provider}</div>
              </div>
              <button type="button" onClick={() => setForm(null)} className="p-1 rounded hover:bg-paper-2 text-ink-fade hover:text-ink">
                <X className="w-4 h-4" />
              </button>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-fade">{t('integrations.name')}</span>
              <input
                value={form.name}
                onChange={(event) => updateFormValue('name', event.target.value)}
                className="h-10 px-3 rounded-md border border-ink-fade/40 bg-paper text-sm outline-none focus:border-ember"
              />
            </label>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {requiredFields.map(renderField)}
            </div>

            {optionalFields.length ? (
              <details className="rounded-md border border-ink-fade/30 px-3 py-2 group">
                <summary className="cursor-pointer text-sm text-ink-soft select-none list-none flex items-center gap-1.5">
                  <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />
                  {t('integrations.advancedOptions')}
                </summary>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">
                  {optionalFields.map(renderField)}
                </div>
              </details>
            ) : null}

            {form.provider === 'wechat_personal' ? (
              <div className="rounded-md border border-ink-fade/30 p-3 flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-ink-soft">个人微信扫码登录</span>
                  <button type="button" onClick={openWechatQr} className="h-8 px-3 rounded-md border border-ink-fade/40 text-xs text-ink-soft hover:bg-paper-2">
                    获取扫码图
                  </button>
                </div>
                {wechatQr?.qrcodeUrl ? (
                  <div className="flex flex-col sm:flex-row items-center gap-3">
                    <div className="relative w-40 h-40 shrink-0">
                      <img
                        src={wechatQr.qrcodeUrl}
                        alt="WeChat QR code"
                        className={`w-40 h-40 rounded-md border border-ink-fade/30 bg-white ${['expired', 'timeout', 'error'].includes(wechatState.phase) ? 'opacity-40 grayscale' : ''}`}
                      />
                      {['expired', 'timeout', 'error'].includes(wechatState.phase) ? (
                        <button
                          type="button"
                          onClick={openWechatQr}
                          className="absolute inset-0 m-auto h-9 w-28 rounded-md bg-ink text-paper text-xs hover:bg-ink-soft self-center"
                        >
                          {t('wechat.qr.refresh')}
                        </button>
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-2 min-w-0">
                      {wechatState.phase === 'ready' ? (
                        <span className="inline-flex items-center gap-1.5 self-start h-6 px-2 rounded-full bg-paper-2 text-[11px] text-ink-soft font-mono">
                          <Circle className="w-2 h-2 fill-emerald-500 text-emerald-500" />
                          {t('wechat.qr.expiresIn', { seconds: wechatState.secondsLeft })}
                        </span>
                      ) : null}
                      {wechatState.statusText && !['expired', 'timeout', 'error'].includes(wechatState.phase) ? (
                        <span className="text-xs text-ink-soft leading-relaxed">{wechatState.statusText}</span>
                      ) : null}
                      {['expired', 'timeout', 'error'].includes(wechatState.phase) && wechatState.errorText ? (
                        <span className="text-xs text-red-600 leading-relaxed">{wechatState.errorText}</span>
                      ) : null}
                      <span className="text-xs text-ink-fade leading-relaxed">成功后会自动保存 botToken 并启用微信 Bridge。</span>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <label className="flex items-center justify-between gap-3 rounded-md border border-ink-fade/30 p-3">
              <span className="text-sm text-ink-soft">{form.enabled ? t('integrations.enabled') : t('integrations.disabled')}</span>
              <Toggle enabled={form.enabled} onClick={() => updateFormValue('enabled', !form.enabled)} label={t('integrations.enabled')} />
            </label>

            {testMessage ? <div className="rounded-md border border-ink-fade/40 bg-paper-2 px-3 py-2 text-sm text-ink-soft">{testMessage}</div> : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => form.id && test(form.id, { inline: true })}
                disabled={!form.id || testingId === form.id}
                className="h-9 px-3 rounded-md border border-ink-fade/40 text-sm text-ink-soft hover:bg-paper-2 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <TestTube2 className="w-3.5 h-3.5" />
                {testingId === form.id ? t('integrations.testing') : t('integrations.test')}
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={() => setForm(null)} className="h-9 px-4 rounded-md border border-ink-fade/40 text-sm text-ink-soft hover:bg-paper-2">
                  {t('integrations.cancel')}
                </button>
                <button disabled={saving || !form.name.trim()} className="h-9 px-4 rounded-md bg-ember text-paper text-sm hover:bg-ember/90 disabled:opacity-50">
                  {form.enabled ? `${t('integrations.save')} & ${t('integrations.enabled')}` : t('integrations.save')}
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}
