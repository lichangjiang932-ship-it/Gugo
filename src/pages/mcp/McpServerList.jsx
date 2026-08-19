import { Globe, Play, Terminal, Zap } from 'lucide-react'

export default function McpServerList({ controller, t }) {
  const { catalog, editing, loading, servers } = controller
  return (
    <div className="w-[420px] overflow-auto border-r border-ink/10">
      {loading && <div className="p-4 text-sm text-ink-fade">{t('mcp.loading')}</div>}
      {controller.err && <div className="p-4 text-sm text-rose-700">{controller.err}</div>}
      {controller.notice && <div className="p-4 text-sm text-emerald-700">{controller.notice}</div>}
      {!loading && servers.length === 0 && <div className="p-6 text-center text-sm text-ink-fade">{t('mcp.empty')}<pre className="mt-2 rounded bg-paper-2 p-2 text-left text-[10px]">npx -y @modelcontextprotocol/server-filesystem .</pre></div>}
      {servers.map((server) => {
        const runtime = catalog.find((entry) => entry.serverId === server.id)
        const connected = runtime?.connected === true
        const credentialCount = Object.keys(server.transport === 'stdio' ? (server.env || {}) : (server.headers || {})).length
        return (
          <div key={server.id} className={`border-b border-ink/5 ${editing?.id === server.id ? 'bg-accent/10' : ''}`}>
            <button type="button" onClick={() => controller.selectServer(server)} className="w-full px-4 pb-2 pt-3 text-left hover:bg-paper-2/70">
              <div className="flex items-center gap-2">
                {server.transport === 'stdio' ? <Terminal className="h-3.5 w-3.5 text-ink-fade" /> : <Globe className="h-3.5 w-3.5 text-ink-fade" />}
                <span className="flex-1 truncate text-sm font-medium text-ink">{server.name}</span>
                <span className={`inline-flex items-center gap-1 text-[10px] ${connected ? 'text-emerald-700' : 'text-ink-fade'}`}><span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-ink-fade/50'}`} />{t(connected ? 'mcp.connectedStatus' : 'mcp.stoppedStatus')}</span>
                {!server.enabled && <span className="text-[10px] text-ink-fade">{t('mcp.disabled')}</span>}
              </div>
              <div className="mt-1 truncate text-[10px] text-ink-fade">{server.transport === 'stdio' ? `${server.command} ${(server.args || []).join(' ')}` : server.url}</div>
              <div className="mt-1 flex gap-3 text-[10px] text-ink-fade"><span>{t('mcp.toolCount', { count: runtime?.tools?.length || 0 })}</span><span>{t('mcp.credentialCount', { count: credentialCount })}</span>{server.oauth?.configured && <span className={server.oauth.connected ? 'text-emerald-700' : 'text-amber-700'}>{t(server.oauth.connected ? 'mcp.oauthConnectedStatus' : 'mcp.oauthExpiredStatus')}</span>}</div>
            </button>
            <div className="flex items-center gap-2 px-4 pb-3"><button type="button" onClick={() => { controller.selectServer(server); controller.test(server.id) }} className="flex items-center gap-1 text-[10px] text-accent-ink hover:underline"><Play className="h-3 w-3" />{t('mcp.test')}</button><button type="button" onClick={() => controller.connect(server.id)} className="flex items-center gap-1 text-[10px] text-accent-ink hover:underline"><Zap className="h-3 w-3" />{t('mcp.connect')}</button><button type="button" onClick={() => controller.disconnect(server.id)} className="text-[10px] text-ink-fade hover:text-ink">{t('mcp.disconnect')}</button></div>
          </div>
        )
      })}
    </div>
  )
}
