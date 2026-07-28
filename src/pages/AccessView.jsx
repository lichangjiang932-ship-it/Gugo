import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, LoaderCircle, Search, Settings2, Unplug } from 'lucide-react'
import LeftRail from '../components/LeftRail.jsx'
import AccessConnectModal from '../components/AccessConnectModal.jsx'
import ConnectorBrandIcon from '../components/ConnectorBrandIcon.jsx'
import { ACCESS_CATALOG, filterAccessCatalog } from '../lib/accessCatalog.js'
import {
  connectBrowserAppApi,
  deleteIntegrationApi,
  listIntegrationsApi,
  openConnectedBrowserAppApi,
  toggleIntegrationEnabledApi,
  upsertIntegrationApi,
} from '../lib/integrationsClient.js'
import { useT } from '../i18n/I18nProvider.jsx'

const ACCESS_FILTERS = ['all', 'native', 'communication', 'productivity', 'creative', 'work']

export default function AccessView() {
  const { t } = useT()
  const [integrations, setIntegrations] = useState([])
  const [query, setQuery] = useState('')
  const [activeConnector, setActiveConnector] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busyProvider, setBusyProvider] = useState('')
  const [error, setError] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await listIntegrationsApi()
      setIntegrations(data.integrations || [])
    } catch (loadError) {
      setError(loadError.message || t('access.connectError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    const timer = window.setTimeout(reload, 0)
    return () => window.clearTimeout(timer)
  }, [reload])

  const byProvider = useMemo(() => Object.fromEntries(integrations.map((item) => [item.provider, item])), [integrations])
  const visible = useMemo(() => filterAccessCatalog(query), [query])
  const nativeConnectors = visible.filter((item) => item.kind === 'native' && (activeFilter === 'all' || activeFilter === 'native'))
  const webConnectors = visible.filter((item) => item.kind === 'web' && (activeFilter === 'all' || item.category === activeFilter))
  const enabledCount = ACCESS_CATALOG.filter((item) => {
    const integration = byProvider[item.provider]
    return item.provider === 'browser' ? integration?.enabled !== false : integration?.enabled === true
  }).length

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
            <div className="rounded-full border border-ink-fade/40 bg-paper-2 px-4 py-2 text-xs text-ink-soft">{t('access.summary').replace('{count}', String(enabledCount))}</div>
          </header>

          <label className="relative block w-full mb-3">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-fade" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('access.searchPlaceholder')} aria-label={t('access.searchPlaceholder')} className="w-full h-11 pl-11 pr-4 rounded-xl border border-ink-fade/45 bg-paper shadow-sm outline-none focus:border-ember text-sm" />
          </label>
          <div className="flex gap-2 mb-6 overflow-x-auto pb-1" aria-label={t('access.filterLabel')}>
            {ACCESS_FILTERS.map((filter) => (
              <button key={filter} type="button" onClick={() => setActiveFilter(filter)} aria-pressed={activeFilter === filter} data-testid={`access-filter-${filter}`} className={`h-8 px-3 rounded-full border text-xs whitespace-nowrap transition-colors ${activeFilter === filter ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-soft border-ink-fade/40 hover:border-ink-fade'}`}>
                {t(`access.filter${filter[0].toUpperCase()}${filter.slice(1)}`)}
              </button>
            ))}
          </div>

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

              {webConnectors.length > 0 && (
                <ConnectorSection title={t('access.webTitle')} hint={t('access.webHint')}>
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
                              {isConnected && <span className="text-[10px] rounded-full px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{t('access.connected')}</span>}
                            </div>
                            <p className="text-xs leading-5 text-ink-soft mt-1">{t(isConnected ? 'access.webConnectedDesc' : 'access.webAppDesc')}</p>
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-dashed border-ink-fade/30">
                          {isConnected ? <>
                            <button type="button" onClick={() => launchWebApp(connector)} disabled={busy || !enabled} className="h-8 px-3 rounded-md border border-ink-fade/40 hover:bg-paper-2 text-xs text-ink-soft disabled:opacity-40" aria-label={`${t('access.useApp')} ${connector.label}`} data-testid={`use-${connector.provider}`}>{busy ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : t('access.useApp')}</button>
                            <button type="button" onClick={() => disconnect(connector)} disabled={busy} className="h-8 px-2 rounded-md hover:bg-red-50 text-ink-fade hover:text-red-600 disabled:opacity-40" aria-label={`${t('access.disconnect')} ${connector.label}`}><Unplug className="w-3.5 h-3.5" /></button>
                            <Toggle enabled={enabled} disabled={busy} onClick={() => toggle(connector)} label={`${connector.label} ${enabled ? t('access.enabled') : t('access.disabled')}`} />
                          </> : <button type="button" onClick={() => connectWeb(connector)} disabled={busy} className="h-8 min-w-20 px-4 rounded-md bg-ink text-paper text-xs hover:bg-ink-soft disabled:opacity-50 inline-flex items-center justify-center gap-1.5" aria-label={`${t('access.connect')} ${connector.label}`} data-testid={`connect-${connector.provider}`}>{busy && <LoaderCircle className="w-3.5 h-3.5 animate-spin" />}{busy ? t('access.connecting') : t('access.connect')}</button>}
                        </div>
                      </article>
                    )
                  })}
                </ConnectorSection>
              )}

              {!nativeConnectors.length && !webConnectors.length && <div className="h-40 flex items-center justify-center text-sm text-ink-fade">{t('access.noMatch')}</div>}
            </div>
          )}
        </div>
      </main>
      {activeConnector && <AccessConnectModal connector={activeConnector} integration={byProvider[activeConnector.provider]} onClose={() => setActiveConnector(null)} onConnected={connected} t={t} />}
    </div>
  )
}

function ConnectorSection({ title, hint, children }) {
  return <section><div className="mb-3"><h2 className="font-hand text-xl text-ink">{title}</h2><p className="text-xs text-ink-fade mt-0.5">{hint}</p></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div></section>
}

function Toggle({ enabled, onClick, disabled, label }) {
  return <button type="button" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={enabled} className={`relative w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-blue-600' : 'bg-ink-fade/40'}`}><span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} /></button>
}
