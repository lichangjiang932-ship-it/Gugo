import { SettingsGroup, SettingsRow } from '../SettingsPrimitives.jsx'
import { candidateBoundary, shortId } from './evolutionUtils.js'

export default function EvolutionOverviewGroups({ approval, busy, loading, snapshot, t }) {
  const empty = (items) => !loading && items.length === 0

  return (
    <>
      <SettingsGroup title={t('evolution.evidence')} description={t('evolution.evidenceHint')}>
        {empty(snapshot.evidence) ? <SettingsRow title={t('evolution.emptyEvidence')} /> : snapshot.evidence.slice(0, 5).map((item) => (
          <SettingsRow key={item.id} title={item.signal || item.source || shortId(item.id)} description={item.source || shortId(item.id)}>
            <span className="settings-inline-status">{item.occurrenceCount || 1}</span>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('evolution.candidates')} description={t('evolution.candidateHint')}>
        {empty(snapshot.candidates) ? <SettingsRow title={t('evolution.emptyCandidates')} /> : snapshot.candidates.slice(0, 6).map((candidate) => (
          <SettingsRow key={candidate.id} align="start" title={candidate.title || shortId(candidate.id)} description={`${candidate.summary || candidate.target || ''} · ${candidateBoundary(candidate, t)}`}>
            <span className="settings-inline-status">{candidate.kind}</span>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsGroup title={t('evolution.evaluations')} description={t('evolution.evaluationHint')}>
        {empty(snapshot.evaluations) ? <SettingsRow title={t('evolution.emptyEvaluations')} /> : snapshot.evaluations.slice(0, 6).map((evaluation) => (
          <SettingsRow key={evaluation.id} align="start" title={evaluation.summary || shortId(evaluation.id)} description={`${t('evolution.verdict')}: ${evaluation.verdict}`}>
            <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void approval.openReview(evaluation.id)}>
              {t('evolution.review')}
            </button>
          </SettingsRow>
        ))}
        {approval.review ? (
          <div className="space-y-3 border-t border-ink/10 p-4 text-xs">
            <p className="font-medium">{approval.review.candidate.title}</p>
            <p className="text-ink-fade">{approval.review.candidate.summary}</p>
            <p className="font-mono text-xs text-ink-fade">{t('evolution.candidateHash')}: {approval.review.confirmations.candidateContentSha256}</p>
            {!approval.review.eligibility.canApprove ? <p role="alert" className="text-warning">{t('evolution.notEligible')}: {approval.review.eligibility.issues.join(', ')}</p> : null}
            <input className="settings-input w-full" value={approval.decisionReason} onChange={(event) => approval.setDecisionReason(event.target.value)} placeholder={t('evolution.reasonPlaceholder')} aria-label={t('evolution.reason')} />
            <div className="flex gap-2">
              <button type="button" className="settings-action-button settings-action-button-primary" disabled={!approval.review.eligibility.canApprove || Boolean(busy) || Boolean(approval.review.existingDecision)} onClick={() => void approval.decide('approved')}>{t('evolution.approve')}</button>
              <button type="button" className="settings-action-button" disabled={Boolean(busy) || Boolean(approval.review.existingDecision)} onClick={() => void approval.decide('rejected')}>{t('evolution.reject')}</button>
            </div>
          </div>
        ) : null}
      </SettingsGroup>
    </>
  )
}
