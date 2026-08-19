// ★ U1: 集成 UI + 视觉副驾 UI
// ★ T2: 微信扫码 —— 倒计时 + 自动轮询 + 错误提示 + 重试
import { useEffect, useMemo, useState } from 'react'
import { Plug } from 'lucide-react'
import {
  deleteIntegrationApi,
  fetchVisionAssistStatus,
  listIntegrationsApi,
  listProvidersApi,
  testIntegrationApi,
  toggleIntegrationEnabledApi,
  upsertIntegrationApi,
} from '../lib/integrationsClient.js'
import IntegrationEditor from './integrations/IntegrationEditor.jsx'
import IntegrationList from './integrations/IntegrationList.jsx'
import { emptyIntegrationForm, formFromIntegration, normalizeFields, SECRET_SENTINEL } from './integrations/integrationFormUtils.js'
import { useWechatIntegrationQr } from './integrations/useWechatIntegrationQr.js'
import IntegrationPanelHeader from './integrations/IntegrationPanelHeader.jsx'

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
  // 视觉副驾就绪状态：仅在 kind === 'vision_assist' 时调 probe 拿
  const [visionStatus, setVisionStatus] = useState(null)
  const [visionHintOpen, setVisionHintOpen] = useState(false)
  const { wechatQr, wechatState, openWechatQr, resetWechatQr } = useWechatIntegrationQr({ form, setForm, setIntegrations, setTestMessage, t })

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
    resetWechatQr()
    setForm(emptyIntegrationForm(provider.provider, provider))
  }

  const openEdit = (integration) => {
    setTestMessage('')
    resetWechatQr()
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

  const activeMeta = form ? providersById[form.provider] : null

  return (
    <div className="border border-ink-fade/40 rounded-md p-4 flex flex-col gap-4 bg-paper">
      <IntegrationPanelHeader kind={kind} kindLabel={kindLabel} visionStatus={visionStatus} visionHintOpen={visionHintOpen} onVisionHintChange={setVisionHintOpen} providers={visibleProviders} menuOpen={providerMenuOpen} onMenuChange={setProviderMenuOpen} onOpenProvider={openNew} t={t} />

      {error ? <div className="rounded-md border border-danger/35 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div> : null}
      {loading ? <div className="text-sm text-ink-fade">{t('common.loading')}</div> : null}

      {!loading && integrations.length === 0 ? (
        <div className="border border-dashed border-ink-fade/40 rounded-md p-6 flex flex-col items-center text-center gap-3 bg-paper-2/60">
          <Plug className="w-9 h-9 text-ink-fade" />
          <div>
            <div className="font-semibold text-xl text-ink">{t('integrations.empty', { kind: kindLabel })}</div>
            <p className="text-sm text-ink-soft mt-1 max-w-lg">
              {kind === 'vision_assist' ? t('integrations.visionAssistHint') : t('settings.integrationsSubtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => visibleProviders[0] && openNew(visibleProviders[0])}
            disabled={!visibleProviders.length}
            className="h-9 px-4 rounded-md bg-accent text-accent-contrast text-sm hover:bg-accent/90 disabled:opacity-50"
          >
            {t('integrations.emptyCta')}
          </button>
        </div>
      ) : <IntegrationList integrations={integrations} providersById={providersById} testingId={testingId} onTest={test} onEdit={openEdit} onToggle={toggleEnabled} onRemove={remove} t={t} />}

      {form && <IntegrationEditor form={form} meta={activeMeta} saving={saving} testingId={testingId} testMessage={testMessage} wechatQr={wechatQr} wechatState={wechatState} onChange={updateFormValue} onSave={save} onTest={test} onWechatQr={openWechatQr} onClose={() => setForm(null)} t={t} />}

    </div>
  )
}
