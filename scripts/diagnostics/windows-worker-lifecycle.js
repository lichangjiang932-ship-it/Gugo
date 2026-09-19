import { performance } from 'node:perf_hooks'

export function observeDiagnosticWorker(child, { now = () => performance.now(), startedAt = now() } = {}) {
  const events = { spawnedMs: null, payloadWriteAcknowledgedMs: null, exitedMs: null, closedMs: null }
  const mark = (key) => { events[key] ??= Math.max(0, Math.round(now() - startedAt)) }
  child.once('spawn', () => mark('spawnedMs'))
  child.once('exit', () => mark('exitedMs'))
  // Do not use events.once(): a child error is not proof that its handles closed.
  const closed = new Promise((resolve) => child.once('close', () => {
    mark('closedMs')
    resolve(true)
  }))
  const write = child.stdin?.write
  if (write) child.stdin.write = function (chunk, callback) {
    return write.call(this, chunk, (error) => {
      if (!error) mark('payloadWriteAcknowledgedMs')
      callback?.(error)
    })
  }
  return {
    snapshot: () => ({ ...events }),
    async waitForClose(timeoutMs = 5_000) {
      let timer
      try {
        return await Promise.race([
          closed,
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
        ])
      } finally { clearTimeout(timer) }
    },
  }
}
