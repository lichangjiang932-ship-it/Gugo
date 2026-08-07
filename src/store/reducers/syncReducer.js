import { PERSIST_KEYS } from '../appStatePersistence.js'

export function reduceSyncState(state, action) {
  switch (action.type) {
    case 'MERGE_EXTERNAL_STATE': {
      const payload = action.payload || {}
      let changed = false
      const next = { ...state }
      for (const key of PERSIST_KEYS) {
        if (payload[key] !== undefined && payload[key] !== state[key]) {
          next[key] = payload[key]
          changed = true
        }
      }
      return changed ? next : state
    }

    case 'SET_PERSISTENCE_NOTICE': {
      const notice = action.payload || null
      if (state.persistenceNotice?.level === notice?.level) return state
      return { ...state, persistenceNotice: notice }
    }

    default:
      return null
  }
}
