import { useEffect, useState } from 'react'
import { readPlanVisible, writePlanVisible } from '../../lib/chatUiPreferences.js'
import { todosSignature } from '../../lib/sessionTodos.js'

/**
 * The plan card's own visibility switch.
 *
 * The card's visibility is independent of the tool panel: opening the panel
 * writes only the panel's, and closing the card writes only the card's — that
 * independence is the point, because the plan used to be a panel tab, so
 * opening the panel on another tool was the thing that hid it.
 *
 * A list that changes during the session re-opens the card over the reader's
 * earlier close, and only then: the remembered signature records which list was
 * dismissed, so a follow-up question that leaves the list alone does not keep
 * re-opening what was deliberately put away. The memory is scoped to the
 * session, or switching conversations would compare the new list against the old
 * conversation's baseline and pop the card open for no reason.
 */
export default function usePlanCardState({ activeSession, todos }) {
  const [planVisible, setPlanVisible] = useState(readPlanVisible)
  useEffect(() => { writePlanVisible(planVisible) }, [planVisible])
  const sessionId = activeSession?.id || ''
  const planSignature = todosSignature(todos === undefined ? activeSession?.todos : todos)
  const [planMemory, setPlanMemory] = useState(() => ({
    sessionId,
    initial: planSignature,
    dismissed: '',
  }))
  const memory = planMemory.sessionId === sessionId
    ? planMemory
    : { sessionId, initial: planSignature, dismissed: '' }
  const planCardVisible = planVisible
    || (planSignature !== '' && planSignature !== memory.initial && planSignature !== memory.dismissed)
  const dismissPlan = () => {
    setPlanVisible(false)
    setPlanMemory({ sessionId, initial: memory.initial, dismissed: planSignature })
  }
  return {
    onOpenPlan: () => setPlanVisible(true),
    onClosePlan: dismissPlan,
    planCardVisible,
    planSignature,
    setDismissedPlanSignature: (signature) => setPlanMemory({
      sessionId,
      initial: memory.initial,
      dismissed: String(signature || ''),
    }),
    setPlanVisible,
  }
}
