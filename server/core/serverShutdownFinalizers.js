const finalizersByServer = new WeakMap()
const finalizedServers = new WeakSet()

function assertServer(server) {
  if (!server || (typeof server !== 'object' && typeof server !== 'function')) {
    throw new TypeError('shutdown finalizer server must be an object or function')
  }
}

export function registerServerShutdownFinalizer(server, finalizer) {
  assertServer(server)
  if (typeof finalizer !== 'function') {
    throw new TypeError('shutdown finalizer must be a function')
  }
  if (finalizedServers.has(server)) {
    const error = new Error('server shutdown has already finalized')
    error.code = 'SERVER_SHUTDOWN_ALREADY_FINALIZED'
    error.retryable = false
    throw error
  }

  const entries = finalizersByServer.get(server) || []
  const entry = { active: true, finalizer }
  entries.push(entry)
  finalizersByServer.set(server, entries)

  return () => {
    if (!entry.active) return false
    entry.active = false
    return true
  }
}

export async function runServerShutdownFinalizers(server) {
  if (!server || (typeof server !== 'object' && typeof server !== 'function')) return false
  if (finalizedServers.has(server)) return false

  const entries = finalizersByServer.get(server) || []
  const errors = []
  for (const entry of [...entries].reverse()) {
    if (!entry.active) continue
    try {
      await entry.finalizer()
      entry.active = false
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'server shutdown finalization failed')
  }

  finalizersByServer.delete(server)
  finalizedServers.add(server)
  return entries.length > 0
}
