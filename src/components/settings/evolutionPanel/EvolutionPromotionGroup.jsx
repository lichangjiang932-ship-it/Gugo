import { SettingsGroup, SettingsRow } from '../SettingsPrimitives.jsx'
import { shortId } from './evolutionUtils.js'

export default function EvolutionPromotionGroup({ busy, loading, promotion, records, t }) {
  const empty = !loading && records.length === 0

  return (
    <SettingsGroup title={t('evolution.promotions')} description={t('evolution.promotionHint')}>
      {promotion.promotionReview ? (
        <div className="space-y-3 border-b border-ink/10 p-4 text-xs">
          <p className="font-medium">{promotion.promotionReview.candidate.title}</p>
          <p className="text-ink-fade">{promotion.promotionReview.candidate.summary}</p>
          <p>{t('evolution.promotionGuard')}: {promotion.promotionReview.guard.decision}</p>
          <div className="space-y-1 break-all font-mono text-xs text-ink-fade">
            <p>{t('evolution.releaseFingerprint')}: {promotion.promotionReview.confirmations.canaryReleaseFingerprint}</p>
            <p>{t('evolution.candidateHash')}: {promotion.promotionReview.confirmations.candidateContentSha256}</p>
            <p>{t('evolution.baselineFingerprint')}: {promotion.promotionReview.confirmations.rollbackBaselineSha256}</p>
            <p>{t('evolution.policyFingerprint')}: {promotion.promotionReview.confirmations.rollbackPolicyFingerprint}</p>
          </div>
          <label className="flex items-start gap-2 text-ink-soft">
            <input type="checkbox" checked={promotion.promotionConfirmed} onChange={(event) => promotion.setPromotionConfirmed(event.target.checked)} />
            <span>{t('evolution.confirmPromotionFingerprints')}</span>
          </label>
          <input className="settings-input w-full" value={promotion.promotionReason} onChange={(event) => promotion.setPromotionReason(event.target.value)} placeholder={t('evolution.promotionReasonPlaceholder')} aria-label={t('evolution.promotionReason')} />
          <div className="flex gap-2">
            <button type="button" className="settings-action-button settings-action-button-primary" disabled={Boolean(busy) || !promotion.promotionConfirmed || !promotion.promotionReason.trim()} onClick={() => void promotion.promote()}>{t('evolution.activatePromotion')}</button>
            <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => promotion.setPromotionReview(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      ) : null}
      {empty ? <SettingsRow title={t('evolution.emptyPromotions')} /> : records.slice(0, 6).map((record) => (
        <SettingsRow key={record.id} title={`${shortId(record.id)} · ${t(record.state === 'active' ? 'evolution.promotionStateActive' : 'evolution.promotionStateRevoked')}`} description={`100% · ${record.target}`}>
          {record.state === 'active' ? <button type="button" className="settings-action-button" disabled={Boolean(busy)} onClick={() => void promotion.revokePromotion(record)}>{t('evolution.revokePromotion')}</button> : null}
        </SettingsRow>
      ))}
    </SettingsGroup>
  )
}
