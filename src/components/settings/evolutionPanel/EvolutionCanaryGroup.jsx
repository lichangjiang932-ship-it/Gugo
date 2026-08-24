import { SettingsGroup, SettingsRow } from '../SettingsPrimitives.jsx'
import { providerModels, shortId } from './evolutionUtils.js'

export default function EvolutionCanaryGroup({
  busy,
  canary,
  loading,
  openPromotionReview,
  providers,
  records,
  t,
}) {
  const empty = !loading && records.length === 0

  return (
    <SettingsGroup title={t('evolution.canaries')} description={t('evolution.canaryHint')}>
      <div className="grid gap-2 p-4 sm:grid-cols-3">
        <select className="settings-select" value={canary.canaryDraft.approvalId} onChange={(event) => canary.setCanaryDraft((value) => ({ ...value, approvalId: event.target.value }))} aria-label={t('evolution.approval')}>
          <option value="">{t('evolution.selectApproval')}</option>
          {canary.approved.map((item) => <option key={item.id} value={item.id}>{shortId(item.id)}</option>)}
        </select>
        <input className="settings-input" value={canary.canaryDraft.sessionIds} onChange={(event) => canary.setCanaryDraft((value) => ({ ...value, sessionIds: event.target.value }))} placeholder={t('evolution.sessionIds')} aria-label={t('evolution.sessionIds')} />
        <input className="settings-input" type="number" min="1" max="10" value={canary.canaryDraft.trafficPercent} onChange={(event) => canary.setCanaryDraft((value) => ({ ...value, trafficPercent: event.target.value }))} aria-label={t('evolution.trafficPercent')} />
        <input className="settings-input" list="evolution-provider-options" value={canary.canaryDraft.graderProviderId} onChange={(event) => canary.setCanaryDraft((value) => ({ ...value, graderProviderId: event.target.value }))} placeholder={t('evolution.onlineGraderProvider')} aria-label={t('evolution.onlineGraderProvider')} />
        <input className="settings-input" list="evolution-canary-grader-model-options" value={canary.canaryDraft.graderModel} onChange={(event) => canary.setCanaryDraft((value) => ({ ...value, graderModel: event.target.value }))} placeholder={t('evolution.onlineGraderModel')} aria-label={t('evolution.onlineGraderModel')} />
        <input className="settings-input" value={canary.canaryDraft.graderModelRevision} onChange={(event) => canary.setCanaryDraft((value) => ({ ...value, graderModelRevision: event.target.value }))} placeholder={t('evolution.onlineGraderRevision')} aria-label={t('evolution.onlineGraderRevision')} />
        <datalist id="evolution-canary-grader-model-options">
          {providerModels(providers, canary.canaryDraft.graderProviderId).map((model) => <option key={model} value={model} />)}
        </datalist>
        <button type="button" className="settings-action-button sm:col-span-3" disabled={Boolean(busy) || canary.approved.length === 0} onClick={() => void canary.createCanary()}>{t('evolution.createCanary')}</button>
      </div>
      {empty ? <SettingsRow title={t('evolution.emptyCanaries')} /> : records.slice(0, 6).map((record) => {
        const onlineState = canary.onlineGradeStates[record.id]
        const promotionReady = onlineState?.currentEvidence?.decision === 'continue'
          && onlineState.currentEvidence.latestEvaluationCurrent === true
        return (
          <div key={record.id}>
            <SettingsRow title={`${shortId(record.id)} · ${t(`evolution.state.${record.state}`)}`} description={`${record.trafficPercent}% · ${record.target}`}>
              {record.state === 'created' ? <button type="button" className="settings-action-button" disabled={Boolean(busy) || !record.rollbackPolicyConfigured || !record.onlineGraderPolicyConfigured} onClick={() => void canary.changeCanaryState(record, 'start')}>{t('evolution.start')}</button> : null}
              {record.state === 'created' && (!record.rollbackPolicyConfigured || !record.onlineGraderPolicyConfigured) ? <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void canary.resumeCanaryGuardrails(record)}>{t('evolution.configureCanaryGuardrails')}</button> : null}
              {record.state === 'active' ? <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void canary.changeCanaryState(record, 'stop')}>{t('evolution.stop')}</button> : null}
              {record.state !== 'created' ? <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void canary.loadOnlineEvidence(record)}>{t('evolution.onlineEvidence')}</button> : null}
              {record.state === 'stopped' ? <button type="button" className="settings-action-button" disabled={Boolean(busy) || !promotionReady} onClick={() => void openPromotionReview(record)}>{t('evolution.reviewPromotion')}</button> : null}
            </SettingsRow>
            {onlineState ? (
              <div className="space-y-2 border-t border-ink/10 px-4 py-3 text-xs">
                <p>{t('evolution.onlineEvidenceDecision')}: {onlineState.currentEvidence?.decision || 'insufficient_evidence'}</p>
                {onlineState.currentEvidence?.blockers?.length ? <p role="alert" className="text-warning">{onlineState.currentEvidence.blockers.join(', ')}</p> : null}
                {(onlineState.outcomes || []).map((outcome) => (
                  <div key={outcome.id} className="flex items-center justify-between gap-3">
                    <span>{outcome.variant} · {outcome.terminalState} · {outcome.gradeStatus || t('evolution.onlineGradePending')}</span>
                    {!outcome.graded ? <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void canary.gradeOnlineOutcome(record, outcome.id)}>{t('evolution.runOnlineGrade')}</button> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </SettingsGroup>
  )
}
