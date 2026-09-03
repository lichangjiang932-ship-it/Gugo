import { mergeLegacySessionQueues } from './legacySessionQueue.js'

// Keep the exported function name for compatibility with the persistence
// callers, but also retire browser-only settings that no longer exist in UI.
const RETIRED_ACCOUNT_FIELDS = Object.freeze([
  'user',
  'isLoggedIn',
  'strongAccent',
])
const LEGACY_SESSION_FIELD = 'sessions'
const PENDING_LEGACY_SESSION_FIELD = 'pendingLegacySessions'
const RETIRED_SYNC_FIELDS = Object.freeze([
  ...RETIRED_ACCOUNT_FIELDS,
  LEGACY_SESSION_FIELD,
  PENDING_LEGACY_SESSION_FIELD,
])
const SYNC_CLOCK_BUCKETS = Object.freeze(['fields', 'entities', 'tombstones'])

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Remove retired top-level browser state and its sync clocks while leaving
 * active settings and provider configuration values unchanged.
 */
export function sanitizeRetiredBrowserAccountFields(payload, {
  preservePendingLegacySessions = false,
  stageLegacySessions = false,
} = {}) {
  if (!isRecord(payload)) return { payload, changed: false, removedFields: [] }

  const removedFields = new Set()
  let sanitized = payload
  const keepPending = preservePendingLegacySessions || stageLegacySessions
  if (stageLegacySessions && Array.isArray(payload[LEGACY_SESSION_FIELD])) {
    const pending = Array.isArray(payload[PENDING_LEGACY_SESSION_FIELD])
      ? payload[PENDING_LEGACY_SESSION_FIELD]
      : []
    const staged = mergeLegacySessionQueues(pending, payload[LEGACY_SESSION_FIELD])
    if (staged.length) {
      sanitized = { ...payload, [PENDING_LEGACY_SESSION_FIELD]: staged }
    }
  }

  const retiredDataFields = [
    ...RETIRED_ACCOUNT_FIELDS,
    LEGACY_SESSION_FIELD,
    ...(keepPending ? [] : [PENDING_LEGACY_SESSION_FIELD]),
  ]
  for (const field of retiredDataFields) {
    if (!Object.hasOwn(payload, field)) continue
    if (sanitized === payload) sanitized = { ...payload }
    delete sanitized[field]
    removedFields.add(field)
  }
  if (
    keepPending
    && Object.hasOwn(sanitized, PENDING_LEGACY_SESSION_FIELD)
    && (!Array.isArray(sanitized[PENDING_LEGACY_SESSION_FIELD])
      || sanitized[PENDING_LEGACY_SESSION_FIELD].length === 0)
  ) {
    if (sanitized === payload) sanitized = { ...payload }
    delete sanitized[PENDING_LEGACY_SESSION_FIELD]
    removedFields.add(PENDING_LEGACY_SESSION_FIELD)
  }

  if (isRecord(payload.__sync)) {
    let sync = payload.__sync
    for (const bucketName of SYNC_CLOCK_BUCKETS) {
      const bucket = payload.__sync[bucketName]
      if (!isRecord(bucket)) continue
      let nextBucket = bucket
      for (const field of RETIRED_SYNC_FIELDS) {
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
