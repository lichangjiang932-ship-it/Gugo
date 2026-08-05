import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ban, CheckCircle2, Inbox, LoaderCircle, Search, Settings2, ShieldCheck, Unplug } from 'lucide-react'
import LeftRail from '../components/LeftRail.jsx'
import AccessConnectModal from '../components/AccessConnectModal.jsx'
import AccessMcpConnectorCard from '../components/AccessMcpConnectorCard.jsx'
import ConnectorBrandIcon from '../components/ConnectorBrandIcon.jsx'
import { ACCESS_CAPABILITY_LEVELS, filterAccessCatalog, getAccessCatalogCounts } from '../lib/accessCatalog.js'
import {
  allowParkedBridgeMessageApi,
  connectBrowserAppApi,
  deleteIntegrationApi,
  listIntegrationsApi,
  listParkedBridgeMessagesApi,
  openConnectedBrowserAppApi,
  rejectParkedBridgeMessageApi,
  toggleIntegrationEnabledApi,
  upsertIntegrationApi,
} from '../lib/integrationsClient.js'
import {
  deleteMcpServerApi,
  getMcpCatalogApi,
  listMcpServersApi,
} from '../lib/mcpClient.js'
import { findInstalledMcpPreset } from '../lib/mcpPresets.js'
import { installMcpPreset } from '../lib/mcpPresetInstaller.js'
import { useT } from '../i18n/I18nProvider.jsx'

const ACCESS_FILTERS = [
  { id: 'all', labelKey: 'access.filterAll' },
  { id: ACCESS_CAPABILITY_LEVELS.NATIVE_API, labelKey: 'access.filterNativeApi' },
  { id: ACCESS_CAPABILITY_LEVELS.MCP_SERVER, labelKey: 'access.filterMcp' },
  { id: ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE, labelKey: 'access.filterSocialBridge' },
  { id: ACCESS_CAPABILITY_LEVELS.BROWSER_SHORTCUT, labelKey: 'access.filterBrowserNative' },
  { id: 'communication', labelKey: 'access.filterCommunication' },
  { id: 'productivity', labelKey: 'access.filterProductivity' },
  { id: 'creative', labelKey: 'access.filterCreative' },
  { id: 'work', labelKey: 'access.filterWork' },
]

export default function AccessView() {
  const { t } = useT()
  const [integrations, setIntegrations] = useState([])
  const [parkedMessages, setParkedMessages] = useState([])
  const [mcpServers, setMcpServers] = useState([])
  const [mcpRuntime, setMcpRuntime] = useState([])
  const [query, setQuery] = useState('')
  const [activeConnector, setActiveConnector] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyProvider, setBusyProvider] = useState('')
  const [busyParkingId, setBusyParkingId] = useState('')
  const [error, setError] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')
  const highlightedParkingId = useMemo(() => {
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('bridgeParkingId') || ''
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [integrationData, parkedData, mcpServerData, mcpCatalogData] = await Promise.all([
        listIntegrationsApi(),
        listParkedBridgeMessagesApi(),
        listMcpServersApi(),
        getMcpCatalogApi(),
      ])
      setIntegrations(integrationData.integrations || [])
      setParkedMessages(parkedData.messages || [])
      setMcpServers(mcpServerData.servers || [])
      setMcpRuntime(mcpCatalogData.catalog || [])
    } catch (loadError) {
      setError(loadError.message || t('access.connectError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (!highlightedParkingId || loading) return
    const target = document.getElementById(`bridge-parking-${highlightedParkingId}`)
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [highlightedParkingId, loading])

  useEffect(() => {
    const timer = window.setTimeout(reload, 0)
    return () => window.clearTimeout(timer)
  }, [reload])

  const byProvider = useMemo(() => Object.fromEntries(integrations.map((item) => [item.provider, item])), [integrations])
  const visible = useMemo(() => filterAccessCatalog(query), [query])
  const filteredByCapability = visible.filter((item) => activeFilter === 'all'
    || item.capabilityLevel === activeFilter
    || item.category === activeFilter)
  const nativeConnectors = filteredByCapability.filter((item) => item.kind === 'native')
  const mcpConnectors = filteredByCapability.filter((item) => item.kind === 'mcp')
  const webConnectors = filteredByCapability.filter((item) => item.kind === 'web')
  const catalogCounts = useMemo(() => getAccessCatalogCounts(), [])

  const rememberIntegration = useCallback((integration) => {
    if (!integration) return
    setIntegrations((items) => items.some((item) => item.id === integration.id)
      ? items.map((item) => item.id === integration.id ? integration : item)
      : [integration, ...items])
  }, [])

  const toggle = async (connector) => {
    const current = byProvider[connector.provider]
    const enabled = connector.provider === 'browser' ? current?.enabled !== false : current?.enabled === true
    setBusyProvider(connector.provider)
    setError('')
    try {
      const data = current
        ? await toggleIntegrationEnabledApi(current.id, !enabled)
        : await upsertIntegrationApi({ provider: connector.provider, name: connector.label, config: {}, secret: {}, enabled: !enabled })
      rememberIntegration(data.integration)
    } catch (toggleError) {
      setError(toggleError.message || t('access.connectError'))
    } finally {
      setBusyProvider('')
    }
  }

  const connectWeb = async (connector) => {
    setBusyProvider(connector.provider)
    setError('')
    try {
      const data = await connectBrowserAppApi(connector.provider)
      rememberIntegration(data.result?.integration)
    } catch (connectError) {
      setError(connectError.message || t('access.connectError'))
    } finally {
      setBusyProvider('')
    }
  }

  const launchWebApp = async (connector) => {
    setBusyProvider(connector.provider)
    setError('')
    try {
      await openConnectedBrowserAppApi(connector.provider)
    } catch (openError) {
      setError(openError.message || t('access.connectError'))
    } finally {
      setBusyProvider('')
    }
  }

  const disconnect = async (connector) => {
    const integration = byProvider[connector.provider]
    if (!integration) return
    setBusyProvider(connector.provider)
    try {
      await deleteIntegrationApi(integration.id)
      setIntegrations((items) => items.filter((item) => item.id !== integration.id))
    } catch (removeError) {
      setError(removeError.message || t('access.connectError'))
    } finally {
      setBusyProvider('')
    }
  }

  const connected = useCallback((integration) => {
    if (integration) {
      setIntegrations((items) => items.some((item) => item.id === integration.id)
        ? items.map((item) => item.id === integration.id ? integration : item)
        : [integration, ...items])
    } else reload()
    setActiveConnector(null)
  }, [reload])

  const installMcp = async (connector, existingServer) => {
    setBusyProvider(connector.provider)
    setError('')
    try {
      const installed = await installMcpPreset({
        presetId: connector.presetId,
        existingServer,
      })
      setMcpServers((items) => items.some((item) => item.id === installed.server.id)
        ? items.map((item) => item.id === installed.server.id ? installed.server : item)
        : [installed.server, ...items])
      setMcpRuntime((items) => [
        ...items.filter((item) => item.serverId !== installed.server.id),
        installed.runtime,
      ])
    } catch (installError) {
      if (installError.disabledServer) {
        setMcpServers((items) => items.some((item) => item.id === installError.disabledServer.id)
          ? items.map((item) => item.id === installError.disabledServer.id ? installError.disabledServer : item)
          : [installError.disabledServer, ...items])
      }
      setError(installError.message === 'MCP_PRESET_MISSING'
        ? t('access.mcpPresetMissing')
        : (installError.message || t('access.connectError')))
    } finally {
      setBusyProvider('')
    }
  }

  const removeMcp = async (connector, server) => {
    if (!server) return
    setBusyProvider(connector.provider)
    setError('')
    try {
      await deleteMcpServerApi(server.id)
      setMcpServers((items) => items.filter((item) => item.id !== server.id))
      setMcpRuntime((items) => items.filter((item) => item.serverId !== server.id))
    } catch (removeError) {
      setError(removeError.message || t('access.connectError'))
    } finally {
      setBusyProvider('')
    }
  }

  const decideParkedMessage = async (parkingId, decision) => {
    setBusyParkingId(parkingId)
    setError('')
    try {
      if (decision === 'allow') await allowParkedBridgeMessageApi(parkingId)
      else await rejectParkedBridgeMessageApi(parkingId)
      setParkedMessages((items) => items.filter((item) => item.id !== parkingId))
    } catch (decisionError) {
      setError(decisionError.message || t('access.inboundActionError'))
    } finally {
      setBusyParkingId('')
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-8 md:px-10">
          <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-7">
            <div>
              <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{t('access.eyebrow')}</span>
              <h1 className="font-hand text-[32px] text-ink mt-1">{t('access.title')}</h1>
              <p className="text-sm text-ink-soft mt-1 max-w-2xl">{t('access.subtitle')}</p>
            </div>
            <div className="rounded-full border border-ink-fade/40 bg-paper-2 px-4 py-2 text-xs text-ink-soft" data-testid="access-catalog-summary">
              {t('access.summary')
                .replace('{api}', String(catalogCounts.api))
                .replace('{mcp}', String(catalogCounts.mcp))
                .replace('{bridges}', String(catalogCounts.bridges))
                .replace('{shortcuts}', String(catalogCounts.shortcuts))}
            </div>
          </header>

          {!loading && parkedMessages.length > 0 && (
            <BridgeInboundInbox
              messages={parkedMessages}
              busyId={busyParkingId}
              highlightedId={highlightedParkingId}
              onAllow={(id) => decideParkedMessage(id, 'allow')}
              onReject={(id) => decideParkedMessage(id, 'reject')}
              t={t}
            />
          )}

          <label className="relative block w-full mb-3">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-fade" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('access.searchPlaceholder')} aria-label={t('access.searchPlaceholder')} className="w-full h-11 pl-11 pr-4 rounded-xl border border-ink-fade/45 bg-paper shadow-sm outline-none focus:border-ember text-sm" />
          </label>
          <div className="flex gap-2 mb-6 overflow-x-auto pb-1" aria-label={t('access.filterLabel')}>
            {ACCESS_FILTERS.map((filter) => (
              <button key={filter.id} type="button" onClick={() => setActiveFilter(filter.id)} aria-pressed={activeFilter === filter.id} data-testid={`access-filter-${filter.id}`} className={`h-8 px-3 rounded-full border text-xs whitespace-nowrap transition-colors ${activeFilter === filter.id ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-soft border-ink-fade/40 hover:border-ink-fade'}`}>
                {t(filter.labelKey)}
              </button>
            ))}
          </div>

          <CapabilityLegend t={t} />

          {error && <div className="mb-5 p-3 rounded-lg border border-red-300 bg-red-50 text-sm text-red-700">{error}</div>}
          {loading ? <div className="h-52 flex items-center justify-center"><LoaderCircle className="w-6 h-6 animate-spin text-ember" /></div> : (
            <div className="space-y-8" data-testid="access-section">
              {nativeConnectors.length > 0 && (
                <ConnectorSection title={t('access.nativeTitle')} hint={t('access.nativeHint')}>
                  {nativeConnectors.map((connector) => {
                    const integration = byProvider[connector.provider]
                    const isBrowser = connector.provider === 'browser'
                    const isConnected = isBrowser || !!integration
                    const enabled = isBrowser ? integration?.enabled !== false : integration?.enabled === true
                    const busy = busyProvider === connector.provider
                    return (
                      <article key={connector.provider} className="rounded-xl border border-ink-fade/35 bg-paper p-4 shadow-sm hover:-translate-y-0.5 hover:shadow-md transition-all" data-testid={`connector-${connector.provider}`}>
                        <div className="flex items-start gap-3">
                          <ConnectorBrandIcon connector={connector} />
                          <div className="min-w-0 flex-1">
                             <div className="flex items-center gap-2 flex-wrap">
                               <h3 className="font-medium text-ink">{connector.label}</h3>
                               <ConnectorCapabilityBadge capabilityLevel={connector.capabilityLevel} t={t} />
                               <ConnectionMethodBadge method={connector.connectionMethod} t={t} />
                                 {isConnected && <span className="text-[10px] rounded-full px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{t('access.connected')}</span>}
                            </div>
                            <p className="text-xs leading-5 text-ink-soft mt-1">{t(connector.descriptionKey)}</p>
                          </div>
                        </div>
                        {integration?.lastTest?.message && <p className={`text-xs mt-3 ${integration.lastTest.ok ? 'text-green-700' : 'text-red-600'}`}>{integration.lastTest.message}</p>}
                        <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-dashed border-ink-fade/30">
                          {isConnected ? <>
                            {!isBrowser && <button type="button" onClick={() => setActiveConnector(connector)} className="h-8 px-3 rounded-md border border-ink-fade/40 hover:bg-paper-2 text-xs text-ink-soft inline-flex items-center gap-1.5" aria-label={`${t('access.configure')} ${connector.label}`}><Settings2 className="w-3.5 h-3.5" />{t('access.configure')}</button>}
                            {!isBrowser && <button type="button" onClick={() => disconnect(connector)} disabled={busy} className="h-8 px-2 rounded-md hover:bg-red-50 text-ink-fade hover:text-red-600" aria-label={`${t('access.disconnect')} ${connector.label}`}><Unplug className="w-3.5 h-3.5" /></button>}
                            <Toggle enabled={enabled} disabled={busy} onClick={() => toggle(connector)} label={`${connector.label} ${enabled ? t('access.enabled') : t('access.disabled')}`} />
                          </> : <button type="button" onClick={() => setActiveConnector(connector)} className="h-8 px-4 rounded-md bg-ink text-paper text-xs hover:bg-ink-soft" aria-label={`${t('access.connect')} ${connector.label}`}>{t('access.connect')}</button>}
                        </div>
                      </article>
                    )
                  })}
                </ConnectorSection>
              )}

              {mcpConnectors.length > 0 && (
                <ConnectorSection title={t('access.mcpTitle')} hint={t('access.mcpHint')}>
                  {mcpConnectors.map((connector) => {
                    const server = findInstalledMcpPreset(mcpServers, connector.presetId)
                    const runtime = server ? mcpRuntime.find((item) => item.serverId === server.id) : null
                    return (
                      <AccessMcpConnectorCard
                        key={connector.provider}
                        connector={connector}
                        server={server}
                        runtime={runtime}
                        busy={busyProvider === connector.provider}
                        badge={<ConnectorCapabilityBadge capabilityLevel={connector.capabilityLevel} t={t} />}
                        onInstall={installMcp}
                        onRemove={removeMcp}
                        t={t}
                      />
                    )
                  })}
                </ConnectorSection>
              )}

              {webConnectors.length > 0 && (
                <ConnectorSection title={t('access.browserNativeTitle')} hint={t('access.browserNativeHint')}>
                  {webConnectors.map((connector) => {
                    const integration = byProvider[connector.provider]
                    const isConnected = !!integration
                    const enabled = integration?.enabled === true
                    const busy = busyProvider === connector.provider
                    return (
                      <article key={connector.provider} className="rounded-xl border border-ink-fade/35 bg-paper p-4 shadow-sm hover:border-ink-fade/60 transition-colors" data-testid={`connector-${connector.provider}`}>
                        <div className="flex items-start gap-3">
                          <ConnectorBrandIcon connector={connector} />
                          <div className="min-w-0 flex-1">
                             <div className="flex items-center gap-2 flex-wrap">
                               <h3 className="font-medium text-ink">{connector.label}</h3>
                               <ConnectorCapabilityBadge capabilityLevel={connector.capabilityLevel} t={t} />
                               <ConnectionMethodBadge method={connector.connectionMethod} t={t} />
                                {isConnected && <span className="text-[10px] rounded-full px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{t('access.persistentConnected')}</span>}
                            </div>
                            <p className="text-xs leading-5 text-ink-soft mt-1">{t(isConnected ? 'access.browserNativeConnectedDesc' : 'access.browserNativeAppDesc')}</p>
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-dashed border-ink-fade/30">
                          {isConnected ? <>
                            <button type="button" onClick={() => launchWebApp(connector)} disabled={busy || !enabled} className="h-8 px-3 rounded-md border border-ink-fade/40 hover:bg-paper-2 text-xs text-ink-soft disabled:opacity-40 inline-flex items-center gap-1.5" aria-label={`${t('access.open')} ${connector.label}`} data-testid={`use-${connector.provider}`}>{busy ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : t('access.open')}</button>
                            <button type="button" onClick={() => disconnect(connector)} disabled={busy} className="h-8 px-2 rounded-md hover:bg-red-50 text-ink-fade hover:text-red-600 disabled:opacity-40" aria-label={`${t('access.disconnect')} ${connector.label}`}><Unplug className="w-3.5 h-3.5" /></button>
                            <Toggle enabled={enabled} disabled={busy} onClick={() => toggle(connector)} label={`${connector.label} ${enabled ? t('access.enabled') : t('access.disabled')}`} />
                          </> : <button type="button" onClick={() => connectWeb(connector)} disabled={busy} className="h-8 min-w-20 px-4 rounded-md bg-ink text-paper text-xs hover:bg-ink-soft disabled:opacity-50 inline-flex items-center justify-center gap-1.5" aria-label={`${t('access.connect')} ${connector.label}`} data-testid={`connect-${connector.provider}`}>{busy && <LoaderCircle className="w-3.5 h-3.5 animate-spin" />}{busy ? t('access.connecting') : t('access.connect')}</button>}
                        </div>
                      </article>
                    )
                  })}
                </ConnectorSection>
              )}

              {!nativeConnectors.length && !mcpConnectors.length && !webConnectors.length && <div className="h-40 flex items-center justify-center text-sm text-ink-fade">{t('access.noMatch')}</div>}
            </div>
          )}
        </div>
      </main>
      {activeConnector && <AccessConnectModal connector={activeConnector} integration={byProvider[activeConnector.provider]} onClose={() => setActiveConnector(null)} onConnected={connected} t={t} />}
    </div>
  )
}

export function BridgeInboundInbox({ messages, busyId, highlightedId, onAllow, onReject, t }) {
  return (
    <section className="mb-7 rounded-2xl border border-amber-300/70 bg-amber-50/60 p-4 shadow-sm" data-testid="bridge-inbound-inbox">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800"><Inbox className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-hand text-xl text-ink">{t('access.inboundInboxTitle')}</h2>
            {messages.length > 0 && <span className="rounded-full bg-amber-200/70 px-2 py-0.5 text-[10px] font-medium text-amber-900">{messages.length}</span>}
          </div>
          <p className="mt-0.5 text-xs leading-5 text-ink-soft">{t('access.inboundInboxHint')}</p>
        </div>
      </div>

      {messages.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-amber-300/70 bg-paper/70 px-4 py-5 text-center text-xs text-ink-fade">{t('access.inboundEmpty')}</div>
      ) : (
        <div className="mt-4 space-y-3">
          {messages.map((message) => {
            const busy = busyId === message.id
            const sender = message.senderName || message.externalUserId || t('access.unknownSender')
            const text = message.payload?.text?.trim()
            const attachmentCount = Array.isArray(message.payload?.attachments) ? message.payload.attachments.length : 0
            return (
              <article
                id={`bridge-parking-${message.id}`}
                key={message.id}
                className={`rounded-xl border bg-paper p-4 transition-shadow ${highlightedId === message.id ? 'border-ember ring-2 ring-ember/25 shadow-md' : 'border-amber-200'}`}
                data-testid={`bridge-parking-${message.id}`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm font-medium text-ink">{sender}</strong>
                      <span className="rounded-full border border-ink-fade/30 bg-paper-2 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-ink-fade">{message.provider}</span>
                      <time dateTime={formatMessageDateTime(message.createdAt)} className="text-[10px] text-ink-fade">{formatMessageTime(message.createdAt)}</time>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">
                      {text || t('access.attachmentMessage').replace('{count}', String(attachmentCount))}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                    <button type="button" disabled={busy} onClick={() => onReject(message.id)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-red-200 px-3 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50">
                      <Ban className="h-3.5 w-3.5" />{t('access.rejectSender')}
                    </button>
                    <button type="button" disabled={busy} onClick={() => onAllow(message.id)} className="inline-flex h-8 min-w-28 items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-xs text-paper hover:bg-ink-soft disabled:opacity-50">
                      {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      {busy ? t('access.delivering') : t('access.allowAndDeliver')}
                    </button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function formatMessageTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

function formatMessageDateTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function ConnectorSection({ title, hint, children }) {
  return <section><div className="mb-3"><h2 className="font-hand text-xl text-ink">{title}</h2><p className="text-xs text-ink-fade mt-0.5">{hint}</p></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div></section>
}

const CAPABILITY_PRESENTATION = Object.freeze({
  [ACCESS_CAPABILITY_LEVELS.NATIVE_API]: {
    labelKey: 'access.capabilityNativeApi',
    hintKey: 'access.capabilityNativeApiHint',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
  },
  [ACCESS_CAPABILITY_LEVELS.MCP_SERVER]: {
    labelKey: 'access.capabilityMcp',
    hintKey: 'access.capabilityMcpHint',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  [ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE]: {
    labelKey: 'access.capabilitySocialBridge',
    hintKey: 'access.capabilitySocialBridgeHint',
    className: 'border-violet-200 bg-violet-50 text-violet-700',
  },
  [ACCESS_CAPABILITY_LEVELS.BROWSER_SHORTCUT]: {
    labelKey: 'access.capabilityBrowserNative',
    hintKey: 'access.capabilityBrowserNativeHint',
    className: 'border-amber-200 bg-amber-50 text-amber-800',
  },
})

export function ConnectorCapabilityBadge({ capabilityLevel, t }) {
  const presentation = CAPABILITY_PRESENTATION[capabilityLevel]
  if (!presentation) return null
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${presentation.className}`}
      data-testid={`connector-capability-${capabilityLevel}`}
      data-capability-level={capabilityLevel}
    >
      {t(presentation.labelKey)}
    </span>
  )
}

const CONNECTION_METHOD_KEYS = Object.freeze({
  built_in: 'access.methodBuiltIn',
  oauth: 'access.methodOAuth',
  qr: 'access.methodQr',
  bot_token: 'access.methodBotToken',
  app_credentials: 'access.methodAppCredentials',
  mail_password: 'access.methodMailPassword',
  mcp: 'access.methodMcp',
  browser: 'access.methodBrowser',
  qr_browser: 'access.methodQrBrowser',
})

export function ConnectionMethodBadge({ method, t }) {
  const key = CONNECTION_METHOD_KEYS[method]
  if (!key) return null
  return (
    <span className="inline-flex rounded-full border border-ink-fade/30 bg-paper-2 px-2 py-0.5 text-[10px] text-ink-soft" data-connection-method={method}>
      {t(key)}
    </span>
  )
}

function CapabilityLegend({ t }) {
  return (
    <aside className="mb-7 rounded-xl border border-ink-fade/30 bg-paper-2/60 p-3" aria-label={t('access.capabilityLegend')} data-testid="access-capability-legend">
      <p className="mb-2 text-[10px] font-mono uppercase tracking-[0.16em] text-ink-fade">{t('access.capabilityLegend')}</p>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {Object.entries(CAPABILITY_PRESENTATION).map(([capabilityLevel, presentation]) => (
          <div key={capabilityLevel} className="flex items-start gap-2 text-xs text-ink-soft">
            <ConnectorCapabilityBadge capabilityLevel={capabilityLevel} t={t} />
            <span className="leading-5">{t(presentation.hintKey)}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}

function Toggle({ enabled, onClick, disabled, label }) {
  return <button type="button" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={enabled} className={`relative w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-blue-600' : 'bg-ink-fade/40'}`}><span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} /></button>
}
