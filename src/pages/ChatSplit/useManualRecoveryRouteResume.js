import { useCallback } from 'react'
import { useLocation, useNavigate } from '../../lib/router.jsx'

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

export function manualRecoveryResumeFromLocation(location) {
  const resume = location?.state?.manualRecoveryResume
  if (resume?.kind !== 'turn'
    || !nonEmptyString(resume.sessionId)
    || !nonEmptyString(resume.turnId)
    || !nonEmptyString(resume.toolCallId)) return null
  return {
    kind: 'turn',
    sessionId: resume.sessionId,
    turnId: resume.turnId,
    toolCallId: resume.toolCallId,
  }
}

export default function useManualRecoveryRouteResume() {
  const location = useLocation()
  const navigate = useNavigate()
  const manualRecoveryResume = manualRecoveryResumeFromLocation(location)
  const onManualRecoveryConsumed = useCallback(() => {
    if (!manualRecoveryResumeFromLocation(location)) return false
    navigate(`${location.pathname}${location.search}${location.hash || ''}`, {
      replace: true,
      state: null,
    })
    return true
  }, [location, navigate])

  return { manualRecoveryResume, onManualRecoveryConsumed }
}
