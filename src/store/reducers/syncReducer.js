import { LOCAL_ONLY_PERSIST_KEYS, PERSIST_KEYS } from '../appStatePersistence.js'

function mergeSelectedFields(state, payload, keys) {
  let changed = false
  const next = { ...state }
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== state[key]) {
      next[key] = payload[key]
      changed = true
    }
  }
  return changed ? next : state
}

export function reduceSyncState(state, action) {
  switch (action.type) {
    case 'MERGE_EXTERNAL_STATE': {
      return mergeSelectedFields(state, action.payload || {}, PERSIST_KEYS)
    }

    case 'HYDRATE_LOCAL_PERSISTED_STATE': {
      return mergeSelectedFields(
        state,
        action.payload || {},
        [...PERSIST_KEYS, ...LOCAL_ONLY_PERSIST_KEYS],
      )
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
