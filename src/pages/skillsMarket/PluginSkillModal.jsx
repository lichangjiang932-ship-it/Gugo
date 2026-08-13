import { Package, X } from 'lucide-react'

export default function PluginSkillModal({ market, t }) {
  const state = market.pluginState
  if (!state.open) return null
  return (
    <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4" onClick={() => market.setPluginState((current) => ({ ...current, open: false }))}>
      <div role="dialog" aria-modal="true" className="bg-paper border border-ink/30 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-ink/20"><div className="flex items-center gap-2"><Package className="w-4 h-4" /><h2 className="font-semibold text-base">{t('skillsMarket.pluginTitle')}</h2></div><button type="button" onClick={() => market.setPluginState((current) => ({ ...current, open: false }))} className="text-ink-fade hover:text-ink" aria-label={t('skillsMarket.close')}><X className="w-4 h-4" /></button></div>
        <div className="flex-1 overflow-auto p-5">
          {state.loading && <div className="text-sm text-ink-soft">{t('skillsMarket.loading')}</div>}
          {state.error && <div className="mb-3 p-2 border border-ember-line bg-ember-soft/30 rounded-md text-sm text-ember">{state.error}</div>}
          {!state.loading && !state.bundles.length && !state.error && <div className="text-sm text-ink-soft">{t('skillsMarket.noPlugins')}</div>}
          {state.bundles.length > 0 && <ul className="divide-y divide-ink/10">{state.bundles.map((plugin) => <li key={plugin.id} className="py-3 flex items-start justify-between gap-4"><div className="min-w-0"><div className="font-medium text-sm flex items-center gap-2">{plugin.name}<span className="text-xs text-ink-fade font-mono">v{plugin.version}</span></div><div className="text-xs text-ink-fade font-mono mt-0.5">{plugin.id}</div>{plugin.description && <div className="text-xs text-ink-soft mt-1 line-clamp-2">{plugin.description}</div>}</div><button type="button" onClick={() => market.installPlugin(plugin.id)} disabled={state.installingId === plugin.id} className="shrink-0 h-8 px-3 bg-ink text-paper rounded-md text-xs font-semibold hover:bg-ink/90 disabled:opacity-50">{state.installingId === plugin.id ? t('skillsMarket.installing') : t('skillsMarket.install')}</button></li>)}</ul>}
        </div>
      </div>
    </div>
  )
}
