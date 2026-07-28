import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, QrCode, X } from 'lucide-react'
import {
  getWechatQrcodeApi,
  pollWechatQrcodeApi,
  testIntegrationApi,
  upsertIntegrationApi,
} from '../lib/integrationsClient.js'
import { createPoller } from '../lib/wechatQrPoller.js'

const EMPTY = Object.freeze({ workspace: '', account: '', token: '', appId: '', appSecret: '' })

export default function AccessConnectModal({ connector, integration, onClose, onConnected, t }) {
  const [form, setForm] = useState(() => ({
    ...EMPTY,
    workspace: integration?.config?.workspace || '',
    account: integration?.config?.account || '',
    appId: integration?.config?.appId || '',
  }))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [qr, setQr] = useState(null)
  const [qrStatus, setQrStatus] = useState('')

  useEffect(() => {
    if (connector.provider !== 'wechat_personal') return undefined
    let poller
    let cancelled = false
    const begin = async () => {
      setBusy(true)
      setMessage('')
      try {
        const value = await getWechatQrcodeApi()
        if (cancelled) return
        setQr(value)
        setQrStatus(t('access.qrWaiting'))
        poller = createPoller({
          fetch: () => pollWechatQrcodeApi({
            qrcodeId: value.qrcodeId,
            integrationId: integration?.id,
            name: 'WeChat Personal',
          }),
          intervalMs: 2000,
          maxAttempts: 60,
          maxFailures: 3,
          onUpdate: (event) => {
            if (cancelled) return
            if (event.type === 'status') setQrStatus(event.status || t('access.qrWaiting'))
            if (event.type === 'done' && event.status === 'confirmed') onConnected(event.data?.integration)
            if (event.type === 'error') setMessage(event.message || t('access.connectError'))
          },
        })
        poller.start()
      } catch (error) {
        if (!cancelled) setMessage(error.code === 'WECHAT_ILINK_UNAVAILABLE'
          ? t('access.wechatUnavailable')
          : (error.message || t('access.connectError')))
      } finally {
        if (!cancelled) setBusy(false)
      }
    }
    begin()
    return () => { cancelled = true; poller?.stop?.() }
  }, [connector.provider, integration?.id, onConnected, t])

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const config = connector.provider === 'notion'
        ? { workspace: form.workspace }
        : connector.provider === 'github'
          ? { account: form.account }
          : { appId: form.appId }
      const secret = {}
      if (connector.provider === 'feishu' && form.appSecret) secret.appSecret = form.appSecret
      if ((connector.provider === 'notion' || connector.provider === 'github') && form.token) secret.token = form.token
      const saved = await upsertIntegrationApi({
        id: integration?.id,
        provider: connector.provider,
        name: connector.label,
        enabled: true,
        config,
        secret,
      })
      const tested = await testIntegrationApi(saved.integration.id)
      if (tested.result?.ok === false) throw new Error(tested.result.message || t('access.connectError'))
      onConnected(saved.integration)
    } catch (error) {
      setMessage(error.message || t('access.connectError'))
    } finally {
      setBusy(false)
    }
  }

  const passwordPlaceholder = integration ? t('access.secretKept') : ''

  return (
    <div className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`${connector.label} ${t('access.connect')}`}>
      <div className="w-full max-w-md rounded-xl border border-ink-fade/40 bg-paper shadow-2xl">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-dashed border-ink-fade/40">
          <div>
            <h2 className="font-hand text-2xl text-ink">{connector.label}</h2>
            <p className="text-sm text-ink-soft mt-1">{t(connector.hintKey)}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md hover:bg-paper-2" aria-label={t('access.cancel')}><X className="w-4 h-4" /></button>
        </div>

        {connector.provider === 'wechat_personal' ? (
          <div className="p-6 flex flex-col items-center gap-4">
            {qr?.qrcodeUrl ? <img src={qr.qrcodeUrl} alt="WeChat QR code" className="w-56 h-56 rounded-lg border border-ink-fade/30 bg-white" /> : <div className="w-56 h-56 rounded-lg bg-paper-2 flex items-center justify-center"><QrCode className="w-16 h-16 text-ink-fade" /></div>}
            <div className="text-sm text-ink-soft flex items-center gap-2">{busy && <LoaderCircle className="w-4 h-4 animate-spin" />}{qrStatus || t('access.qrLoading')}</div>
            {message && <p className="text-sm text-red-600 text-center">{message}</p>}
          </div>
        ) : (
          <form onSubmit={save} className="p-5 flex flex-col gap-4">
            {connector.provider === 'notion' && <TextField label={t('access.workspace')} value={form.workspace} onChange={(value) => set('workspace', value)} />}
            {connector.provider === 'github' && <TextField label={t('access.account')} value={form.account} onChange={(value) => set('account', value)} />}
            {connector.provider === 'feishu' && <TextField label={t('access.appId')} value={form.appId} onChange={(value) => set('appId', value)} required />}
            {(connector.provider === 'notion' || connector.provider === 'github') && <TextField type="password" label={t('access.token')} value={form.token} onChange={(value) => set('token', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.provider === 'feishu' && <TextField type="password" label={t('access.appSecret')} value={form.appSecret} onChange={(value) => set('appSecret', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.setupUrl && <a href={connector.setupUrl} target="_blank" rel="noreferrer" className="text-xs text-ember hover:underline inline-flex items-center gap-1">{t('access.openSetup')}<ExternalLink className="w-3 h-3" /></a>}
            {message && <p className="text-sm text-red-600">{message}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="h-9 px-4 rounded-md border border-ink-fade/50 text-sm">{t('access.cancel')}</button>
              <button type="submit" disabled={busy} className="h-9 px-4 rounded-md bg-ink text-paper text-sm flex items-center gap-2 disabled:opacity-50">{busy && <LoaderCircle className="w-4 h-4 animate-spin" />}{t('access.saveAndTest')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function TextField({ label, value, onChange, type = 'text', placeholder = '', required = false }) {
  return <label className="flex flex-col gap-1.5"><span className="text-xs text-ink-soft">{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} className="h-10 px-3 rounded-md border border-ink-fade/50 bg-paper outline-none focus:border-ember text-sm" /></label>
}
