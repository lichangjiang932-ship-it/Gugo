import { useEffect, useState } from 'react'
import { Plus, Trash2, Save, Plug, Play, Zap, X, Terminal, Globe, KeyRound } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import McpExternalConnectPanel from '../components/McpExternalConnectPanel.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import {
  listMcpServersApi,
  upsertMcpServerApi,
  deleteMcpServerApi,
  testMcpServerApi,
  connectMcpServerApi,
  disconnectMcpServerApi,
  disconnectMcpOAuthApi,
  getMcpCatalogApi,
  getMcpOAuthStatusApi,
  startMcpOAuthApi,
} from '../lib/mcpClient.js'
import { createMcpServerFromPreset, MCP_SERVER_PRESETS } from '../lib/mcpPresets.js'
import { parseKeyValueLines, serializeKeyValueLines } from '../lib/mcpKeyValue.js'

function emptyServer() {
  return {
    id: '',
    name: '',
    transport: 'http',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    enabled: true,
    autoApprove: [],
    oauthClientId: '',
    oauthClientSecret: '',
    oauthScopes: '',
    oauthAuthorizationEndpoint: '',
    oauthTokenEndpoint: '',
  }
}

function formFromServer(server) {
  return {
    ...server,
    envText: serializeKeyValueLines(server?.env),
    headersText: serializeKeyValueLines(server?.headers),
    oauthClientId: server?.oauth?.clientId || '',
    oauthClientSecret: '',
    oauthScopes: (server?.oauth?.scopes || []).join(' '),
    oauthAuthorizationEndpoint: server?.oauth?.authorizationEndpoint || '',
    oauthTokenEndpoint: server?.oauth?.tokenEndpoint || '',
  }
}

export default function McpServersView() {
  const { t } = useT()
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
  const externalEndpoint = `${window.location.origin}/mcp`

  const selectServer = (server) => {
    setEditing(formFromServer(server))
    setTestResult(null)
    setFieldErrors({})
  }

  const reload = async () => {
    setLoading(true)
    setErr('')
    try {
      const [serverData, catalogData] = await Promise.all([
        listMcpServersApi(),
        getMcpCatalogApi(),
      ])
      setServers(serverData.servers || [])
      setCatalog(catalogData.catalog || [])
    } catch (e) { setErr(e.message) } finally { setLoading(false) }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const handleOAuthMessage = async (event) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'mcp-oauth-complete') return
      if (!event.data.ok) {
        setErr(event.data.message || t('mcp.oauthFailed'))
        return
      }
      try {
        const data = await getMcpOAuthStatusApi(event.data.serverId)
        setServers((current) => current.map((server) => (
          server.id === event.data.serverId ? { ...server, oauth: data.oauth } : server
        )))
        setEditing((current) => current?.id === event.data.serverId
          ? {
              ...current,
              oauth: data.oauth,
              oauthClientId: data.oauth?.clientId || current.oauthClientId,
              oauthScopes: (data.oauth?.scopes || []).join(' '),
            }
          : current)
        setErr('')
        setNotice(t('mcp.oauthConnected'))
      } catch (error) {
        setErr(error.message)
      }
    }
    window.addEventListener('message', handleOAuthMessage)
    return () => window.removeEventListener('message', handleOAuthMessage)
  }, [t])

  const save = async () => {
    if (!editing) return
    setSaving(true)
    setErr('')
    setFieldErrors({})
    try {
      const payload = { ...editing }
      if (typeof payload.args === 'string') {
        payload.args = payload.args.trim().split(/\s+/).filter(Boolean)
      }
      try {
        payload.env = payload.transport === 'stdio' ? parseKeyValueLines(payload.envText) : {}
      } catch (parseError) {
        setFieldErrors({ env: t('mcp.keyValueLineError', { line: parseError.line || 1 }) })
        return
      }
      try {
        payload.headers = payload.transport === 'stdio' ? {} : parseKeyValueLines(payload.headersText)
      } catch (parseError) {
        setFieldErrors({ headers: t('mcp.keyValueLineError', { line: parseError.line || 1 }) })
        return
      }
      delete payload.envText
      delete payload.headersText
      await upsertMcpServerApi(payload)
      setEditing(null)
      await reload()
    } catch (e) { setErr(e.message) } finally { setSaving(false) }
  }

  const remove = async (id) => {
    if (!window.confirm(t('mcp.confirmDelete'))) return
    try {
      await deleteMcpServerApi(id)
      if (editing?.id === id) setEditing(null)
      await reload()
    } catch (e) { setErr(e.message) }
  }

  const test = async (id) => {
    setTestResult({ loading: true })
    try {
      const data = await testMcpServerApi(id)
      setTestResult(data.capabilities)
    } catch (e) {
      setTestResult({ error: e.message })
    }
  }

  const connect = async (id) => {
    try {
      const data = await connectMcpServerApi(id)
      setErr('')
      setNotice(t('mcp.connected', { count: data.toolCount || 0 }))
      await reload()
    } catch (e) { setErr(e.message) }
  }

  const choosePreset = (presetId) => {
    setPresetChoice(presetId)
    const preset = createMcpServerFromPreset(presetId)
    if (preset) {
      setEditing(formFromServer(preset))
      setTestResult(null)
      setFieldErrors({})
    }
    window.setTimeout(() => setPresetChoice(''), 0)
  }

  const disconnect = async (id) => {
    try {
      await disconnectMcpServerApi(id)
      setNotice('')
      await reload()
    } catch (e) { setErr(e.message) }
  }

  const startOAuth = async () => {
    if (!editing?.id) return
    const popup = globalThis.open('', 'gugo-mcp-oauth', 'popup,width=640,height=760')
    if (!popup) {
      setErr(t('mcp.oauthPopupBlocked'))
      return
    }
    setOauthBusy(true)
    setErr('')
    try {
      const data = await startMcpOAuthApi(editing.id, {
        clientId: editing.oauthClientId || undefined,
        clientSecret: editing.oauthClientSecret || undefined,
        scopes: editing.oauthScopes || undefined,
        authorizationEndpoint: editing.oauthAuthorizationEndpoint || undefined,
        tokenEndpoint: editing.oauthTokenEndpoint || undefined,
      })
      popup.location.replace(data.authorizationUrl)
      popup.focus()
    } catch (error) {
      popup.close()
      setErr(error.message)
    } finally {
      setOauthBusy(false)
    }
  }

  const disconnectOAuth = async () => {
    if (!editing?.id) return
    setOauthBusy(true)
    try {
      await disconnectMcpOAuthApi(editing.id)
      const oauth = { configured: false, connected: false }
      setServers((current) => current.map((server) => (
        server.id === editing.id ? { ...server, oauth } : server
      )))
      setEditing((current) => current ? { ...current, oauth, oauthClientSecret: '' } : current)
      setNotice(t('mcp.oauthDisconnected'))
      setErr('')
    } catch (error) {
      setErr(error.message)
    } finally {
      setOauthBusy(false)
    }
  }

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
          <Plug className="w-5 h-5 text-ember" />
          <div className="flex-1">
            <div className="text-base font-semibold text-ink">{t('mcp.title')}</div>
            <div className="text-[11px] text-ink-fade">{t('mcp.subtitle')}</div>
          </div>
          <label className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ember/30 px-2 text-xs text-ember hover:bg-ember/10">
            <Globe className="h-3.5 w-3.5" />
            <select value={presetChoice} onChange={(event) => choosePreset(event.target.value)} className="max-w-40 bg-transparent outline-none" aria-label={t('mcp.choosePreset')}>
              <option value="">{t('mcp.choosePreset')}</option>
              {MCP_SERVER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => { setEditing(formFromServer(emptyServer())); setFieldErrors({}) }} className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" />{t('mcp.addServer')}
          </button>
        </div>

        <McpExternalConnectPanel endpoint={externalEndpoint} />

        <div className="flex-1 flex min-h-0">
          <div className="w-[420px] border-r border-ink/10 overflow-auto">
            {loading && <div className="p-4 text-sm text-ink-fade">{t('mcp.loading')}</div>}
            {err && <div className="p-4 text-sm text-rose-700">{err}</div>}
            {notice && <div className="p-4 text-sm text-emerald-700">{notice}</div>}
            {!loading && servers.length === 0 && (
              <div className="p-6 text-center text-sm text-ink-fade">
                {t('mcp.empty')}<br />
                <pre className="mt-2 text-[10px] text-left bg-paper-2 p-2 rounded">npx -y @modelcontextprotocol/server-filesystem .</pre>
              </div>
            )}
            {servers.map((s) => {
              const runtime = catalog.find((entry) => entry.serverId === s.id)
              const connected = runtime?.connected === true
              const credentialCount = Object.keys(s.transport === 'stdio' ? (s.env || {}) : (s.headers || {})).length
              return (
              <div key={s.id} className={`border-b border-ink/5 ${editing?.id === s.id ? 'bg-ember/10' : ''}`}>
                <button type="button" onClick={() => selectServer(s)} className="w-full text-left px-4 pt-3 pb-2 hover:bg-paper-2/70">
                  <div className="flex items-center gap-2">
                    {s.transport === 'stdio' ? <Terminal className="w-3.5 h-3.5 text-ink-fade" /> : <Globe className="w-3.5 h-3.5 text-ink-fade" />}
                    <span className="text-sm font-medium text-ink truncate flex-1">{s.name}</span>
                    <span className={`inline-flex items-center gap-1 text-[10px] ${connected ? 'text-emerald-700' : 'text-ink-fade'}`}><span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-ink-fade/50'}`} />{t(connected ? 'mcp.connectedStatus' : 'mcp.stoppedStatus')}</span>
                    {!s.enabled && <span className="text-[10px] text-ink-fade">{t('mcp.disabled')}</span>}
                  </div>
                  <div className="text-[10px] text-ink-fade truncate mt-1">
                    {s.transport === 'stdio' ? `${s.command} ${(s.args || []).join(' ')}` : s.url}
                  </div>
                  <div className="mt-1 flex gap-3 text-[10px] text-ink-fade">
                    <span>{t('mcp.toolCount', { count: runtime?.tools?.length || 0 })}</span>
                    <span>{t('mcp.credentialCount', { count: credentialCount })}</span>
                    {s.oauth?.configured && (
                      <span className={s.oauth.connected ? 'text-emerald-700' : 'text-amber-700'}>
                        {t(s.oauth.connected ? 'mcp.oauthConnectedStatus' : 'mcp.oauthExpiredStatus')}
                      </span>
                    )}
                  </div>
                </button>
                <div className="px-4 pb-3 flex items-center gap-2">
                  <button type="button" onClick={() => { selectServer(s); test(s.id) }} className="text-[10px] text-ember hover:underline flex items-center gap-1">
                    <Play className="w-3 h-3" />{t('mcp.test')}
                  </button>
                  <button type="button" onClick={() => connect(s.id)} className="text-[10px] text-ember hover:underline flex items-center gap-1">
                    <Zap className="w-3 h-3" />{t('mcp.connect')}
                  </button>
                  <button type="button" onClick={() => disconnect(s.id)} className="text-[10px] text-ink-fade hover:text-ink">{t('mcp.disconnect')}</button>
                </div>
              </div>
              )
            })}
          </div>

          <div className="flex-1 overflow-auto">
            {!editing ? (
              <div className="h-full flex items-center justify-center text-sm text-ink-fade text-center px-6">
                {t('mcp.selectHint')}<br />
                <span className="text-[11px]">{t('mcp.transportHint')}</span>
              </div>
            ) : (
              <div className="max-w-[720px] mx-auto px-8 py-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-ink">{editing.id ? t('mcp.editTitle') : t('mcp.newTitle')}</div>
                  <button type="button" onClick={() => setEditing(null)} aria-label={t('mcp.close')} className="text-ink-fade hover:text-ink"><X className="w-4 h-4" /></button>
                </div>

                <Field label={t('mcp.name')}>
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember" placeholder={t('mcp.namePlaceholder')} />
                </Field>

                <Field label={t('mcp.transport')}>
                  <div className="flex gap-1.5">
                    <Chip active={editing.transport === 'stdio'} onClick={() => setEditing({ ...editing, transport: 'stdio' })}>{t('mcp.stdio')}</Chip>
                    <Chip active={editing.transport === 'http'} onClick={() => setEditing({ ...editing, transport: 'http' })}>{t('mcp.http')}</Chip>
                    <Chip active={editing.transport === 'sse'} onClick={() => setEditing({ ...editing, transport: 'sse' })}>{t('mcp.sse')}</Chip>
                  </div>
                </Field>

                {editing.transport === 'stdio' ? (
                  <>
                    <Field label={t('mcp.command')}>
                      <input value={editing.command} onChange={(e) => setEditing({ ...editing, command: e.target.value })} className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono" />
                    </Field>
                    <Field label={t('mcp.args')}>
                      <input
                        value={Array.isArray(editing.args) ? editing.args.join(' ') : editing.args || ''}
                        onChange={(e) => setEditing({ ...editing, args: e.target.value })}
                        className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono"
                      />
                    </Field>
                    <Field label={t('mcp.cwd')}>
                      <input value={editing.cwd || ''} onChange={(e) => setEditing({ ...editing, cwd: e.target.value })} className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono" placeholder={t('mcp.cwdPlaceholder')} />
                    </Field>
                    <Field label={t('mcp.env')} error={fieldErrors.env} hint={t('mcp.keyValueHint')}>
                      <textarea rows="4" value={editing.envText || ''} onChange={(e) => { setEditing({ ...editing, envText: e.target.value }); setFieldErrors((current) => ({ ...current, env: '' })) }} className="w-full px-3 py-2 text-xs bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono" placeholder={'GITHUB_TOKEN=...\nAPI_KEY=...'} spellCheck="false" />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label={t('mcp.url')}>
                      <input value={editing.url || ''} onChange={(e) => setEditing({ ...editing, url: e.target.value })} className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember" placeholder="https://your-mcp.example.com/mcp" />
                    </Field>
                    <Field label={t('mcp.headers')} error={fieldErrors.headers} hint={t('mcp.keyValueHint')}>
                      <textarea rows="4" value={editing.headersText || ''} onChange={(e) => { setEditing({ ...editing, headersText: e.target.value }); setFieldErrors((current) => ({ ...current, headers: '' })) }} className="w-full px-3 py-2 text-xs bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono" placeholder={'Authorization=Bearer ...\nX-API-Key=...'} spellCheck="false" />
                    </Field>
                    <div className="rounded-lg border border-ink/10 bg-paper-2/60 p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <KeyRound className="h-4 w-4 text-ember" />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-ink">{t('mcp.oauthTitle')}</div>
                          <div className="text-[10px] text-ink-fade">{t('mcp.oauthHint')}</div>
                        </div>
                        {editing.oauth?.configured && (
                          <span className={`rounded-full px-2 py-0.5 text-[10px] ${editing.oauth.connected ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                            {t(editing.oauth.connected ? 'mcp.oauthConnectedStatus' : 'mcp.oauthExpiredStatus')}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <Field label={t('mcp.oauthClientId')}>
                          <input value={editing.oauthClientId || ''} onChange={(event) => setEditing({ ...editing, oauthClientId: event.target.value })} className="w-full h-9 px-3 text-xs bg-paper border border-ink/15 rounded-md outline-none focus:border-ember font-mono" placeholder={t('mcp.oauthClientIdPlaceholder')} />
                        </Field>
                        <Field label={t('mcp.oauthClientSecret')}>
                          <input type="password" value={editing.oauthClientSecret || ''} onChange={(event) => setEditing({ ...editing, oauthClientSecret: event.target.value })} className="w-full h-9 px-3 text-xs bg-paper border border-ink/15 rounded-md outline-none focus:border-ember font-mono" placeholder={t('mcp.oauthOptional')} autoComplete="new-password" />
                        </Field>
                      </div>
                      <Field label={t('mcp.oauthScopes')}>
                        <input value={editing.oauthScopes || ''} onChange={(event) => setEditing({ ...editing, oauthScopes: event.target.value })} className="w-full h-9 px-3 text-xs bg-paper border border-ink/15 rounded-md outline-none focus:border-ember font-mono" placeholder="read write" />
                      </Field>
                      <details className="text-[10px] text-ink-fade">
                        <summary className="cursor-pointer select-none">{t('mcp.oauthAdvanced')}</summary>
                        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                          <Field label={t('mcp.oauthAuthorizationEndpoint')}>
                            <input value={editing.oauthAuthorizationEndpoint || ''} onChange={(event) => setEditing({ ...editing, oauthAuthorizationEndpoint: event.target.value })} className="w-full h-9 px-3 text-xs bg-paper border border-ink/15 rounded-md outline-none focus:border-ember font-mono" placeholder="https://auth.example.com/authorize" />
                          </Field>
                          <Field label={t('mcp.oauthTokenEndpoint')}>
                            <input value={editing.oauthTokenEndpoint || ''} onChange={(event) => setEditing({ ...editing, oauthTokenEndpoint: event.target.value })} className="w-full h-9 px-3 text-xs bg-paper border border-ink/15 rounded-md outline-none focus:border-ember font-mono" placeholder="https://auth.example.com/token" />
                          </Field>
                        </div>
                      </details>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={startOAuth} disabled={!editing.id || oauthBusy} className="h-8 px-3 bg-ink text-paper rounded-md text-xs hover:bg-ink/90 disabled:opacity-40 flex items-center gap-1.5">
                          <KeyRound className="h-3.5 w-3.5" />
                          {oauthBusy ? t('mcp.oauthWorking') : t('mcp.oauthConnect')}
                        </button>
                        {editing.oauth?.configured && (
                          <button type="button" onClick={disconnectOAuth} disabled={oauthBusy} className="h-8 px-3 border border-ink/15 text-ink-soft rounded-md text-xs hover:bg-paper disabled:opacity-40">
                            {t('mcp.oauthDisconnect')}
                          </button>
                        )}
                        {!editing.id && <span className="text-[10px] text-ink-fade">{t('mcp.oauthSaveFirst')}</span>}
                      </div>
                    </div>
                  </>
                )}

                <label className="flex items-center gap-2 text-xs text-ink-soft cursor-pointer">
                  <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                  {t('mcp.enabled')}
                </label>

                <div className="flex items-center gap-2 pt-2">
                  <button type="button" onClick={save} disabled={saving} className="h-8 px-4 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 disabled:opacity-50 flex items-center gap-1">
                    <Save className="w-3.5 h-3.5" />{saving ? t('mcp.saving') : t('mcp.save')}
                  </button>
                  {editing.id && (
                    <>
                      <button type="button" onClick={() => test(editing.id)} className="h-8 px-3 border border-ink/15 text-ink-soft rounded-md text-xs hover:bg-paper-2 flex items-center gap-1">
                        <Play className="w-3.5 h-3.5" />{t('mcp.testConnection')}
                      </button>
                      <button type="button" onClick={() => remove(editing.id)} className="h-8 px-3 border border-rose-300 text-rose-700 rounded-md text-xs hover:bg-rose-50 flex items-center gap-1">
                        <Trash2 className="w-3.5 h-3.5" />{t('mcp.delete')}
                      </button>
                    </>
                  )}
                </div>

                {testResult && (
                  <div className="mt-2 p-3 bg-paper-2 border border-ink/10 rounded-md text-xs">
                    {testResult.loading ? t('mcp.testing') : (
                      testResult.error ? <div className="text-rose-700">{t('mcp.error')}: {testResult.error}</div> : (
                        <div className="space-y-2">
                          {testResult.tools?.length > 0 && (
                            <div>
                              <div className="font-semibold text-ink mb-1">{t('mcp.tools')} ({testResult.tools.length})</div>
                              <ul className="text-[11px] text-ink-soft space-y-0.5">
                                {testResult.tools.map((t) => <li key={t.name}><code className="text-ember">{t.name}</code> — {t.description}</li>)}
                              </ul>
                            </div>
                          )}
                          {testResult.resources?.length > 0 && (
                            <div>
                              <div className="font-semibold text-ink mb-1">{t('mcp.resources')} ({testResult.resources.length})</div>
                            </div>
                          )}
                          {testResult.prompts?.length > 0 && (
                            <div>
                              <div className="font-semibold text-ink mb-1">{t('mcp.prompts')} ({testResult.prompts.length})</div>
                            </div>
                          )}
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, error, children }) {
  return (
    <div>
      <label className="block text-[11px] text-ink-fade mb-1.5">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-[10px] text-ink-fade">{hint}</p>}
      {error && <p className="mt-1 text-[10px] text-rose-700">{error}</p>}
    </div>
  )
}

function Chip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} className={`px-3 py-1 text-xs rounded-md border transition-colors ${active ? 'bg-ember text-paper border-ember' : 'bg-paper-2 border-ink/15 text-ink-soft hover:border-ember/50'}`}>
      {children}
    </button>
  )
}
