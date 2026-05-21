import { useEffect, useState } from 'react'
import { Plus, Trash2, Save, Plug, Play, Zap, X, Terminal, Globe } from 'lucide-react'
import LeftRail from '../components/LeftRail'
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
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    env: {},
    cwd: '',
    url: '',
    headers: {},
    enabled: true,
    autoApprove: [],
  }
}

export default function McpServersView() {
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [notice, setNotice] = useState('')

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
      await upsertMcpServerApi(payload)
      setEditing(null)
      await reload()
    } catch (e) { setErr(e.message) } finally { setSaving(false) }
  }

  const remove = async (id) => {
    if (!window.confirm('删除这个 MCP server?')) return
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
      setNotice(`Connected ${data.toolCount || 0} tools`)
    } catch (e) { setErr(e.message) }
  }

  const disconnect = async (id) => {
    try {
      await disconnectMcpServerApi(id)
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
            <div className="text-base font-semibold text-ink">MCP Servers</div>
            <div className="text-[11px] text-ink-fade">连接第三方 MCP 服务器（filesystem/github/postgres 等），工具自动注入到对话</div>
          </div>
          <button type="button" onClick={() => setEditing(emptyServer())} className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" />新增 Server
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-[420px] border-r border-ink/10 overflow-auto">
            {loading && <div className="p-4 text-sm text-ink-fade">加载中…</div>}
            {err && <div className="p-4 text-sm text-rose-700">{err}</div>}
            {notice && <div className="p-4 text-sm text-emerald-700">{notice}</div>}
            {!loading && servers.length === 0 && (
              <div className="p-6 text-center text-sm text-ink-fade">
                还没有 MCP server。点「新增」配置一个，<br />比如：
                <pre className="mt-2 text-[10px] text-left bg-paper-2 p-2 rounded">npx -y @modelcontextprotocol/server-filesystem .</pre>
              </div>
            )}
            {servers.map((s) => (
              <button key={s.id} type="button" onClick={() => setEditing(s)} className={`w-full text-left border-b border-ink/5 px-4 py-3 hover:bg-paper-2 ${editing?.id === s.id ? 'bg-ember/10' : ''}`}>
                <div className="flex items-center gap-2">
                  {s.transport === 'stdio' ? <Terminal className="w-3.5 h-3.5 text-ink-fade" /> : <Globe className="w-3.5 h-3.5 text-ink-fade" />}
                  <span className="text-sm font-medium text-ink truncate flex-1">{s.name}</span>
                  {!s.enabled && <span className="text-[10px] text-ink-fade">停用</span>}
                </div>
                <div className="text-[10px] text-ink-fade truncate mt-1">
                  {s.transport === 'stdio' ? `${s.command} ${(s.args || []).join(' ')}` : s.url}
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <button type="button" onClick={(e) => { e.stopPropagation(); test(s.id) }} className="text-[10px] text-ember hover:underline flex items-center gap-1">
                    <Play className="w-3 h-3" />测试
                  </button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); connect(s.id) }} className="text-[10px] text-ember hover:underline flex items-center gap-1">
                    <Zap className="w-3 h-3" />连接
                  </button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); disconnect(s.id) }} className="text-[10px] text-ink-fade hover:text-ink">断开</button>
                </div>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto">
            {!editing ? (
              <div className="h-full flex items-center justify-center text-sm text-ink-fade text-center px-6">
                左侧选择 server，或点「新增」配置一个<br />
                <span className="text-[11px]">stdio: 通过 npx/node 拉起本地 MCP server；SSE: 远程 HTTPS 端点</span>
              </div>
            ) : (
              <div className="max-w-[720px] mx-auto px-8 py-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-ink">{editing.id ? '编辑 MCP Server' : '新建 MCP Server'}</div>
                  <button type="button" onClick={() => setEditing(null)} className="text-ink-fade hover:text-ink"><X className="w-4 h-4" /></button>
                </div>

                <Field label="名称（用作工具前缀）">
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember" placeholder="filesystem / github / postgres" />
                </Field>

                <Field label="传输方式">
                  <div className="flex gap-1.5">
                    <Chip active={editing.transport === 'stdio'} onClick={() => setEditing({ ...editing, transport: 'stdio' })}>stdio (本地子进程)</Chip>
                    <Chip active={editing.transport === 'sse'} onClick={() => setEditing({ ...editing, transport: 'sse' })}>SSE (远程 HTTPS)</Chip>
                  </div>
                </Field>

                {editing.transport === 'stdio' ? (
                  <>
                    <Field label="命令（必须在白名单: npx/node/uvx/python）">
                      <input value={editing.command} onChange={(e) => setEditing({ ...editing, command: e.target.value })} className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono" />
                    </Field>
                    <Field label="参数（空格分隔）">
                      <input
                        value={Array.isArray(editing.args) ? editing.args.join(' ') : editing.args || ''}
                        onChange={(e) => setEditing({ ...editing, args: e.target.value })}
                        className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono"
                      />
                    </Field>
                    <Field label="工作目录（可选）">
                      <input value={editing.cwd || ''} onChange={(e) => setEditing({ ...editing, cwd: e.target.value })} className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember font-mono" placeholder="留空使用项目根" />
                    </Field>
                  </>
                ) : (
                  <Field label="HTTPS URL">
                    <input value={editing.url || ''} onChange={(e) => setEditing({ ...editing, url: e.target.value })} className="w-full h-9 px-3 text-sm bg-paper-2 border border-ink/15 rounded-md outline-none focus:border-ember" placeholder="https://your-mcp.example.com" />
                  </Field>
                )}

                <label className="flex items-center gap-2 text-xs text-ink-soft cursor-pointer">
                  <input type="checkbox" checked={editing.enabled} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
                  启用（保存后立即可在对话中调用）
                </label>

                <div className="flex items-center gap-2 pt-2">
                  <button type="button" onClick={save} disabled={saving} className="h-8 px-4 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 disabled:opacity-50 flex items-center gap-1">
                    <Save className="w-3.5 h-3.5" />{saving ? '保存中…' : '保存'}
                  </button>
                  {editing.id && (
                    <>
                      <button type="button" onClick={() => test(editing.id)} className="h-8 px-3 border border-ink/15 text-ink-soft rounded-md text-xs hover:bg-paper-2 flex items-center gap-1">
                        <Play className="w-3.5 h-3.5" />测试连接
                      </button>
                      <button type="button" onClick={() => remove(editing.id)} className="h-8 px-3 border border-rose-300 text-rose-700 rounded-md text-xs hover:bg-rose-50 flex items-center gap-1">
                        <Trash2 className="w-3.5 h-3.5" />删除
                      </button>
                    </>
                  )}
                </div>

                {testResult && (
                  <div className="mt-2 p-3 bg-paper-2 border border-ink/10 rounded-md text-xs">
                    {testResult.loading ? '测试中…' : (
                      testResult.error ? <div className="text-rose-700">错误: {testResult.error}</div> : (
                        <div className="space-y-2">
                          {testResult.tools?.length > 0 && (
                            <div>
                              <div className="font-semibold text-ink mb-1">工具 ({testResult.tools.length})</div>
                              <ul className="text-[11px] text-ink-soft space-y-0.5">
                                {testResult.tools.map((t) => <li key={t.name}><code className="text-ember">{t.name}</code> — {t.description}</li>)}
                              </ul>
                            </div>
                          )}
                          {testResult.resources?.length > 0 && (
                            <div>
                              <div className="font-semibold text-ink mb-1">资源 ({testResult.resources.length})</div>
                            </div>
                          )}
                          {testResult.prompts?.length > 0 && (
                            <div>
                              <div className="font-semibold text-ink mb-1">提示词 ({testResult.prompts.length})</div>
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
