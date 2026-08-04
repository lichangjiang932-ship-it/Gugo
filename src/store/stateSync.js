export const STATE_SYNC_META_KEY = '__sync'

const ARRAY_ENTITY_FIELDS = new Set(['sessions', 'tasks', 'history', 'permissions'])
const RECORD_ENTITY_FIELDS = new Set(['sessionDrafts', 'skillConfigs', 'toolsConfig'])
const ENTITY_FIELDS = new Set([...ARRAY_ENTITY_FIELDS, ...RECORD_ENTITY_FIELDS])

function jsonEqual(left, right) {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function normalizeClock(value) {
  const clock = Number(value)
  return Number.isFinite(clock) && clock > 0 ? clock : 0
}

function itemId(item, index) {
  if (item && typeof item === 'object' && item.id != null) return String(item.id)
  return `@index:${index}`
}

function collectionEntries(field, value) {
  if (ARRAY_ENTITY_FIELDS.has(field)) {
    return Array.isArray(value) ? value.map((item, index) => [itemId(item, index), item]) : []
  }
  if (RECORD_ENTITY_FIELDS.has(field)) {
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []
  }
  return []
}

function collectionFromEntries(field, entries) {
  if (ARRAY_ENTITY_FIELDS.has(field)) {
    const values = entries.map(([, value]) => value)
    if (field === 'sessions') {
      return values.sort((left, right) => {
        const timeDiff = Number(right?.updatedAt || right?.createdAt || 0) - Number(left?.updatedAt || left?.createdAt || 0)
        return timeDiff || String(left?.id || '').localeCompare(String(right?.id || ''))
      })
    }
    if (field === 'history') {
      return values.sort((left, right) => Number(right?.date || 0) - Number(left?.date || 0) || String(left?.id || '').localeCompare(String(right?.id || '')))
    }
    return values.sort((left, right) => String(left?.id || '').localeCompare(String(right?.id || '')))
  }
  return Object.fromEntries(entries)
}

function normalizeMeta(meta = {}) {
  return {
    version: 1,
    source: typeof meta.source === 'string' ? meta.source : '',
    writtenAt: normalizeClock(meta.writtenAt),
    fields: meta.fields && typeof meta.fields === 'object' ? { ...meta.fields } : {},
    entities: meta.entities && typeof meta.entities === 'object' ? structuredCloneSafe(meta.entities) : {},
    tombstones: meta.tombstones && typeof meta.tombstones === 'object' ? structuredCloneSafe(meta.tombstones) : {},
  }
}

function structuredCloneSafe(value) {
  if (!value || typeof value !== 'object') return {}
  try {
    if (typeof structuredClone === 'function') return structuredClone(value)
  } catch {
    // Fall through to JSON cloning for older browsers and malformed values.
  }
  try { return JSON.parse(JSON.stringify(value)) } catch { return {} }
}

function entityClock(meta, field, id) {
  return normalizeClock(meta.entities?.[field]?.[id])
}

function tombstoneClock(meta, field, id) {
  return normalizeClock(meta.tombstones?.[field]?.[id])
}

function chooseByClock(localValue, remoteValue, localClock, remoteClock, localWrittenAt, remoteWrittenAt) {
  if (remoteClock > localClock) return remoteValue
  if (localClock > remoteClock) return localValue
  if (jsonEqual(localValue, remoteValue)) return localValue
  return remoteWrittenAt > localWrittenAt ? remoteValue : localValue
}

export function readPersistedPayload(raw, fallbackTimestamp = 0) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Persisted app state must be an object')
  const snapshot = { ...parsed }
  delete snapshot[STATE_SYNC_META_KEY]
  const storedMeta = parsed[STATE_SYNC_META_KEY]
  if (storedMeta && typeof storedMeta === 'object') {
    return { snapshot, meta: normalizeMeta(storedMeta) }
  }

  const clock = normalizeClock(fallbackTimestamp)
  const fields = {}
  const entities = {}
  for (const [field, value] of Object.entries(snapshot)) {
    if (ENTITY_FIELDS.has(field)) {
      entities[field] = Object.fromEntries(collectionEntries(field, value).map(([id]) => [id, clock]))
    } else {
      fields[field] = clock
    }
  }
  return { snapshot, meta: normalizeMeta({ writtenAt: clock, fields, entities }) }
}

export function buildSyncMetadata(current, previous, previousMeta, { source = '', now = Date.now() } = {}) {
  const prior = normalizeMeta(previousMeta)
  const clock = Math.max(normalizeClock(now), prior.writtenAt + 1)
  const next = normalizeMeta(prior)
  next.source = source
  next.writtenAt = clock

  const fields = new Set([...Object.keys(previous || {}), ...Object.keys(current || {})])
  for (const field of fields) {
    if (field === STATE_SYNC_META_KEY) continue
    if (!ENTITY_FIELDS.has(field)) {
      if (!jsonEqual(previous?.[field], current?.[field]) || !normalizeClock(next.fields[field])) {
        next.fields[field] = clock
      }
      continue
    }

    const before = new Map(collectionEntries(field, previous?.[field]))
    const after = new Map(collectionEntries(field, current?.[field]))
    const versions = { ...(next.entities[field] || {}) }
    const tombstones = { ...(next.tombstones[field] || {}) }

    for (const [id, value] of after) {
      if (!before.has(id) || !jsonEqual(before.get(id), value) || !normalizeClock(versions[id])) {
        versions[id] = clock
      }
      if (normalizeClock(versions[id]) >= normalizeClock(tombstones[id])) delete tombstones[id]
    }
    for (const id of before.keys()) {
      if (!after.has(id)) {
        tombstones[id] = clock
        delete versions[id]
      }
    }

    next.entities[field] = versions
    next.tombstones[field] = tombstones
  }
  return next
}

export function mergePersistedSnapshots(localSnapshot, localMeta, remoteSnapshot, remoteMeta, { preserveLocalFields = [] } = {}) {
  const local = localSnapshot || {}
  const remote = remoteSnapshot || {}
  const leftMeta = normalizeMeta(localMeta)
  const rightMeta = normalizeMeta(remoteMeta)
  const preserve = new Set(preserveLocalFields)
  const snapshot = {}
  const meta = normalizeMeta({
    source: rightMeta.writtenAt > leftMeta.writtenAt ? rightMeta.source : leftMeta.source,
    writtenAt: Math.max(leftMeta.writtenAt, rightMeta.writtenAt),
  })

  const fields = new Set([...Object.keys(local), ...Object.keys(remote)])
  for (const field of fields) {
    if (field === STATE_SYNC_META_KEY) continue
    if (preserve.has(field)) {
      snapshot[field] = local[field]
      meta.fields[field] = normalizeClock(leftMeta.fields[field])
      continue
    }
    if (!ENTITY_FIELDS.has(field)) {
      const localClock = normalizeClock(leftMeta.fields[field])
      const remoteClock = normalizeClock(rightMeta.fields[field])
      snapshot[field] = chooseByClock(local[field], remote[field], localClock, remoteClock, leftMeta.writtenAt, rightMeta.writtenAt)
      meta.fields[field] = Math.max(localClock, remoteClock)
      continue
    }

    const left = new Map(collectionEntries(field, local[field]))
    const right = new Map(collectionEntries(field, remote[field]))
    const ids = new Set([
      ...left.keys(),
      ...right.keys(),
      ...Object.keys(leftMeta.tombstones?.[field] || {}),
      ...Object.keys(rightMeta.tombstones?.[field] || {}),
    ])
    const entries = []
    const versions = {}
    const tombstones = {}
    for (const id of ids) {
      const localClock = entityClock(leftMeta, field, id)
      const remoteClock = entityClock(rightMeta, field, id)
      const deletedAt = Math.max(tombstoneClock(leftMeta, field, id), tombstoneClock(rightMeta, field, id))
      const valueClock = Math.max(localClock, remoteClock)
      if (deletedAt >= valueClock && deletedAt > 0) {
        tombstones[id] = deletedAt
        continue
      }
      const hasLeft = left.has(id)
      const hasRight = right.has(id)
      if (!hasLeft && !hasRight) continue
      let value
      if (!hasLeft) value = right.get(id)
      else if (!hasRight) value = left.get(id)
      else value = chooseByClock(left.get(id), right.get(id), localClock, remoteClock, leftMeta.writtenAt, rightMeta.writtenAt)
      entries.push([id, value])
      versions[id] = valueClock
    }
    snapshot[field] = collectionFromEntries(field, entries)
    meta.entities[field] = versions
    meta.tombstones[field] = tombstones
  }

  return { snapshot, meta }
}

export function withSyncMetadata(snapshot, meta) {
  return { ...snapshot, [STATE_SYNC_META_KEY]: normalizeMeta(meta) }
}

export function markConvergedMetadata(meta, source, now = Date.now()) {
  const next = normalizeMeta(meta)
  next.source = source
  next.writtenAt = Math.max(normalizeClock(now), next.writtenAt + 1)
  return next
}

export function persistedSnapshotsEqual(left, right, ignoredFields = []) {
  const ignored = new Set([STATE_SYNC_META_KEY, ...ignoredFields])
  const fields = new Set([...Object.keys(left || {}), ...Object.keys(right || {})])
  for (const field of fields) {
    if (ignored.has(field)) continue
    if (!jsonEqual(left?.[field], right?.[field])) return false
  }
  return true
}
