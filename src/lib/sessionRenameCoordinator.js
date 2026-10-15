import { normalizeSessionMutationFailure } from './sessionMutationFailure.js'

const conflict = () => Object.assign(new Error('Session changed'), { code: 'SESSION_REVISION_CONFLICT', status: 409 })
const unavailable = () => Object.assign(new Error('Local connection unavailable'), { status: 403 })

/** Serialize explicit intents; never replay an unknown write or let an older UI result win. */
export function createSessionRenameCoordinator({ getScope, canWrite, read, write, optimistic, commit, failed }) {
  const queues = new Map()
  let sequence = 0
  return async function rename(session, title) {
    const scope = getScope()
    const key = JSON.stringify([scope, session.id])
    const entry = queues.get(key) || { tail: Promise.resolve(), latest: 0, titles: new Set([session.title]), unknown: false, canonical: null, initialTitle: session.title }
    const token = ++sequence
    entry.latest = token
    entry.titles.add(title)
    optimistic(session, title)
    const operation = entry.tail.catch(() => false).then(async () => {
      try {
        if (scope !== getScope() || !canWrite()) throw unavailable()
        if (entry.unknown) throw new Error('Previous rename outcome unknown')
        const current = await read(session.id)
        if (scope !== getScope()) throw unavailable()
        if (!current) throw Object.assign(new Error('Session missing'), { code: 'SESSION_NOT_FOUND', status: 404 })
        if (!Number.isInteger(current.revision) || current.revision < 0) throw new Error('Invalid canonical revision')
        entry.canonical = current
        if (!entry.titles.has(current.title)) throw conflict()
        const result = await write(session.id, title, { expectedRevision: current.revision })
        if (!result?.session || !Number.isInteger(result.session.revision) || result.session.revision <= current.revision) {
          throw new Error('Rename result unconfirmed')
        }
        entry.canonical = result.session
        if (scope === getScope() && entry.latest === token) commit(session.id, result.session)
        return true
      } catch (error) {
        const failure = normalizeSessionMutationFailure(error)
        if (failure.outcome === 'unknown') entry.unknown = true
        if (scope === getScope() && entry.latest === token) {
          try { failed(session, title, failure, entry.canonical || { title: entry.initialTitle }) } catch { /* observer cannot change mutation outcome */ }
        }
        return false
      }
    })
    const tracked = operation.finally(() => { if (queues.get(key)?.tail === tracked) queues.delete(key) })
    entry.tail = tracked
    queues.set(key, entry)
    return operation
  }
}
