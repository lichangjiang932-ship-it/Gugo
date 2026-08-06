import { useEffect, useRef, useState } from 'react'
import { ExternalLink, LoaderCircle, QrCode, X } from 'lucide-react'
import {
  getWechatQrcodeApi,
  getIntegrationOAuthStatusApi,
  pollWechatQrcodeApi,
  startIntegrationOAuthApi,
  testIntegrationApi,
  toggleIntegrationEnabledApi,
  upsertIntegrationApi,
} from '../lib/integrationsClient.js'
import { createPoller } from '../lib/wechatQrPoller.js'
import { openOAuthAuthorizationWindow } from '../lib/oauthPopup.js'
import { manualIntegrationValues } from '../lib/accessManualCredentials.js'

const EMPTY = Object.freeze({
  workspace: '', account: '', token: '', appId: '', appSecret: '', botUsername: '',
  user: '', from: '', password: '', smtpHost: '', smtpPort: '', imapHost: '', imapPort: '',
})

export default function AccessConnectModal({ connector, integration, onClose, onConnected, t }) {
  const [form, setForm] = useState(() => ({
    ...EMPTY,
    workspace: integration?.config?.workspace || '',
    account: integration?.config?.account || '',
    appId: integration?.config?.appId || '',
    botUsername: integration?.config?.botUsername || '',
    user: integration?.config?.user || '',
    from: integration?.config?.from || '',
    smtpHost: integration?.config?.smtpHost || '',
    smtpPort: integration?.config?.smtpPort || '',
    imapHost: integration?.config?.imapHost || '',
    imapPort: integration?.config?.imapPort || '',
  }))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [oauthHelp, setOauthHelp] = useState(false)
  const [qr, setQr] = useState(null)
  const [qrStatus, setQrStatus] = useState('')
  const [oauthSessionId, setOauthSessionId] = useState('')
  const oauthPopupRef = useRef(null)

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

  useEffect(() => {
    if (!oauthSessionId) return undefined
    let cancelled = false
    let timer
    const poll = async () => {
      try {
        const data = await getIntegrationOAuthStatusApi(oauthSessionId)
        if (cancelled) return
        const session = data.session
        if (session?.status === 'completed') {
          oauthPopupRef.current?.close?.()
          setBusy(false)
          onConnected(session.integration)
          return
        }
        if (session?.status === 'failed' || session?.status === 'expired') {
          oauthPopupRef.current?.close?.()
          setBusy(false)
          setMessage(session.error || t('access.oauthFailed'))
          return
        }
        timer = window.setTimeout(poll, 1000)
      } catch (error) {
        if (!cancelled) {
          setBusy(false)
          setMessage(error.message || t('access.oauthFailed'))
        }
      }
    }
    poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [oauthSessionId, onConnected, t])

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  const beginOAuth = async () => {
    setBusy(true)
    setMessage('')
    try {
      const data = await startIntegrationOAuthApi({
        provider: connector.provider,
        integrationId: integration?.id,
      })
      const popup = openOAuthAuthorizationWindow(data.authorizationUrl, connector.provider)
      if (!popup) throw new Error(t('access.oauthPopupBlocked'))
      oauthPopupRef.current = popup
      setOauthSessionId(data.session.id)
    } catch (error) {
      setBusy(false)
      setOauthHelp(error.code === 'OAUTH_NOT_CONFIGURED')
      setMessage(error.code === 'OAUTH_NOT_CONFIGURED'
        ? t('access.oauthNotConfigured')
        : (error.message || t('access.oauthFailed')))
    }
  }

  const save = async (event) => {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const { config, secret } = manualIntegrationValues(connector.provider, form)
      const saved = await upsertIntegrationApi({
        id: integration?.id,
        provider: connector.provider,
        name: connector.label,
        // 凭据先以禁用状态保存；只有真实探测成功后才启用。
        // 避免无效 token 在刷新后被显示成“已连接”。
        enabled: false,
        config,
        secret,
      })
      const tested = await testIntegrationApi(saved.integration.id)
      if (tested.result?.ok !== true) throw new Error(tested.result?.message || t('access.connectError'))
      const enabled = await toggleIntegrationEnabledApi(saved.integration.id, true)
      onConnected(enabled.integration)
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
            {connector.oauth && (
              <>
                <button
                  type="button"
                  onClick={beginOAuth}
                  disabled={busy}
                  className="h-10 px-4 rounded-md bg-ink text-paper text-sm flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {busy ? <LoaderCircle className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                  {busy ? t('access.oauthConnecting') : t('access.oauthConnect')}
                </button>
                <div className="flex items-center gap-3 text-[11px] text-ink-fade">
                  <span className="h-px bg-ink-fade/30 flex-1" />
                  {t('access.oauthManualFallback')}
                  <span className="h-px bg-ink-fade/30 flex-1" />
                </div>
              </>
            )}
            {oauthHelp && (
              <details className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900" data-testid="oauth-help">
                <summary className="cursor-pointer font-medium">{t('access.oauthHelpToggle')}</summary>
                <p className="mt-2">{t('access.oauthHelpBody')}</p>
                <a href="https://github.com/lichangjiang932-ship-it/Gugo/blob/main/docs/CONFIGURATION.md" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 underline">{t('access.oauthHelpDoc')}<ExternalLink className="w-3 h-3" /></a>
              </details>
            )}
            {(connector.provider === 'notion' || connector.provider === 'slack') && <TextField label={t('access.workspace')} value={form.workspace} onChange={(value) => set('workspace', value)} />}
            {(connector.provider === 'github' || connector.provider === 'google_drive') && <TextField label={t('access.account')} value={form.account} onChange={(value) => set('account', value)} />}
            {connector.provider === 'feishu' && <TextField label={t('access.appId')} value={form.appId} onChange={(value) => set('appId', value)} required />}
            {connector.provider === 'telegram' && <TextField label={t('access.botUsername')} value={form.botUsername} onChange={(value) => set('botUsername', value)} />}
            {connector.provider === 'qq' && <TextField label={t('access.appId')} value={form.appId} onChange={(value) => set('appId', value)} required />}
            {connector.provider === 'qq_mail' && <>
              <TextField type="email" label={t('access.mailUser')} value={form.user} onChange={(value) => set('user', value)} />
              <TextField type="email" label={t('access.mailFrom')} value={form.from} onChange={(value) => set('from', value)} />
              <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                <TextField label={t('access.smtpHost')} value={form.smtpHost} onChange={(value) => set('smtpHost', value)} placeholder="smtp.qq.com" />
                <TextField type="number" label={t('access.smtpPort')} value={form.smtpPort} onChange={(value) => set('smtpPort', value)} placeholder="465" />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                <TextField label={t('access.imapHost')} value={form.imapHost} onChange={(value) => set('imapHost', value)} placeholder="imap.qq.com" />
                <TextField type="number" label={t('access.imapPort')} value={form.imapPort} onChange={(value) => set('imapPort', value)} placeholder="993" />
              </div>
              <TextField type="password" label={t('access.mailPassword')} value={form.password} onChange={(value) => set('password', value)} placeholder={passwordPlaceholder} />
              <p className="-mt-2 text-[11px] leading-4 text-ink-fade">{t('access.qqMailPasswordHint')}</p>
            </>}
            {['notion', 'github', 'google_drive', 'slack'].includes(connector.provider) && <TextField type="password" label={t('access.token')} value={form.token} onChange={(value) => set('token', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.provider === 'feishu' && <TextField type="password" label={t('access.appSecret')} value={form.appSecret} onChange={(value) => set('appSecret', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.provider === 'telegram' && <TextField type="password" label={t('access.botToken')} value={form.token} onChange={(value) => set('token', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.provider === 'qq' && <TextField type="password" label={t('access.appSecret')} value={form.appSecret} onChange={(value) => set('appSecret', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.provider === 'qq' && <TextField type="password" label={t('access.botTokenOptional')} value={form.token} onChange={(value) => set('token', value)} placeholder={passwordPlaceholder} />}
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
