import { ChevronDown, Plus } from 'lucide-react'
import { providerIcon } from './providerIcon.js'

export default function IntegrationPanelHeader({ kind, kindLabel, visionStatus, visionHintOpen, onVisionHintChange, providers, menuOpen, onMenuChange, onOpenProvider, t }) {
  return <div className="flex items-start justify-between gap-3">
    <div>
      <h3 className="font-semibold text-lg text-ink">{kindLabel}</h3>
      <div className="flex items-center gap-2 mt-0.5">
        <p className="font-mono text-[10px] text-ink-fade">{kind}</p>
        {kind === 'vision_assist' && visionStatus && <span className="relative inline-flex">
          <button type="button" onClick={() => onVisionHintChange(!visionHintOpen)} onBlur={() => window.setTimeout(() => onVisionHintChange(false), 120)} className={`inline-flex items-center gap-1 h-5 px-2 rounded-full text-[10px] font-mono cursor-pointer transition-colors ${visionStatus.configured ? 'bg-success/5 text-success border border-success/30 hover:bg-success/10' : 'bg-paper-2 text-ink-fade border border-ink-fade/40 hover:bg-paper'}`} aria-label={visionStatus.configured ? t('integrations.visionAssist.badge.active') : t('integrations.visionAssist.badge.inactive')}>
            <span className={`w-1.5 h-1.5 rounded-full ${visionStatus.configured ? 'bg-success' : 'bg-ink-fade'}`} />{visionStatus.configured ? t('integrations.visionAssist.badge.active') : t('integrations.visionAssist.badge.inactive')}
          </button>
          {visionHintOpen && <span className="absolute z-30 left-0 top-6 w-72 p-2.5 rounded-md border border-ink-fade/40 bg-paper shadow-lg text-xs text-ink-soft leading-relaxed">{t('integrations.visionAssist.badge.hint')}{visionStatus.models?.length ? <span className="block mt-1.5 font-mono text-[10px] text-ink-fade truncate">{visionStatus.models.join(', ')}</span> : null}</span>}
        </span>}
      </div>
    </div>
    <div className="relative">
      <button type="button" onClick={() => onMenuChange(!menuOpen)} className="h-9 px-3 rounded-md bg-ink text-paper text-sm hover:bg-ink-soft inline-flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" />{t('integrations.addNew')}<ChevronDown className="w-3.5 h-3.5" /></button>
      {menuOpen && <div className="absolute right-0 z-30 mt-2 w-56 rounded-md border border-ink-fade/40 bg-paper shadow-xl p-1">{providers.map((provider) => {
        const Icon = providerIcon(provider.provider)
        return <button key={provider.provider} type="button" onClick={() => onOpenProvider(provider)} className="w-full px-2 py-2 rounded text-left hover:bg-paper-2 flex items-center gap-2"><Icon className="w-4 h-4 text-ink-fade" /><span className="min-w-0"><span className="block text-sm text-ink truncate">{provider.label}</span><span className="block font-mono text-[10px] text-ink-fade truncate">{provider.provider}</span></span></button>
      })}</div>}
    </div>
  </div>
}
