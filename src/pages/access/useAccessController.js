import { useCallback, useEffect, useMemo, useState } from 'react'
import { filterAccessCatalog, getAccessCatalogCounts } from '../../lib/accessCatalog.js'
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
} from '../../lib/integrationsClient.js'
import { deleteMcpServerApi, getMcpCatalogApi, listMcpServersApi } from '../../lib/mcpClient.js'
import { installMcpPreset } from '../../lib/mcpPresetInstaller.js'

export default function useAccessController(t) {
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
  const highlightedParkingId = useMemo(() => typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('bridgeParkingId') || '', [])
  const catalogCounts = useMemo(() => getAccessCatalogCounts(), [])
  const byProvider = useMemo(() => Object.fromEntries(integrations.map((item) => [item.provider, item])), [integrations])
  const visible = useMemo(() => filterAccessCatalog(query), [query])
  const filtered = visible.filter((item) => activeFilter === 'all' || item.capabilityLevel === activeFilter || item.category === activeFilter)
  const connectors = {
    native: filtered.filter((item) => item.kind === 'native'),
    mcp: filtered.filter((item) => item.kind === 'mcp'),
    web: filtered.filter((item) => item.kind === 'web'),
  }

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [integrationData, parkedData, serverData, catalogData] = await Promise.all([listIntegrationsApi(), listParkedBridgeMessagesApi(), listMcpServersApi(), getMcpCatalogApi()])
      setIntegrations(integrationData.integrations || [])
      setParkedMessages(parkedData.messages || [])
      setMcpServers(serverData.servers || [])
      setMcpRuntime(catalogData.catalog || [])
    } catch (requestError) { setError(requestError.message || t('access.connectError')) }
    finally { setLoading(false) }
  }, [t])

  useEffect(() => { const timer = window.setTimeout(reload, 0); return () => window.clearTimeout(timer) }, [reload])
  useEffect(() => {
    if (!highlightedParkingId || loading) return
    document.getElementById(`bridge-parking-${highlightedParkingId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  }, [highlightedParkingId, loading])

  const rememberIntegration = useCallback((integration) => {
    if (!integration) return
    setIntegrations((items) => items.some((item) => item.id === integration.id) ? items.map((item) => item.id === integration.id ? integration : item) : [integration, ...items])
  }, [])
  const runProviderAction = async (provider, action) => {
    setBusyProvider(provider)
    setError('')
    try { await action() } catch (requestError) { setError(requestError.message || t('access.connectError')) }
    finally { setBusyProvider('') }
  }
  const toggle = (connector) => runProviderAction(connector.provider, async () => {
    const current = byProvider[connector.provider]
    const enabled = connector.provider === 'browser' ? current?.enabled !== false : current?.enabled === true
    const data = current
      ? await toggleIntegrationEnabledApi(current.id, !enabled)
      : await upsertIntegrationApi({ provider: connector.provider, name: connector.label, config: {}, secret: {}, enabled: !enabled })
    rememberIntegration(data.integration)
  })
  const connectWeb = (connector) => runProviderAction(connector.provider, async () => rememberIntegration((await connectBrowserAppApi(connector.provider)).result?.integration))
  const launchWebApp = (connector) => runProviderAction(connector.provider, () => openConnectedBrowserAppApi(connector.provider))
  const disconnect = (connector) => runProviderAction(connector.provider, async () => {
    const integration = byProvider[connector.provider]
    if (!integration) return
    await deleteIntegrationApi(integration.id)
    setIntegrations((items) => items.filter((item) => item.id !== integration.id))
  })
  const connected = useCallback((integration) => {
    if (integration) rememberIntegration(integration)
    else reload()
    setActiveConnector(null)
  }, [reload, rememberIntegration])
  const installMcp = (connector, existingServer) => runProviderAction(connector.provider, async () => {
    try {
      const installed = await installMcpPreset({ presetId: connector.presetId, existingServer })
      setMcpServers((items) => items.some((item) => item.id === installed.server.id) ? items.map((item) => item.id === installed.server.id ? installed.server : item) : [installed.server, ...items])
      setMcpRuntime((items) => [...items.filter((item) => item.serverId !== installed.server.id), installed.runtime])
    } catch (installError) {
      if (installError.disabledServer) setMcpServers((items) => items.some((item) => item.id === installError.disabledServer.id) ? items.map((item) => item.id === installError.disabledServer.id ? installError.disabledServer : item) : [installError.disabledServer, ...items])
      if (installError.message === 'MCP_PRESET_MISSING') throw new Error(t('access.mcpPresetMissing'), { cause: installError })
      throw installError
    }
  })
  const removeMcp = (connector, server) => runProviderAction(connector.provider, async () => {
    if (!server) return
    await deleteMcpServerApi(server.id)
    setMcpServers((items) => items.filter((item) => item.id !== server.id))
    setMcpRuntime((items) => items.filter((item) => item.serverId !== server.id))
  })
  const decideParkedMessage = async (parkingId, decision) => {
    setBusyParkingId(parkingId)
    setError('')
    try {
      if (decision === 'allow') await allowParkedBridgeMessageApi(parkingId)
      else await rejectParkedBridgeMessageApi(parkingId)
      setParkedMessages((items) => items.filter((item) => item.id !== parkingId))
    } catch (requestError) { setError(requestError.message || t('access.inboundActionError')) }
    finally { setBusyParkingId('') }
  }

  return {
    activeConnector, activeFilter, busyParkingId, busyProvider, byProvider, catalogCounts, connected, connectors,
    connectWeb, decideParkedMessage, disconnect, error, highlightedParkingId, installMcp, launchWebApp, loading,
    mcpRuntime, mcpServers, parkedMessages, query, removeMcp, setActiveConnector, setActiveFilter, setQuery, toggle,
  }
}
