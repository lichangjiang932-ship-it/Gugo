import { activeKey } from './turnEnginePolicy.js'

export function createTurnSchedulingRuntime({
  active,
  scheduling,
  leaseReleaseRetries,
  isClosing,
  acquireLease,
  runWithProjectDirectory,
  executeTurn,
}) {
  return async function scheduleTurn(context) {
    if (isClosing()) return false
    const key = activeKey(context.userId, context.sessionId, context.turnId)
    if (active.has(key) || scheduling.has(key)) return false
    scheduling.add(key)
    const scope = {
      userId: context.userId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
    try {
      const lease = await acquireLease(scope)
      if (!lease) return false
      if (isClosing() || active.has(key)) {
        await lease.release()
        return false
      }
      const { controller, executionLease = null } = lease
      try {
        context.emitter?.bindExecutionLease?.(executionLease)
      } catch (error) {
        await lease.release()
        throw error
      }
      const releaseLease = () => lease.release()
      const entry = {
        controller,
        executionLease,
        promise: null,
        releaseLease,
        emitter: context.emitter,
      }
      active.set(key, entry)
      entry.promise = Promise.resolve()
        .then(() => runWithProjectDirectory({
          userId: context.userId,
          projectDirectory: context.projectDirectory,
          defaultOutputDirectory: context.defaultOutputDirectory,
        }, () => executeTurn({ ...context, executionLease }, controller.signal)))
        .finally(async () => {
          let failure = null
          let failed = false
          try {
            await context.emitter?.close?.()
          } catch (error) {
            failure = error
            failed = true
          }
          try {
            await releaseLease()
            leaseReleaseRetries.delete(releaseLease)
          } catch (error) {
            leaseReleaseRetries.add(releaseLease)
            failure = error
            failed = true
          } finally {
            if (active.get(key) === entry) active.delete(key)
          }
          if (failed) throw failure
        })
      entry.promise.catch(() => {})
      return true
    } finally {
      scheduling.delete(key)
    }
  }
}
