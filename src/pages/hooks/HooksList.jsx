import { Terminal, Webhook } from 'lucide-react'

export default function HooksList({ editingId, error, hooks, loading, onEdit, t }) {
  return <div className="w-[420px] overflow-auto border-r border-ink/10">
    {loading && <div className="p-4 text-sm text-ink-fade">{t('hooks.loading')}</div>}
    {error && <div className="p-4 text-sm text-rose-700">{error}</div>}
    {!loading && hooks.length === 0 && <div className="p-6 text-center text-sm text-ink-fade">{t('hooks.empty')}</div>}
    {hooks.map((hook) => <button key={hook.id} type="button" onClick={() => onEdit(hook)} className={`w-full border-b border-ink/5 px-4 py-3 text-left hover:bg-paper-2 ${editingId === hook.id ? 'bg-ember/10' : ''}`}>
      <div className="flex items-center gap-2">{hook.kind === 'shell' ? <Terminal className="h-3.5 w-3.5 text-ink-fade" /> : <Webhook className="h-3.5 w-3.5 text-ink-fade" />}<span className="font-mono text-[10px] uppercase tracking-wider text-ember">{hook.event}</span>{!hook.enabled && <span className="text-[10px] text-ink-fade">{t('hooks.disabled')}</span>}{hook.blocking && <span className="text-[10px] text-amber-700">{t('hooks.blocking')}</span>}</div>
      <div className="mt-1 truncate text-xs text-ink">{hook.kind === 'http' ? hook.url : (Array.isArray(hook.command) ? hook.command.join(' ') : '')}</div>
      <div className="mt-0.5 text-[10px] text-ink-fade">{t('hooks.matchTimeout', { pattern: hook.toolPattern || '*', timeout: hook.timeoutMs })}</div>
    </button>)}
  </div>
}
