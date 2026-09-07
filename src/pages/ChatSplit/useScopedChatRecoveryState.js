import { useCallback, useState } from 'react'

const EMPTY = Object.freeze({ resumeStates: {}, failedTurnRetry: null })

export default function useScopedChatRecoveryState(scope) {
  const [stored, setStored] = useState(() => ({ scope, ...EMPTY }))
  const current = stored.scope === scope ? stored : EMPTY
  const updateField = useCallback((field, update) => {
    setStored((previous) => {
      const scoped = previous.scope === scope ? previous : { scope, ...EMPTY }
      const value = typeof update === 'function' ? update(scoped[field]) : update
      return Object.is(value, scoped[field]) ? scoped : { ...scoped, [field]: value }
    })
  }, [scope])
  const setResumeStates = useCallback((update) => updateField('resumeStates', update), [updateField])
  const setFailedTurnRetry = useCallback((update) => updateField('failedTurnRetry', update), [updateField])
  return { ...current, setResumeStates, setFailedTurnRetry }
}
