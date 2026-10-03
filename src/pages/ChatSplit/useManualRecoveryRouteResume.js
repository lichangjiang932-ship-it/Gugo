import { useCallback } from 'react'
import { useLocation, useNavigate } from '../../lib/router.jsx'

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && value === value.trim()
}

export function manualRecoveryResumeFromLocation(location) {
  const resume = location?.state?.manualRecoveryResume
  if (!resume || typeof resume !== 'object' || Array.isArray(resume) || resume.kind !== 'turn'
    || !nonEmptyString(resume.sessionId)
    || !nonEmptyString(resume.turnId)
    || !nonEmptyString(resume.toolCallId)) return null
  let inlineGuard = null
  if (Object.hasOwn(resume, 'inlineGuard')) {
    const guard = resume.inlineGuard
    if (!guard || typeof guard !== 'object' || Array.isArray(guard)
      || typeof guard.ownerScope !== 'string' || !guard.ownerScope || guard.ownerScope.length > 4096
      || !nonEmptyString(guard.messageId) || !Number.isSafeInteger(guard.sequence) || guard.sequence < 0) return null
    inlineGuard = { ownerScope: guard.ownerScope, messageId: guard.messageId, sequence: guard.sequence }
  }
  return {
    kind: 'turn',
    sessionId: resume.sessionId,
    turnId: resume.turnId,
    toolCallId: resume.toolCallId,
    ...(inlineGuard ? { inlineGuard } : {}),
  }
}

export default function useManualRecoveryRouteResume() {
  const location = useLocation()
  const navigate = useNavigate()
  const manualRecoveryResume = manualRecoveryResumeFromLocation(location)
  const requestManualRecoveryResume = useCallback((resume) => {
    const descriptor = manualRecoveryResumeFromLocation({ state: { manualRecoveryResume: resume } })
    const route = `${location.pathname}${location.search}${location.hash || ''}`
    if (!descriptor || location.pathname !== '/chat' || typeof window === 'undefined'
      || window.location.hash !== `#${route}`) return false
    const currentState = window.history.state
    const state = currentState && typeof currentState === 'object' && !Array.isArray(currentState)
      ? currentState : {}
    navigate(route, {
      replace: true,
      state: { ...state, manualRecoveryResume: descriptor },
    })
    return true
  }, [location, navigate])
  const onManualRecoveryConsumed = useCallback((expected = manualRecoveryResumeFromLocation(location)) => {
    const descriptor = manualRecoveryResumeFromLocation({ state: { manualRecoveryResume: expected } })
    const route = `${location.pathname}${location.search}${location.hash || ''}`
    if (!descriptor || typeof window === 'undefined' || window.location.hash !== `#${route}`) return false
    const currentState = window.history.state
    const current = manualRecoveryResumeFromLocation({ state: currentState })
    if (!current || JSON.stringify(current) !== JSON.stringify(descriptor)) return false
    const state = { ...currentState }
    delete state.manualRecoveryResume
    navigate(route, {
      replace: true,
      state: Object.keys(state).length > 0 ? state : null,
    })
    return true
  }, [location, navigate])

  return { manualRecoveryResume, onManualRecoveryConsumed, requestManualRecoveryResume }
}
