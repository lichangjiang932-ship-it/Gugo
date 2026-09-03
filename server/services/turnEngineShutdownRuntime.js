export function createTurnEngineShutdownRuntime({
  active,
  eventWriters,
  writerRetries,
  leaseReleaseRetries,
  startingSessions,
  startIdleWaiters,
  getClosePromise,
  setClosePromise,
  markClosing,
  createShutdownAbortError,
}) {
  return function shutdownTurnEngine() {
    const currentClosePromise = getClosePromise()
    if (currentClosePromise) return currentClosePromise

    markClosing()
    const attempt = (async () => {
      if (startingSessions.size > 0) {
        await new Promise((resolve) => startIdleWaiters.add(resolve))
      }
      const retryWriters = new Set(writerRetries)
      const retryLeaseReleases = new Set(leaseReleaseRetries)
      const writers = new Set([...retryWriters, ...eventWriters])
      const activeEntries = [...active.values()]
      for (const entry of activeEntries) {
        if (!entry.controller.signal.aborted) {
          entry.controller.abort(createShutdownAbortError())
        }
      }
      const activeOutcomes = await Promise.allSettled(
        activeEntries.map((entry) => entry.promise).filter(Boolean),
      )
      const pendingLeaseReleases = [...retryLeaseReleases]
      const leaseReleaseOutcomes = await Promise.allSettled(
        pendingLeaseReleases.map((release) => Promise.resolve().then(release)),
      )
      for (let index = 0; index < pendingLeaseReleases.length; index += 1) {
        const release = pendingLeaseReleases[index]
        if (leaseReleaseOutcomes[index]?.status === 'fulfilled') {
          leaseReleaseRetries.delete(release)
        } else {
          leaseReleaseRetries.add(release)
        }
      }
      for (const writer of eventWriters) writers.add(writer)
      const pendingWriters = [...writers]
      const writerOutcomes = await Promise.allSettled(pendingWriters.map((writer) => (
        Promise.resolve().then(() => (
          retryWriters.has(writer) && typeof writer.flush === 'function'
            ? writer.flush()
            : typeof writer.close === 'function' ? writer.close() : writer.flush()
        ))
      )))
      for (let index = 0; index < pendingWriters.length; index += 1) {
        const writer = pendingWriters[index]
        if (writerOutcomes[index]?.status === 'fulfilled') {
          eventWriters.delete(writer)
          writerRetries.delete(writer)
        } else {
          writerRetries.add(writer)
        }
      }
      const failures = [...new Set(
        [...activeOutcomes, ...leaseReleaseOutcomes, ...writerOutcomes]
          .filter((outcome) => outcome.status === 'rejected')
          .map((outcome) => outcome.reason),
      )]
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to shut down TurnEngine cleanly')
      }
    })()
    setClosePromise(attempt)
    void attempt.then(
      () => {},
      () => {
        if (getClosePromise() === attempt) setClosePromise(null)
      },
    )
    return attempt
  }
}
