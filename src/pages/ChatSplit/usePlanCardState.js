import { useEffect, useState } from 'react'
import { readPlanVisible, writePlanVisible } from '../../lib/chatUiPreferences.js'

function planTodoSignature(todos) {
  return (Array.isArray(todos) ? todos : [])
    .map((todo) => `${todo?.id || todo?.content || ''}:${todo?.status || ''}`)
    .join('|')
}

/**
 * The plan card's own visibility switch.
 *
 * The card's visibility is independent of the tool panel: opening the panel
 * writes only the panel's, and closing the card writes only the card's — that
 * independence is the point, because the plan used to be a panel tab, so
 * opening the panel on another tool was the thing that hid it.
 *
 * A list that changes during the session re-opens the card over the reader's
 * earlier close, and only then: `dismissedPlanSignature` records which list was
 * dismissed, so a follow-up question that leaves the list alone does not keep
 * re-opening what was deliberately put away. Derived rather than written from an
 * effect, so there is exactly one rule and no render where the two disagree.
 */
export default function usePlanCardState({ activeSession }) {
  const [planVisible, setPlanVisible] = useState(readPlanVisible)
  useEffect(() => { writePlanVisible(planVisible) }, [planVisible])
  const planSignature = planTodoSignature(activeSession?.todos)
  const [dismissedPlanSignature, setDismissedPlanSignature] = useState('')
  const [initialPlanSignature] = useState(() => planTodoSignature(activeSession?.todos))
  const planCardVisible = planVisible
    || (planSignature !== '' && planSignature !== initialPlanSignature && planSignature !== dismissedPlanSignature)
  return {
    onOpenPlan: () => setPlanVisible(true),
    planCardVisible,
    planSignature,
    setDismissedPlanSignature,
    setPlanVisible,
  }
}
