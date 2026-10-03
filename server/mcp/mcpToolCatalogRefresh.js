/** One bounded refresh lane per transport; notifications never create parallel RPCs. */
export function createMcpToolCatalogRefresh({
  transport,
  isCurrent,
  getServer,
  readTools,
  applyTools,
  onError = () => {},
  onSuccess = () => {},
  debounceMs = 20,
} = {}) {
  let active = false
  let disposed = false
  let dirty = false
  let timer = null
  let running = null
  let controller = null
  const waiters = new Set()

  const current = () => !disposed && active && isCurrent()
  const settleIdle = () => {
    if (!disposed && (timer !== null || running || (active && dirty))) return
    for (const resolve of waiters) resolve()
    waiters.clear()
  }
  const schedule = () => {
    if (disposed || !active || !dirty || running || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, debounceMs)
  }
  const refresh = async () => {
    if (!current()) { dirty = false; settleIdle(); return }
    dirty = false
    controller = new AbortController()
    const signal = controller.signal
    running = Promise.resolve().then(async () => {
      const before = getServer()
      if (!before?.enabled) throw new Error('MCP server is no longer enabled')
      const result = await readTools({ signal })
      if (!current() || signal.aborted) return
      if (!Array.isArray(result?.tools) || result.tools.some((tool) => (
        !tool || typeof tool !== 'object' || Array.isArray(tool)
        || typeof tool.name !== 'string' || !tool.name.trim()
      ))) throw new Error('MCP tools/list returned an invalid tool catalog')
      // Use current host policy, not the configuration captured before the RPC.
      const server = getServer()
      if (!server?.enabled) throw new Error('MCP server is no longer enabled')
      applyTools(server, result.tools)
      try { onSuccess() } catch { /* observers cannot revoke a successful refresh */ }
    }).catch((error) => {
      if (!current() || signal.aborted) return
      try { onError(error) } catch { /* diagnostics cannot break the refresh lane */ }
    })
    try { await running } finally {
      running = null
      controller = null
      schedule()
      settleIdle()
    }
  }
  const notify = (notification) => {
    if (disposed || notification?.method !== 'notifications/tools/list_changed') return
    dirty = true
    schedule()
  }
  const unsubscribe = typeof transport?.onNotification === 'function'
    ? transport.onNotification(notify)
    : null
  return Object.freeze({
    activate() {
      if (disposed) return
      active = true
      schedule()
    },
    dispose() {
      if (disposed) return
      disposed = true
      active = false
      dirty = false
      if (timer !== null) clearTimeout(timer)
      timer = null
      controller?.abort()
      try { unsubscribe?.() } catch { /* disposed identity still fences late notifications */ }
      settleIdle()
    },
    whenIdle() {
      if (disposed || (!running && timer === null && (!active || !dirty))) return Promise.resolve()
      return new Promise((resolve) => waiters.add(resolve))
    },
  })
}
