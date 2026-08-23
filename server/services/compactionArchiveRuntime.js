import {
  acquireCompactionArchivePort,
  assertCompactionArchivePort,
} from '../core/compactionArchivePort.js'

export function resolveCompactionArchivePort(port) {
  if (!port) {
    throw Object.assign(new TypeError('CompactionArchivePort must be provided by an active host lease'), {
      code: 'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
      retryable: false,
    })
  }
  return assertCompactionArchivePort(port)
}

function isPromiseLike(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function'
}

export function withCompactionArchivePort(port, invoke) {
  const lease = port ? null : acquireCompactionArchivePort()
  const resolved = resolveCompactionArchivePort(port || lease.port)
  let result
  try {
    result = invoke(resolved)
  } catch (error) {
    lease?.release()
    throw error
  }
  if (isPromiseLike(result)) {
    return Promise.resolve(result).finally(() => lease?.release())
  }
  lease?.release()
  return result
}
