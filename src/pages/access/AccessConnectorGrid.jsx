import { CheckCircle2, LoaderCircle, Settings2, Unplug } from 'lucide-react'
import AccessMcpConnectorCard from '../../components/AccessMcpConnectorCard.jsx'
import ConnectorBrandIcon from '../../components/ConnectorBrandIcon.jsx'
import { findInstalledMcpPreset } from '../../lib/mcpPresets.js'
import { ConnectionMethodBadge, ConnectorCapabilityBadge, ConnectorSection, Toggle } from './AccessViewPrimitives.jsx'

export default function AccessConnectorGrid({ controller, t }) {
  const { connectors } = controller
  return (
    <div className="space-y-8" data-testid="access-section">
      {connectors.native.length > 0 && <NativeConnectors connectors={connectors.native} controller={controller} t={t} />}
      {connectors.mcp.length > 0 && <McpConnectors connectors={connectors.mcp} controller={controller} t={t} />}
      {connectors.web.length > 0 && <WebConnectors connectors={connectors.web} controller={controller} t={t} />}
      {!connectors.native.length && !connectors.mcp.length && !connectors.web.length && <div className="flex h-40 items-center justify-center text-sm text-ink-fade">{t('access.noMatch')}</div>}
    </div>
  )
}

function NativeConnectors({ connectors, controller, t }) {
  return (
    <ConnectorSection title={t('access.nativeTitle')} hint={t('access.nativeHint')}>
      {connectors.map((connector) => {
        const integration = controller.byProvider[connector.provider]
        const isBrowser = connector.provider === 'browser'
        const isConnected = isBrowser || !!integration
        const enabled = isBrowser ? integration?.enabled !== false : integration?.enabled === true
        const busy = controller.busyProvider === connector.provider
        return (
          <ConnectorCard key={connector.provider} connector={connector} connected={isConnected} description={t(connector.descriptionKey)} t={t}>
            {integration?.lastTest?.message && <p className={`mt-3 text-xs ${integration.lastTest.ok ? 'text-green-700' : 'text-red-600'}`}>{integration.lastTest.message}</p>}
            <div className="mt-4 flex items-center justify-end gap-2 border-t border-dashed border-ink-fade/30 pt-3">
              {isConnected ? <>
                {!isBrowser && <button type="button" onClick={() => controller.setActiveConnector(connector)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-fade/40 px-3 text-xs text-ink-soft hover:bg-paper-2" aria-label={`${t('access.configure')} ${connector.label}`}><Settings2 className="h-3.5 w-3.5" />{t('access.configure')}</button>}
                {!isBrowser && <button type="button" onClick={() => controller.disconnect(connector)} disabled={busy} className="h-8 rounded-md px-2 text-ink-fade hover:bg-red-50 hover:text-red-600" aria-label={`${t('access.disconnect')} ${connector.label}`}><Unplug className="h-3.5 w-3.5" /></button>}
                <Toggle enabled={enabled} disabled={busy} onClick={() => controller.toggle(connector)} label={`${connector.label} ${enabled ? t('access.enabled') : t('access.disabled')}`} />
              </> : <button type="button" onClick={() => controller.setActiveConnector(connector)} className="h-8 rounded-md bg-ink px-4 text-xs text-paper hover:bg-ink-soft" aria-label={`${t('access.connect')} ${connector.label}`}>{t('access.connect')}</button>}
            </div>
          </ConnectorCard>
        )
      })}
    </ConnectorSection>
  )
}

function McpConnectors({ connectors, controller, t }) {
  return (
    <ConnectorSection title={t('access.mcpTitle')} hint={t('access.mcpHint')}>
      {connectors.map((connector) => {
        const server = findInstalledMcpPreset(controller.mcpServers, connector.presetId)
        const runtime = server ? controller.mcpRuntime.find((item) => item.serverId === server.id) : null
        return <AccessMcpConnectorCard key={connector.provider} connector={connector} server={server} runtime={runtime} busy={controller.busyProvider === connector.provider} badge={<ConnectorCapabilityBadge capabilityLevel={connector.capabilityLevel} t={t} />} onInstall={controller.installMcp} onRemove={controller.removeMcp} t={t} />
      })}
    </ConnectorSection>
  )
}

function WebConnectors({ connectors, controller, t }) {
  return (
    <ConnectorSection title={t('access.browserNativeTitle')} hint={t('access.browserNativeHint')}>
      {connectors.map((connector) => {
        const integration = controller.byProvider[connector.provider]
        const connected = !!integration
        const enabled = integration?.enabled === true
        const busy = controller.busyProvider === connector.provider
        return (
          <ConnectorCard key={connector.provider} connector={connector} connected={connected} description={t(connected ? 'access.browserNativeConnectedDesc' : 'access.browserNativeAppDesc')} persistent t={t}>
            <div className="mt-4 flex items-center justify-end gap-2 border-t border-dashed border-ink-fade/30 pt-3">
              {connected ? <>
                <button type="button" onClick={() => controller.launchWebApp(connector)} disabled={busy || !enabled} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-fade/40 px-3 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-40" aria-label={`${t('access.open')} ${connector.label}`} data-testid={`use-${connector.provider}`}>{busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : t('access.open')}</button>
                <button type="button" onClick={() => controller.disconnect(connector)} disabled={busy} className="h-8 rounded-md px-2 text-ink-fade hover:bg-red-50 hover:text-red-600 disabled:opacity-40" aria-label={`${t('access.disconnect')} ${connector.label}`}><Unplug className="h-3.5 w-3.5" /></button>
                <Toggle enabled={enabled} disabled={busy} onClick={() => controller.toggle(connector)} label={`${connector.label} ${enabled ? t('access.enabled') : t('access.disabled')}`} />
              </> : <button type="button" onClick={() => controller.connectWeb(connector)} disabled={busy} className="inline-flex h-8 min-w-20 items-center justify-center gap-1.5 rounded-md bg-ink px-4 text-xs text-paper hover:bg-ink-soft disabled:opacity-50" aria-label={`${t('access.connect')} ${connector.label}`} data-testid={`connect-${connector.provider}`}>{busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}{busy ? t('access.connecting') : t('access.connect')}</button>}
            </div>
          </ConnectorCard>
        )
      })}
    </ConnectorSection>
  )
}

function ConnectorCard({ children, connected, connector, description, persistent = false, t }) {
  return (
    <article className="rounded-xl border border-ink-fade/35 bg-paper p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md" data-testid={`connector-${connector.provider}`}>
      <div className="flex items-start gap-3"><ConnectorBrandIcon connector={connector} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-ink">{connector.label}</h3><ConnectorCapabilityBadge capabilityLevel={connector.capabilityLevel} t={t} /><ConnectionMethodBadge method={connector.connectionMethod} t={t} />{connected && <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[10px] text-green-700"><CheckCircle2 className="h-3 w-3" />{t(persistent ? 'access.persistentConnected' : 'access.connected')}</span>}</div><p className="mt-1 text-xs leading-5 text-ink-soft">{description}</p></div></div>
      {children}
    </article>
  )
}
