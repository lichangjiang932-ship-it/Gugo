import { LoaderCircle, Search } from 'lucide-react'
import LeftRail from '../components/LeftRail.jsx'
import AccessConnectModal from '../components/AccessConnectModal.jsx'
import { ACCESS_CAPABILITY_LEVELS } from '../lib/accessCatalog.js'
import { useT } from '../i18n/I18nProvider.jsx'
import AccessConnectorGrid from './access/AccessConnectorGrid.jsx'
import { BridgeInboundInbox, CapabilityLegend } from './access/AccessViewPrimitives.jsx'
import useAccessController from './access/useAccessController.js'

export { BridgeInboundInbox, ConnectorCapabilityBadge, ConnectionMethodBadge } from './access/AccessViewPrimitives.jsx'

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
  const controller = useAccessController(t)
  const { catalogCounts } = controller

  return (
    <div className="flex h-screen overflow-hidden bg-paper">
      <LeftRail />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8 md:px-10">
          <header className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-ink-fade">{t('access.eyebrow')}</span>
              <h1 className="mt-1 font-hand text-[32px] text-ink">{t('access.title')}</h1>
              <p className="mt-1 max-w-2xl text-sm text-ink-soft">{t('access.subtitle')}</p>
            </div>
            <div className="rounded-full border border-ink-fade/40 bg-paper-2 px-4 py-2 text-xs text-ink-soft" data-testid="access-catalog-summary">
              {t('access.summary').replace('{api}', String(catalogCounts.api)).replace('{mcp}', String(catalogCounts.mcp)).replace('{bridges}', String(catalogCounts.bridges)).replace('{shortcuts}', String(catalogCounts.shortcuts))}
            </div>
          </header>
          {!controller.loading && controller.parkedMessages.length > 0 && (
            <BridgeInboundInbox
              messages={controller.parkedMessages}
              busyId={controller.busyParkingId}
              highlightedId={controller.highlightedParkingId}
              onAllow={(id) => controller.decideParkedMessage(id, 'allow')}
              onReject={(id) => controller.decideParkedMessage(id, 'reject')}
              t={t}
            />
          )}
          <label className="relative mb-3 block w-full">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-fade" />
            <input value={controller.query} onChange={(event) => controller.setQuery(event.target.value)} placeholder={t('access.searchPlaceholder')} aria-label={t('access.searchPlaceholder')} className="h-11 w-full rounded-xl border border-ink-fade/45 bg-paper pl-11 pr-4 text-sm shadow-sm outline-none focus:border-ember" />
          </label>
          <div className="mb-6 flex gap-2 overflow-x-auto pb-1" aria-label={t('access.filterLabel')}>
            {ACCESS_FILTERS.map((filter) => (
              <button key={filter.id} type="button" onClick={() => controller.setActiveFilter(filter.id)} aria-pressed={controller.activeFilter === filter.id} data-testid={`access-filter-${filter.id}`} className={`h-8 whitespace-nowrap rounded-full border px-3 text-xs transition-colors ${controller.activeFilter === filter.id ? 'border-ink bg-ink text-paper' : 'border-ink-fade/40 bg-paper text-ink-soft hover:border-ink-fade'}`}>{t(filter.labelKey)}</button>
            ))}
          </div>
          <CapabilityLegend t={t} />
          {controller.error && <div className="mb-5 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">{controller.error}</div>}
          {controller.loading ? <div className="flex h-52 items-center justify-center"><LoaderCircle className="h-6 w-6 animate-spin text-ember" /></div> : <AccessConnectorGrid controller={controller} t={t} />}
        </div>
      </main>
      {controller.activeConnector && <AccessConnectModal connector={controller.activeConnector} integration={controller.byProvider[controller.activeConnector.provider]} onClose={() => controller.setActiveConnector(null)} onConnected={controller.connected} t={t} />}
    </div>
  )
}
