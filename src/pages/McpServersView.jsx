import { useEffect, useState } from 'react'
import { Plus, Trash2, Save, Plug, Play, Zap, X, Terminal, Globe } from 'lucide-react'
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
} from '../lib/mcpClient.js'

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
    headersText: '{}',
    enabled: true,
    autoApprove: [],
  }
}

export default function McpServersView() {
  const { t } = useT()
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [notice, setNotice] = useState('')
  const externalEndpoint = `${window.location.origin}/mcp`

  const selectServer = (server) => {
    setEditing({ ...server, headersText: JSON.stringify(server.headers || {}, null, 2) })
    setTestResult(null)
  }

  const reload = async () => {
    setLoading(true)
    setErr('')
    try {
      const data = await listMcpServersApi()
      setServers(data.servers || [])
    } catch (e) { setErr(e.message) } finally { setLoading(false) }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const save = async () => {
    if (!editing) return
    setSaving(true)
    setErr('')
    try {
      const payload = { ...editing }
      if (typeof payload.args === 'string') {
        payload.args = payload.args.trim().split(/\s+/).filter(Boolean)
      }
      if (payload.transport !== 'stdio') {
        payload.headers = payload.headersText?.trim() ? JSON.parse(payload.headersText) : {}
      }
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
    } catch (e) { setErr(e.message) }
  }

  const disconnect = async (id) => {
    try {
      await disconnectMcpServerApi(id)
      setNotice('')
      await reload()
    } catch (e) { setErr(e.message) }
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
          <button type="button" onClick={() => setEditing(emptyServer())} className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 flex items-center gap-1">
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
            {servers.map((s) => (
              <div key={s.id} className={`border-b border-ink/5 ${editing?.id === s.id ? 'bg-ember/10' : ''}`}>
                <button type="button" onClick={() => selectServer(s)} className="w-full text-left px-4 pt-3 pb-2 hover:bg-paper-2/70">
                  <div className="flex items-center gap-2">
                    {s.transport === 'stdio' ? <Terminal className="w-3.5 h-3.5 text-ink-fade" /> : <Globe className="w-3.5 h-3.5 text-ink-fade" />}
                    <span className="text-sm font-medium text-ink truncate flex-1">{s.name}</span>
                    {!s.enabled && <span className="text-[10px] text-ink-fade">{t('mcp.disabled')}</span>}
                  </div>
                  <div className="text-[10px] text-ink-fade truncate mt-1">
                    {s.transport === 'stdio' ? `${s.command} ${(s.args || []).join(' ')}` : s.url}
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
            ))}
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
                  </>
                ) : (
                  <>
                    <Field label={t('mcp.url')}>
                      <input value={editing.url || ''} onChange={(e) => setEditing({ ...editing, url: e.target.value })} className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember" placeholder="https://your-mcp.example.com/mcp" />
                    </Field>
                    <Field label={t('mcp.headers')}>
                      <textarea rows="4" value={editing.headersText || ''} onChange={(e) => setEditing({ ...editing, headersText: e.target.value })} className="w-full px-3 py-2 text-xs bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono" placeholder={'{"Authorization":"Bearer ..."}'} />
                    </Field>
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

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-[11px] text-ink-fade mb-1.5">{label}</label>
      {children}
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
