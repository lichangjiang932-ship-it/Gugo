import { CheckCircle2, LoaderCircle, Settings2, Trash2 } from 'lucide-react'
import ConnectorBrandIcon from './ConnectorBrandIcon.jsx'

export default function AccessMcpConnectorCard({
  connector,
  server,
  runtime,
  busy,
  badge,
  onInstall,
  onRemove,
  t,
}) {
  const ready = server?.enabled === true
  const toolCount = runtime?.tools?.length || 0

  return (
    <article className="rounded-xl border border-ink-fade/35 bg-paper p-4 shadow-sm hover:-translate-y-0.5 hover:shadow-md transition-all" data-testid={`connector-${connector.provider}`}>
      <div className="flex items-start gap-3">
        <ConnectorBrandIcon connector={connector} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-ink">{connector.label}</h3>
            {badge}
            {connector.official && <span className="rounded-full border border-accent/20 bg-accent/5 px-2 py-0.5 text-xs text-accent-ink">{t('access.official')}</span>}
            {ready && <span className="inline-flex items-center gap-1 rounded-full border border-success/20 bg-success/5 px-2 py-0.5 text-xs text-success"><CheckCircle2 className="h-3 w-3" />{t('access.mcpReady')}</span>}
          </div>
          <p className="mt-1 text-xs leading-5 text-ink-soft">{t(connector.descriptionKey)}</p>
          <p className="mt-1 text-xs text-ink-fade">{t('access.publishedBy').replace('{publisher}', connector.publisher)}</p>
          {ready && toolCount > 0 && <p className="mt-2 text-xs text-success">{t('access.mcpToolCount').replace('{count}', String(toolCount))}</p>}
          {server && !ready && <p className="mt-2 text-xs text-warning">{t('access.mcpNeedsRetry')}</p>}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2 border-t border-dashed border-ink-fade/30 pt-3">
        {ready ? (
          <>
            <a href="#/mcp" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ink-fade/40 px-3 text-xs text-ink-soft hover:bg-paper-2"><Settings2 className="h-3.5 w-3.5" />{t('access.manageMcp')}</a>
            <button type="button" onClick={() => onRemove(connector, server)} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-fade hover:bg-danger/5 hover:text-danger disabled:opacity-40" aria-label={`${t('access.removeMcp')} ${connector.label}`}><Trash2 className="h-3.5 w-3.5" /></button>
          </>
        ) : (
          <button type="button" onClick={() => onInstall(connector, server)} disabled={busy} className="inline-flex h-8 min-w-28 items-center justify-center gap-1.5 rounded-md bg-ink px-4 text-xs text-paper hover:bg-ink-soft disabled:opacity-50">
            {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
            {busy ? t('access.installingMcp') : t(server ? 'access.retryMcp' : 'access.installMcp')}
          </button>
        )}
      </div>
    </article>
  )
}
