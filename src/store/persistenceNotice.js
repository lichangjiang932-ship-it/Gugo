export function reportPersistenceResult(dispatch, result) {
  if (result.ok && result.level === 'full') dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: null })
  else if (result.level === 'compact-metadata') dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: { level: 'compact-metadata' } })
  else if (result.level === 'quota') dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: { level: 'quota' } })
  else if (!result.ok) dispatch({ type: 'SET_PERSISTENCE_NOTICE', payload: { level: 'unavailable' } })
}
