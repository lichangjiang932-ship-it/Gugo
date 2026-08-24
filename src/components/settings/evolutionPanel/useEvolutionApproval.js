import { useState } from 'react'
import {
  decideEvolutionApprovalApi,
  getEvolutionApprovalReviewApi,
} from '../../../lib/evolutionClient.js'
import { buildEvolutionDecisionInput } from '../evolutionDecision.js'
import { actionMessage } from './evolutionUtils.js'

export default function useEvolutionApproval({ refresh, setBusy, setMessage, t }) {
  const [review, setReview] = useState(null)
  const [decisionReason, setDecisionReason] = useState('')

  const openReview = async (evaluationId) => {
    setBusy(`review:${evaluationId}`)
    try {
      const result = await getEvolutionApprovalReviewApi(evaluationId)
      setReview(result.review)
      setDecisionReason('')
      setMessage('')
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  const decide = async (decision) => {
    const input = buildEvolutionDecisionInput(review, decision, decisionReason)
    if (!input) {
      setMessage(t('evolution.reasonRequired'))
      return
    }
    setBusy(`decision:${review.evaluationId}`)
    try {
      await decideEvolutionApprovalApi(input)
      setReview(null)
      setMessage(t(decision === 'approved' ? 'evolution.approved' : 'evolution.rejected'))
      await refresh()
    } catch (error) {
      setMessage(actionMessage(error, t))
    } finally {
      setBusy('')
    }
  }

  return {
    decide,
    decisionReason,
    openReview,
    review,
    setDecisionReason,
  }
}
