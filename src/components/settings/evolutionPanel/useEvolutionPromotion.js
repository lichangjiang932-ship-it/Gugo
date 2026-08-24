import { useState } from 'react'
import {
  createEvolutionPromotionApi,
  getEvolutionPromotionReviewApi,
  revokeEvolutionPromotionApi,
} from '../../../lib/evolutionClient.js'
import { actionMessage } from './evolutionUtils.js'

export default function useEvolutionPromotion({ refresh, setBusy, setMessage, t }) {
  const [promotionReview, setPromotionReview] = useState(null)
  const [promotionReason, setPromotionReason] = useState('')
  const [promotionConfirmed, setPromotionConfirmed] = useState(false)

  const openPromotionReview = async (canary) => {
    setBusy(`promotion-review:${canary.id}`)
    try {
      const result = await getEvolutionPromotionReviewApi(canary.id)
      setPromotionReview(result.review)
      setPromotionReason('')
      setPromotionConfirmed(false)
      setMessage('')
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const promote = async () => {
    if (!promotionReview || !promotionReason.trim() || !promotionConfirmed) {
      setMessage(t('evolution.promotionConfirmationRequired'))
      return
    }
    setBusy(`promote:${promotionReview.canaryReleaseId}`)
    try {
      await createEvolutionPromotionApi({
        canaryReleaseId: promotionReview.canaryReleaseId,
        reason: promotionReason.trim(),
        confirmations: promotionReview.confirmations,
      })
      setPromotionReview(null)
      setPromotionReason('')
      setPromotionConfirmed(false)
      setMessage(t('evolution.promotionActivated'))
      await refresh()
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const revokePromotion = async (promotion) => {
    setBusy(`revoke-promotion:${promotion.id}`)
    try {
      await revokeEvolutionPromotionApi(promotion.id, t('evolution.promotionRevokeReason'))
      setMessage(t('evolution.promotionRevoked'))
      await refresh()
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  return {
    openPromotionReview,
    promote,
    promotionConfirmed,
    promotionReason,
    promotionReview,
    revokePromotion,
    setPromotionConfirmed,
    setPromotionReason,
    setPromotionReview,
  }
}
