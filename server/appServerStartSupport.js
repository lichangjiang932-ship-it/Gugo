export function validateAppServerStartOptions({
  startBackgroundRuntimes,
  turnPersistenceAdapter,
  subagentRunPersistenceAdapter,
}) {
  if (typeof startBackgroundRuntimes !== 'function') {
    throw new TypeError('startBackgroundRuntimes must be a function')
  }
  if (!turnPersistenceAdapter) {
    const error = new Error(
      'Turn persistence must be selected by trusted runtime bootstrap before the app server starts',
    )
    error.code = 'APP_TURN_PERSISTENCE_BOOTSTRAP_REQUIRED'
    error.retryable = false
    throw error
  }
  if (!subagentRunPersistenceAdapter) {
    const error = new Error(
      'Subagent run persistence must be selected by trusted runtime bootstrap before the app server starts',
    )
    error.code = 'APP_SUBAGENT_RUN_PERSISTENCE_BOOTSTRAP_REQUIRED'
    error.retryable = false
    throw error
  }
}

export function createAppServerListeningReady({
  server,
  port,
  host,
  startupAbortGuard,
  shutdown,
  onReady,
}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const onError = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      if (settled) return
      try {
        startupAbortGuard.assertNotRequested()
      } catch (error) {
        settled = true
        void shutdown(server).then(() => reject(error), () => reject(error))
        return
      }
      settled = true
      onReady?.()
      resolve()
    })
  })
}
