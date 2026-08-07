import { reduceAuthState } from './reducers/authReducer.js'
import { reduceMessageState } from './reducers/messageReducer.js'
import { reduceServerSessionState } from './reducers/serverSessionReducer.js'
import { reduceSessionLifecycleState } from './reducers/sessionLifecycleReducer.js'
import { reduceSyncState } from './reducers/syncReducer.js'
import { reduceTaskSettingsState } from './reducers/taskSettingsReducer.js'

const DOMAIN_REDUCERS = [
  reduceAuthState,
  reduceSessionLifecycleState,
  reduceServerSessionState,
  reduceMessageState,
  reduceTaskSettingsState,
  reduceSyncState,
]

export function reducer(state, action) {
  for (const domainReducer of DOMAIN_REDUCERS) {
    const nextState = domainReducer(state, action)
    if (nextState !== null) return nextState
  }
  return state
}

