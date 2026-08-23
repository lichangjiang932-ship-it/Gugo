import {
  acquireCompactionArchivePort,
  assertCompactionArchiveGovernancePort,
} from '../core/compactionArchivePort.js'

export function acquireCompactionArchiveGovernanceLease({
  acquire = acquireCompactionArchivePort,
} = {}) {
  const lease = acquire()
  let released = false
  const release = () => {
    if (released) return false
    released = true
    return lease.release()
  }

  try {
    const port = assertCompactionArchiveGovernancePort(lease.port)
    return Object.freeze({ port, release })
  } catch (error) {
    try {
      release()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'CompactionArchivePort governance validation failed and its lease could not be released',
        { cause: releaseError },
      )
    }
    throw error
  }
}
