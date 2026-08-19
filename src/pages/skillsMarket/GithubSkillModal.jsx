import { GitBranch, X } from 'lucide-react'

export default function GithubSkillModal({ market, t }) {
  const state = market.githubState
  if (!state.open) return null
  return (
    <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4" onClick={market.closeGithub}>
      <div role="dialog" aria-modal="true" className="bg-paper border border-ink/30 rounded-lg max-w-xl w-full overflow-hidden flex flex-col" onClick={(event) => event.stopPropagation()}>
        <div className="p-5 border-b border-ink-line flex items-center justify-between"><div className="flex items-center gap-2"><GitBranch className="w-4 h-4 text-ink-soft" /><h2 className="font-semibold text-xl text-ink">{t('skillsMarket.githubTitle')}</h2></div><button type="button" onClick={market.closeGithub} className="p-1 rounded hover:bg-paper-2" aria-label={t('skillsMarket.close')}><X className="w-4 h-4 text-ink-soft" /></button></div>
        <div className="p-5 space-y-3">
          <p className="text-sm text-ink-soft leading-relaxed">{t('skillsMarket.githubHint')}</p>
          <input type="url" value={state.url} onChange={(event) => market.setGithubState((current) => ({ ...current, url: event.target.value, error: '' }))} placeholder="https://github.com/owner/repo" className="w-full px-3 py-2 border border-ink-line rounded-md text-sm text-ink bg-paper outline-none focus:border-ink/70 font-mono" disabled={state.busy} onKeyDown={(event) => { if (event.key === 'Enter' && !state.busy) market.installGithub() }} />
          {state.error && <div className="p-3 border border-danger/35 bg-danger/5 rounded-md text-sm text-danger">{state.error}</div>}
          {state.success && <div className="p-3 border border-ink-line bg-paper-2/50 rounded-md text-sm text-ink">{t('skillsMarket.installed')}: <span className="font-medium">{state.success.name}</span><span className="ml-2 text-ink-soft font-mono text-xs">[{state.success.source} · {state.success.repo}]</span></div>}
        </div>
        <div className="p-5 pt-0 flex items-center justify-end gap-2"><button type="button" onClick={market.closeGithub} disabled={state.busy} className="h-9 px-4 border border-ink/40 rounded-md font-semibold text-sm hover:bg-paper-2 disabled:opacity-50">{t('skillsMarket.close')}</button><button type="button" onClick={market.installGithub} disabled={state.busy || !state.url.trim()} className="h-9 px-4 bg-accent text-accent-contrast rounded-md font-semibold text-sm hover:bg-accent/90 disabled:opacity-50">{state.busy ? t('skillsMarket.fetching') : t('skillsMarket.fetchInstall')}</button></div>
      </div>
    </div>
  )
}
