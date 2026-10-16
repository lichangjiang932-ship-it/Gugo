import { useEffect, useRef, useState } from 'react'
import { ExternalLink, QrCode, X } from 'lucide-react'
import { Spinner as LoaderCircle } from './ui/LoadingState.jsx'
import {
  getWechatQrcodeApi,
  getIntegrationOAuthStatusApi,
  listIntegrationOAuthProvidersApi,
  pollWechatQrcodeApi,
  startIntegrationOAuthApi,
  startIntegrationQrApi,
  testIntegrationApi,
  toggleIntegrationEnabledApi,
  upsertIntegrationApi,
} from '../lib/integrationsClient.js'
import { createPoller } from '../lib/wechatQrPoller.js'
import { openOAuthAuthorizationWindow } from '../lib/oauthPopup.js'
import { manualIntegrationValues } from '../lib/accessManualCredentials.js'
import { copyTextToClipboard } from '../lib/clipboard.js'
import Modal from './Modal.jsx'

const EMPTY = Object.freeze({
  workspace: '', account: '', token: '', appId: '', appSecret: '', botUsername: '',
  user: '', from: '', password: '', smtpHost: '', smtpPort: '', imapHost: '', imapPort: '',
  siteUrl: '', email: '', apiKey: '', baseUrl: '', subdomain: '', instanceUrl: '',
})
const MAIL_PROVIDERS = new Set(['qq_mail', 'gmail', 'outlook', 'exchange', 'custom_mail'])

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
    siteUrl: integration?.config?.siteUrl || '',
    email: integration?.config?.email || '',
    apiKey: integration?.config?.apiKey || '',
    baseUrl: integration?.config?.baseUrl || '',
    subdomain: integration?.config?.subdomain || '',
    instanceUrl: integration?.config?.instanceUrl || '',
  }))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [oauthHelp, setOauthHelp] = useState(false)
  const [qr, setQr] = useState(null)
  const [qrStatus, setQrStatus] = useState('')
  const [oauthSessionId, setOauthSessionId] = useState('')
  // Set once the server answers with a device code: the reader signs in on the
  // provider's own page, so this pane's job becomes showing the code and the
  // address to paste it into while the same poll loop waits for them to finish.
  const [device, setDevice] = useState(null)
  const [codeCopied, setCodeCopied] = useState(false)
  // Scan-to-connect: the provider hands back a page to put in a QR code, and
  // finishing on the phone is what creates the credential.
  const [scan, setScan] = useState(null)
  const [scanStatus, setScanStatus] = useState('')
  // Whether the *server* can run this provider's OAuth — the catalog says a
  // connector supports OAuth, which is a different question from whether this
  // deployment has an OAuth client registered for it. `null` means the question
  // has not been answered; the button stays then, so a failed probe never hides
  // a feature that would have worked.
  const [oauthConfigured, setOauthConfigured] = useState(null)
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

  // GitHub asks not to be polled faster than the interval it hands back; asking
  // sooner earns a `slow_down` and a longer wait anyway.
  const pollDelayMs = device ? Math.max(device.interval * 1000, 5000) : 1000

  // Scan-to-connect runs itself: the code is up, and whoever holds the phone is
  // the one who acts. An existing integration means there is nothing to create,
  // so the manual form is all that is left to show.
  useEffect(() => {
    if (!connector.qrConnect || integration) return undefined
    let poller
    let cancelled = false
    const begin = async () => {
      setBusy(true)
      setMessage('')
      try {
        const started = await startIntegrationQrApi({ provider: connector.provider })
        if (cancelled) return
        setScan(started.qr)
        setScanStatus(t('access.scanWaiting'))
        poller = createPoller({
          fetch: async () => {
            const result = await getIntegrationOAuthStatusApi(started.session.id)
            const raw = result?.session?.status || 'pending'
            // The poller speaks the QR vocabulary; a finished session is the same
            // event under the OAuth flows' name for it.
            return { ...result, status: raw === 'completed' ? 'confirmed' : raw }
          },
          intervalMs: Math.max((started.qr?.interval || 5) * 1000, 3000),
          maxAttempts: 60,
          maxFailures: 3,
          onUpdate: (event) => {
            if (cancelled) return
            if (event.type === 'done' && event.status === 'confirmed') onConnected(event.data?.session?.integration)
            else if (event.type === 'done') setMessage(t('access.scanExpired'))
            else if (event.type === 'error') setMessage(event.message || t('access.connectError'))
          },
        })
        poller.start()
      } catch (error) {
        if (!cancelled) setMessage(error.message || t('access.connectError'))
      } finally {
        if (!cancelled) setBusy(false)
      }
    }
    begin()
    return () => { cancelled = true; poller?.stop?.() }
  }, [connector.qrConnect, connector.provider, integration, onConnected, t])

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
        timer = window.setTimeout(poll, pollDelayMs)
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
  }, [oauthSessionId, onConnected, t, pollDelayMs])

  // Ask once, and only for the connectors that claim OAuth at all, so the other
  // thirty do not pay for a request they cannot use.
  useEffect(() => {
    if (!connector.oauth) return undefined
    let cancelled = false
    listIntegrationOAuthProvidersApi()
      .then((data) => {
        if (cancelled) return
        const entry = (data?.providers || []).find((item) => item.provider === connector.provider)
        if (entry) setOauthConfigured(entry.configured === true)
      })
      .catch(() => { /* Leave it unknown. */ })
    return () => { cancelled = true }
  }, [connector.oauth, connector.provider])

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))

  const openDevicePage = () => {
    if (!device?.verificationUri) return
    globalThis.window?.open?.(device.verificationUri, '_blank', 'noopener,noreferrer')
  }

  const copyDeviceCode = () => {
    if (!device?.userCode) return
    void copyTextToClipboard(device.userCode)
    setCodeCopied(true)
  }

  const beginOAuth = async () => {
    setBusy(true)
    setMessage('')
    try {
      const data = await startIntegrationOAuthApi({
        provider: connector.provider,
        integrationId: integration?.id,
      })
      // A device flow has no window to wait on: the reader is handed a code and
      // the page to paste it into, and signs in to their own account there.
      if (data.deviceFlow) {
        setDevice(data.deviceFlow)
        setOauthSessionId(data.session.id)
        setBusy(false)
        return
      }
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
  // With no OAuth client on the server the button could only ever answer with an
  // error, so it is not offered: the token form below is the way in, and the
  // guide that used to appear after a failed click is shown up front instead.
  const oauthUnavailable = connector.oauth === true && oauthConfigured === false
  const showOAuthButton = connector.oauth === true && oauthConfigured !== false
  const showOAuthGuide = oauthUnavailable || oauthHelp

  return (
    <Modal onClose={onClose} closeOnBackdrop={false} ariaLabel={`${connector.label} ${t('access.connect')}`} overlayClassName="bg-ink/30" className="max-w-md border-ink-fade/40">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-dashed border-ink-fade/40">
          <div>
            <h2 className="font-semibold text-2xl text-ink">{connector.label}</h2>
            <p className="text-sm text-ink-soft mt-1">{t(connector.hintKey)}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md hover:bg-paper-2" aria-label={t('access.cancel')}><X className="w-4 h-4" /></button>
        </div>

        {connector.provider === 'wechat_personal' ? (
          <div className="p-6 flex flex-col items-center gap-4">
            {qr?.qrcodeUrl ? <img src={qr.qrcodeUrl} alt="WeChat QR code" className="w-56 h-56 rounded-lg border border-ink-fade/30 bg-white" /> : <div className="w-56 h-56 rounded-lg bg-paper-2 flex items-center justify-center"><QrCode className="w-16 h-16 text-ink-fade" /></div>}
            <div className="text-sm text-ink-soft flex items-center gap-2">{busy && <LoaderCircle className="w-4 h-4 animate-spin" />}{qrStatus || t('access.qrLoading')}</div>
            {message && <p className="text-sm text-danger text-center">{message}</p>}
          </div>
        ) : (
          <form onSubmit={save} className="p-5 flex flex-col gap-4">
            {scan && (
              <div className="rounded-lg border border-ink/10 bg-paper-2/40 p-4" data-testid="qr-connect-panel">
                <p className="text-xs font-semibold text-ink">{t('access.scanTitle')}</p>
                <p className="mt-1 text-xs leading-5 text-ink-fade">{t('access.scanHint')}</p>
                <div className="mt-3 flex flex-col items-center gap-2">
                  <img src={scan.qrcodeUrl} alt="" className="h-44 w-44 rounded-md border border-ink/10 bg-white" />
                  <p className="text-center text-xs text-ink-fade" role="status">{scanStatus}</p>
                </div>
              </div>
            )}
            {device ? (
              <div className="rounded-lg border border-ink/10 bg-paper-2/40 p-4" data-testid="device-flow-panel">
                <p className="text-xs font-semibold text-ink">{t('access.deviceCodeTitle')}</p>
                <p className="mt-1 text-xs leading-5 text-ink-fade">{t('access.deviceCodeHint')}</p>
                <div className="mt-3 flex items-center gap-2">
                  <code data-testid="device-flow-code" className="min-w-0 flex-1 rounded-md border border-ink/15 bg-paper px-3 py-2 text-center font-mono text-lg font-semibold tracking-[0.2em] text-ink">{device.userCode}</code>
                  <button type="button" onClick={copyDeviceCode} className="h-10 shrink-0 rounded-md border border-ink/15 bg-paper px-3 text-xs text-ink-soft transition-colors hover:bg-paper-2">
                    {codeCopied ? t('access.deviceCodeCopied') : t('access.deviceCodeCopy')}
                  </button>
                </div>
                <button type="button" onClick={openDevicePage} className="mt-3 flex h-10 w-full items-center justify-center rounded-md bg-ink text-sm text-paper transition-colors hover:bg-ink/90">
                  {t('access.deviceCodeOpen')}
                </button>
                <p className="mt-2 text-center text-xs text-ink-fade" role="status">{t('access.deviceCodeWaiting')}</p>
              </div>
            ) : showOAuthButton && (
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
                <div className="flex items-center gap-3 text-xs text-ink-fade">
                  <span className="h-px bg-ink-fade/30 flex-1" />
                  {t('access.oauthManualFallback')}
                  <span className="h-px bg-ink-fade/30 flex-1" />
                </div>
              </>
            )}
            {showOAuthGuide && (
              <details className="rounded-md border border-ink/10 bg-paper-2/40 p-3 text-xs leading-5 text-ink-soft" data-testid="oauth-help">
                <summary className="cursor-pointer font-medium">{t('access.oauthHelpToggle')}</summary>
                {oauthUnavailable && <p className="mt-2">{t('access.oauthUnavailable')}</p>}
                <p className="mt-2">{t('access.oauthHelpBody')}</p>
                <a href="https://github.com/lichangjiang932-ship-it/Gugo/blob/main/docs/CONFIGURATION.md" target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 underline">{t('access.oauthHelpDoc')}<ExternalLink className="w-3 h-3" /></a>
              </details>
            )}
            {(connector.provider === 'notion' || connector.provider === 'slack') && <TextField label={t('access.workspace')} value={form.workspace} onChange={(value) => set('workspace', value)} />}
            {['github', 'google_drive', 'google_calendar'].includes(connector.provider) && <TextField label={t('access.account')} value={form.account} onChange={(value) => set('account', value)} />}
            {['jira', 'confluence'].includes(connector.provider) && <><TextField label={t('access.siteUrl')} value={form.siteUrl} onChange={(value) => set('siteUrl', value)} placeholder="https://team.atlassian.net" required /><TextField type="email" label={t('access.accountEmail')} value={form.email} onChange={(value) => set('email', value)} required /></>}
            {connector.provider === 'trello' && <TextField label={t('access.apiKey')} value={form.apiKey} onChange={(value) => set('apiKey', value)} required />}
            {connector.provider === 'gitlab' && <TextField label="API URL" value={form.baseUrl} onChange={(value) => set('baseUrl', value)} placeholder="https://gitlab.com/api/v4" />}
            {connector.provider === 'zendesk' && <><TextField label="Zendesk subdomain" value={form.subdomain} onChange={(value) => set('subdomain', value)} placeholder="company" required /><TextField type="email" label={t('access.accountEmail')} value={form.email} onChange={(value) => set('email', value)} required /></>}
            {connector.provider === 'salesforce' && <TextField label={t('access.instanceUrl')} value={form.instanceUrl} onChange={(value) => set('instanceUrl', value)} placeholder="https://company.my.salesforce.com" required />}
            {connector.provider === 'feishu' && <TextField label={t('access.appId')} value={form.appId} onChange={(value) => set('appId', value)} required />}
            {connector.provider === 'telegram' && <TextField label={t('access.botUsername')} value={form.botUsername} onChange={(value) => set('botUsername', value)} />}
            {connector.provider === 'discord' && <TextField label={t('access.appId')} value={form.appId} onChange={(value) => set('appId', value)} />}
            {connector.provider === 'qq' && <TextField label={t('access.appId')} value={form.appId} onChange={(value) => set('appId', value)} required />}
            {MAIL_PROVIDERS.has(connector.provider) && <>
              <TextField type="email" label={t('access.mailUser')} value={form.user} onChange={(value) => set('user', value)} />
              <TextField type="email" label={t('access.mailFrom')} value={form.from} onChange={(value) => set('from', value)} />
              <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                <TextField label={t('access.smtpHost')} value={form.smtpHost} onChange={(value) => set('smtpHost', value)} placeholder={connector.provider === 'qq_mail' ? 'smtp.qq.com' : (connector.provider === 'custom_mail' ? 'smtp.example.com' : '')} />
                <TextField type="number" label={t('access.smtpPort')} value={form.smtpPort} onChange={(value) => set('smtpPort', value)} placeholder="465" />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                <TextField label={t('access.imapHost')} value={form.imapHost} onChange={(value) => set('imapHost', value)} placeholder={connector.provider === 'qq_mail' ? 'imap.qq.com' : (connector.provider === 'custom_mail' ? 'imap.example.com' : '')} />
                <TextField type="number" label={t('access.imapPort')} value={form.imapPort} onChange={(value) => set('imapPort', value)} placeholder="993" />
              </div>
              <TextField type="password" label={t('access.mailPassword')} value={form.password} onChange={(value) => set('password', value)} placeholder={passwordPlaceholder} />
              <p className="-mt-2 text-xs leading-4 text-ink-fade">{t('access.qqMailPasswordHint')}</p>
            </>}
            {['notion', 'github', 'google_drive', 'google_calendar', 'jira', 'linear', 'trello', 'gitlab', 'asana', 'clickup', 'airtable', 'monday', 'hubspot', 'zendesk', 'todoist', 'dropbox', 'onedrive', 'confluence', 'salesforce', 'slack'].includes(connector.provider) && <TextField type="password" label={t('access.token')} value={form.token} onChange={(value) => set('token', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.provider === 'feishu' && <TextField type="password" label={t('access.appSecret')} value={form.appSecret} onChange={(value) => set('appSecret', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.provider === 'telegram' && <TextField type="password" label={t('access.botToken')} value={form.token} onChange={(value) => set('token', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.provider === 'discord' && <TextField type="password" label={t('access.botToken')} value={form.token} onChange={(value) => set('token', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.provider === 'qq' && <TextField type="password" label={t('access.appSecret')} value={form.appSecret} onChange={(value) => set('appSecret', value)} placeholder={passwordPlaceholder} required={!integration} />}
            {connector.provider === 'qq' && <TextField type="password" label={t('access.botTokenOptional')} value={form.token} onChange={(value) => set('token', value)} placeholder={passwordPlaceholder} />}
            {connector.setupUrl && <a href={connector.setupUrl} target="_blank" rel="noreferrer" className="text-xs text-accent-ink hover:underline inline-flex items-center gap-1">{t('access.openSetup')}<ExternalLink className="w-3 h-3" /></a>}
            {message && <p className="text-sm text-danger">{message}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="h-9 px-4 rounded-md border border-ink-fade/50 text-sm">{t('access.cancel')}</button>
              <button type="submit" disabled={busy} className="h-9 px-4 rounded-md bg-ink text-paper text-sm flex items-center gap-2 disabled:opacity-50">{busy && <LoaderCircle className="w-4 h-4 animate-spin" />}{t('access.saveAndTest')}</button>
            </div>
          </form>
        )}
    </Modal>
  )
}

function TextField({ label, value, onChange, type = 'text', placeholder = '', required = false }) {
  return <label className="flex flex-col gap-1.5"><span className="text-xs text-ink-soft">{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} required={required} className="h-10 px-3 rounded-md border border-ink-fade/50 bg-paper outline-none focus:border-focus text-sm" /></label>
}
