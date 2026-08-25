import { useEffect, useState } from 'react'
import {
  connectMcpServerApi,
  deleteMcpServerApi,
  disconnectMcpOAuthApi,
  disconnectMcpServerApi,
  getMcpCatalogApi,
  getMcpOAuthStatusApi,
  listMcpServersApi,
  startMcpOAuthApi,
  testMcpServerApi,
  upsertMcpServerApi,
} from '../../lib/mcpClient.js'
import { parseKeyValueLines } from '../../lib/mcpKeyValue.js'
import { createMcpServerFromPreset } from '../../lib/mcpPresets.js'
import { formFromServer } from './mcpServerForm.js'

export default function useMcpServersController(t) {
  const [servers, setServers] = useState([])
  const [catalog, setCatalog] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [notice, setNotice] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [presetChoice, setPresetChoice] = useState('')
  const [oauthBusy, setOauthBusy] = useState(false)

  const reload = async () => {
    setLoading(true)
    setErr('')
    try {
      const [serverData, catalogData] = await Promise.all([listMcpServersApi(), getMcpCatalogApi()])
      setServers(serverData.servers || [])
      setCatalog(catalogData.catalog || [])
    } catch (error) { setErr(error.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { const timer = window.setTimeout(reload, 0); return () => window.clearTimeout(timer) }, [])
  useEffect(() => {
    const handleOAuthMessage = async (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'mcp-oauth-complete') return
      if (!event.data.ok) { setErr(event.data.message || t('mcp.oauthFailed')); return }
      try {
        const data = await getMcpOAuthStatusApi(event.data.serverId)
        setServers((current) => current.map((server) => server.id === event.data.serverId ? { ...server, oauth: data.oauth } : server))
        setEditing((current) => current?.id === event.data.serverId ? { ...current, oauth: data.oauth, oauthClientId: data.oauth?.clientId || current.oauthClientId, oauthScopes: (data.oauth?.scopes || []).join(' ') } : current)
        setErr('')
        setNotice(t('mcp.oauthConnected'))
      } catch (error) { setErr(error.message) }
    }
    window.addEventListener('message', handleOAuthMessage)
    return () => window.removeEventListener('message', handleOAuthMessage)
  }, [t])

  const selectServer = (server) => { setEditing(formFromServer(server)); setTestResult(null); setFieldErrors({}) }
  const save = async () => {
    if (!editing) return
    setSaving(true)
    setErr('')
    setFieldErrors({})
    try {
      const payload = { ...editing }
      if (typeof payload.args === 'string') payload.args = payload.args.trim().split(/\s+/).filter(Boolean)
      try { payload.env = payload.transport === 'stdio' ? parseKeyValueLines(payload.envText) : {} }
      catch (error) { setFieldErrors({ env: t('mcp.keyValueLineError', { line: error.line || 1 }) }); return }
      try { payload.headers = payload.transport === 'stdio' ? {} : parseKeyValueLines(payload.headersText) }
      catch (error) { setFieldErrors({ headers: t('mcp.keyValueLineError', { line: error.line || 1 }) }); return }
      delete payload.envText
      delete payload.headersText
      await upsertMcpServerApi(payload)
      setEditing(null)
      await reload()
    } catch (error) { setErr(error.message) }
    finally { setSaving(false) }
  }
  const remove = async (id) => {
    if (!window.confirm(t('mcp.confirmDelete'))) return
    try { await deleteMcpServerApi(id); if (editing?.id === id) setEditing(null); await reload() }
    catch (error) { setErr(error.message) }
  }
  const test = async (id) => {
    setTestResult({ loading: true })
    try { setTestResult((await testMcpServerApi(id)).capabilities) }
    catch (error) { setTestResult({ error: error.message }) }
  }
  const connect = async (id) => {
    try { const data = await connectMcpServerApi(id); setErr(''); setNotice(t('mcp.connected', { count: data.toolCount || 0 })); await reload() }
    catch (error) { setErr(error.message) }
  }
  const disconnect = async (id) => {
    try { await disconnectMcpServerApi(id); setNotice(''); await reload() }
    catch (error) { setErr(error.message) }
  }
  const choosePreset = (presetId) => {
    setPresetChoice(presetId)
    const preset = createMcpServerFromPreset(presetId)
    if (preset) selectServer(preset)
    window.setTimeout(() => setPresetChoice(''), 0)
  }
  const importParsedServers = async (parsedServers) => {
    const errors = []
    let imported = 0
    for (const server of parsedServers) {
      try { await upsertMcpServerApi(server); imported += 1 }
      catch (error) { errors.push(`${server.name || '?'}: ${error.message}`) }
    }
    await reload()
    return { imported, errors }
  }
  const startOAuth = async () => {
    if (!editing?.id) return
    const popup = globalThis.open('', 'gugo-mcp-oauth', 'popup,width=640,height=760')
    if (!popup) { setErr(t('mcp.oauthPopupBlocked')); return }
    setOauthBusy(true)
    setErr('')
    try {
      const data = await startMcpOAuthApi(editing.id, {
        clientId: editing.oauthClientId || undefined, clientSecret: editing.oauthClientSecret || undefined,
        scopes: editing.oauthScopes || undefined, authorizationEndpoint: editing.oauthAuthorizationEndpoint || undefined,
        tokenEndpoint: editing.oauthTokenEndpoint || undefined,
      })
      popup.location.replace(data.authorizationUrl)
      popup.focus()
    } catch (error) { popup.close(); setErr(error.message) }
    finally { setOauthBusy(false) }
  }
  const disconnectOAuth = async () => {
    if (!editing?.id) return
    setOauthBusy(true)
    try {
      await disconnectMcpOAuthApi(editing.id)
      const oauth = { configured: false, connected: false }
      setServers((current) => current.map((server) => server.id === editing.id ? { ...server, oauth } : server))
      setEditing((current) => current ? { ...current, oauth, oauthClientSecret: '' } : current)
      setNotice(t('mcp.oauthDisconnected'))
      setErr('')
    } catch (error) { setErr(error.message) }
    finally { setOauthBusy(false) }
  }

  return {
    catalog, choosePreset, connect, disconnect, disconnectOAuth, editing, err, fieldErrors,
    importParsedServers, loading, notice,
    oauthBusy, presetChoice, remove, save, saving, selectServer, servers, setEditing, setFieldErrors, startOAuth,
    test, testResult,
  }
}
