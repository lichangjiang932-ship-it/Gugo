// Keep the exported function name for compatibility with the persistence
// callers, but also retire browser-only settings that no longer exist in UI.
const RETIRED_BROWSER_FIELDS = Object.freeze(['user', 'isLoggedIn', 'strongAccent'])
const SYNC_CLOCK_BUCKETS = Object.freeze(['fields', 'entities', 'tombstones'])

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Remove retired top-level browser state and its sync clocks while leaving
 * sessions, active settings, and provider configuration values unchanged.
 */
export function sanitizeRetiredBrowserAccountFields(payload) {
  if (!isRecord(payload)) return { payload, changed: false, removedFields: [] }

  const removedFields = new Set()
  let sanitized = payload
  for (const field of RETIRED_BROWSER_FIELDS) {
    if (!Object.hasOwn(payload, field)) continue
    if (sanitized === payload) sanitized = { ...payload }
    delete sanitized[field]
    removedFields.add(field)
  }

  if (isRecord(payload.__sync)) {
    let sync = payload.__sync
    for (const bucketName of SYNC_CLOCK_BUCKETS) {
      const bucket = payload.__sync[bucketName]
      if (!isRecord(bucket)) continue
      let nextBucket = bucket
      for (const field of RETIRED_BROWSER_FIELDS) {
        if (!Object.hasOwn(bucket, field)) continue
        if (nextBucket === bucket) nextBucket = { ...bucket }
        delete nextBucket[field]
        removedFields.add(field)
      }
      if (nextBucket !== bucket) {
        if (sync === payload.__sync) sync = { ...payload.__sync }
        sync[bucketName] = nextBucket
      }
    }
    if (sync !== payload.__sync) {
      if (sanitized === payload) sanitized = { ...payload }
      sanitized.__sync = sync
    }
  }

  return {
    payload: sanitized,
    changed: sanitized !== payload,
    removedFields: [...removedFields],
  }
}
