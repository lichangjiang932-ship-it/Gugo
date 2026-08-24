import { Globe, Play, Terminal, Zap } from 'lucide-react'

export default function McpServerList({ controller, t }) {
  const { catalog, editing, loading, servers } = controller
  return (
    <section className="min-h-[360px] overflow-hidden rounded-lg border border-ink/10 bg-paper" aria-label={t('mcp.title')}>
      <div className="max-h-[680px] overflow-y-auto p-2">
        {loading && <div className="px-3 py-5 text-xs text-ink-fade">{t('mcp.loading')}</div>}
        {controller.err && <div className="m-1 rounded-md border border-danger/20 bg-danger/5 px-3 py-2.5 text-xs text-danger" role="alert">{controller.err}</div>}
        {controller.notice && <div className="m-1 rounded-md border border-success/20 bg-success/5 px-3 py-2.5 text-xs text-success" role="status">{controller.notice}</div>}
        {!loading && servers.length === 0 && (
          <div className="flex min-h-[330px] flex-col items-center justify-center px-5 text-center text-xs leading-5 text-ink-fade">
            <p>{t('mcp.empty')}</p>
            <code className="mt-3 max-w-full overflow-x-auto rounded-md bg-ink/[0.035] px-2.5 py-1.5 text-left font-mono text-[10px] text-ink-soft">npx -y @modelcontextprotocol/server-filesystem .</code>
          </div>
        )}
        {servers.map((server) => {
        const runtime = catalog.find((entry) => entry.serverId === server.id)
        const connected = runtime?.connected === true
        const credentialCount = Object.keys(server.transport === 'stdio' ? (server.env || {}) : (server.headers || {})).length
        return (
          <article key={server.id} className={`rounded-md transition-colors ${editing?.id === server.id ? 'bg-ink/[0.055]' : 'hover:bg-ink/[0.025]'}`}>
            <button type="button" onClick={() => controller.selectServer(server)} className="w-full px-3 pb-2 pt-3 text-left">
              <div className="flex items-center gap-2">
                {server.transport === 'stdio' ? <Terminal className="h-3.5 w-3.5 text-ink-fade" /> : <Globe className="h-3.5 w-3.5 text-ink-fade" />}
                <span className="flex-1 truncate text-sm font-medium text-ink">{server.name}</span>
                <span className={`inline-flex items-center gap-1 text-[10px] ${connected ? 'text-success' : 'text-ink-fade'}`}><span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success' : 'bg-ink-fade/50'}`} />{t(connected ? 'mcp.connectedStatus' : 'mcp.stoppedStatus')}</span>
                {!server.enabled && <span className="text-[10px] text-ink-fade">{t('mcp.disabled')}</span>}
              </div>
              <div className="mt-1 truncate text-[10px] text-ink-fade">{server.transport === 'stdio' ? `${server.command} ${(server.args || []).join(' ')}` : server.url}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-ink-fade"><span>{t('mcp.toolCount', { count: runtime?.tools?.length || 0 })}</span><span>{t('mcp.credentialCount', { count: credentialCount })}</span>{server.oauth?.configured && <span className={server.oauth.connected ? 'text-success' : 'text-warning'}>{t(server.oauth.connected ? 'mcp.oauthConnectedStatus' : 'mcp.oauthExpiredStatus')}</span>}</div>
            </button>
            <div className="flex items-center gap-1 px-2 pb-2">
              <ListAction onClick={() => { controller.selectServer(server); controller.test(server.id) }}><Play className="h-3 w-3" />{t('mcp.test')}</ListAction>
              <ListAction onClick={() => controller.connect(server.id)}><Zap className="h-3 w-3" />{t('mcp.connect')}</ListAction>
              <ListAction onClick={() => controller.disconnect(server.id)}>{t('mcp.disconnect')}</ListAction>
            </div>
          </article>
        )
        })}
      </div>
    </section>
  )
}

function ListAction({ children, onClick }) {
  return <button type="button" onClick={onClick} className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-[10px] text-ink-fade transition-colors hover:bg-ink/[0.045] hover:text-ink">{children}</button>
}
