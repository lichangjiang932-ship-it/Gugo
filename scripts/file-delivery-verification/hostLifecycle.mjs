/** Offline verification host ownership; dependencies are fakeable without opening a listener. */
export async function startVerificationHostLifecycle({
  acquirePolicy,
  createServer,
  saveSummary,
  onReady = () => {},
  processHost = process,
}) {
  let policy
  let lease
  let server
  let runtimeCleanup
  let closePromise
  let stopRequested = false
  let finishStartup
  const startupSettled = new Promise(resolve => { finishStartup = resolve })
  const signals = ['SIGINT', 'SIGTERM', 'disconnect']

  const assertStarting = () => {
    if (stopRequested) throw Object.assign(new Error('Verification host startup cancelled'), {
      code: 'FILE_DELIVERY_HOST_START_CANCELLED',
    })
  }
  const close = () => {
    stopRequested = true
    if (closePromise) return closePromise
    closePromise = (async () => {
      // A signal while importing/constructing must not release a lease still in
      // use. Startup observes stopRequested, then hands all acquired resources here.
      await startupSettled
      let failure
      const attempt = async action => {
        try { await action() } catch (error) { failure ??= error }
      }
      try {
        await attempt(() => policy?.stop('cancelled'))
        await attempt(() => server?.close())
        await attempt(() => runtimeCleanup?.())
        if (policy) await attempt(() => saveSummary(policy))
      } finally {
        for (const signal of signals) processHost.removeListener(signal, onSignal)
        await attempt(() => lease?.release())
        await attempt(() => {
          if (processHost.connected && typeof processHost.disconnect === 'function') processHost.disconnect()
        })
      }
      if (failure) throw failure
    })()
    return closePromise
  }
  const onSignal = () => {
    void close().catch(() => { processHost.exitCode = 1 })
  }
  for (const signal of signals) processHost.once(signal, onSignal)

  try {
    ;({ policy, lease } = await acquirePolicy())
    assertStarting()
    server = await createServer({
      registerRuntimeCleanup(cleanup) {
        if (typeof cleanup !== 'function' || runtimeCleanup) throw new TypeError('Invalid verification runtime cleanup')
        runtimeCleanup = cleanup
      },
    })
    assertStarting()
    await server.listen()
    assertStarting()
    await saveSummary(policy)
    assertStarting()
    await onReady()
    return { server, close, policy }
  } catch (error) {
    finishStartup()
    // Retain the startup failure as primary, but always finish the same rollback
    // receipt. No raw library error or credential-bearing message is printed.
    try { await close() } catch { processHost.exitCode = 1 }
    throw error
  } finally {
    finishStartup()
  }
}
