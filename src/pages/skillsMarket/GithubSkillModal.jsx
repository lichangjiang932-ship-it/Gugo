import { GitBranch, X } from 'lucide-react'
import Modal from '../../components/Modal.jsx'

export default function GithubSkillModal({ market, t }) {
  const state = market.githubState
  if (!state.open) return null
  return (
    <Modal onClose={market.closeGithub} ariaLabelledby="github-skill-modal-title" className="max-w-xl overflow-hidden flex flex-col">
        <div className="p-5 border-b border-ink-line flex items-center justify-between"><div className="flex items-center gap-2"><GitBranch className="w-4 h-4 text-ink-soft" /><h2 id="github-skill-modal-title" className="font-semibold text-xl text-ink">{t('skillsMarket.githubTitle')}</h2></div><button type="button" onClick={market.closeGithub} className="p-1 rounded hover:bg-paper-2" aria-label={t('skillsMarket.close')}><X className="w-4 h-4 text-ink-soft" /></button></div>
        <div className="p-5 space-y-3">
          <p className="text-sm text-ink-soft leading-relaxed">{t('skillsMarket.githubHint')}</p>
          <input type="url" value={state.url} onChange={(event) => market.setGithubState((current) => ({ ...current, url: event.target.value, error: '' }))} placeholder="https://github.com/owner/repo" className="input font-mono" disabled={state.busy} onKeyDown={(event) => { if (event.key === 'Enter' && !state.busy) market.installGithub() }} />
          {state.error && <div className="p-3 border border-danger/35 bg-danger/5 rounded-md text-sm text-danger">{state.error}</div>}
          {state.success && <div className="p-3 border border-ink-line bg-paper-2/50 rounded-md text-sm text-ink">{t('skillsMarket.installed')}: <span className="font-medium">{state.success.name}</span><span className="ml-2 text-ink-soft font-mono text-xs">[{state.success.source} · {state.success.repo}]</span></div>}
        </div>
        <div className="p-5 pt-0 flex items-center justify-end gap-2"><button type="button" onClick={market.closeGithub} disabled={state.busy} className="btn-ghost">{t('skillsMarket.close')}</button><button type="button" onClick={market.installGithub} disabled={state.busy || !state.url.trim()} className="btn-primary">{state.busy ? t('skillsMarket.fetching') : t('skillsMarket.fetchInstall')}</button></div>
    </Modal>
  )
}
