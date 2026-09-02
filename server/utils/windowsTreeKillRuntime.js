import { spawn } from 'node:child_process'
import { sanitizeChildEnv } from './sensitiveEnv.js'
import {
  windowsPowerShellPath,
  windowsTreeKillWorkerArgs,
  windowsTreeKillWorkerPayload,
} from './windowsTreeKillWorkerSource.js'

const INTERNAL_TIMEOUT_MS = 4_000
const STARTUP_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = INTERNAL_TIMEOUT_MS + 4_000
const IDENTITY_CLOCK_SETTLE_MS = 20
function unixNowMs() {
  return Date.now()
}
function workerError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function settledIdentityCutoff(signal) {
  if (signal?.aborted) {
    return Promise.reject(workerError(
      'WINDOWS_TREE_KILL_TARGET_EXITED',
      'Windows 进程树清理目标在身份确认前已退出',
    ))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(workerError(
        'WINDOWS_TREE_KILL_TARGET_EXITED',
        'Windows 进程树清理目标在身份确认前已退出',
      ))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(unixNowMs())
    }, IDENTITY_CLOCK_SETTLE_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function setReferenced(child, referenced) {
  const method = referenced ? 'ref' : 'unref'
  child?.[method]?.()
  child?.stdin?.[method]?.()
  child?.stdout?.[method]?.()
  child?.stderr?.[method]?.()
}

function detachAbort(pending) {
  if (pending?.signal && pending.abortListener) {
    pending.signal.removeEventListener('abort', pending.abortListener)
  }
}

function detachReadyWaiter(waiter) {
  if (waiter?.timer) clearTimeout(waiter.timer)
  waiter.timer = null
  if (waiter?.signal && waiter.abortListener) {
    waiter.signal.removeEventListener('abort', waiter.abortListener)
  }
}

export function createWindowsTreeKillWorkerManager({
  spawnProcess = spawn,
  workerPath = windowsPowerShellPath(),
  workerArgs = windowsTreeKillWorkerArgs(),
  workerPayload = windowsTreeKillWorkerPayload(),
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  let activeWorker = null
  let generation = 0
  let nextRequestId = 0
  let nextLeaseId = 0
  let spawnCount = 0

  const refreshReference = (worker) => {
    if (!worker) return
    setReferenced(
      worker.child,
      !worker.failed && (worker.pending.size > 0 || worker.readyWaiters.size > 0),
    )
  }

  const failWorker = (worker, error, { terminate = true } = {}) => {
    if (!worker || worker.failed) return
    worker.failed = true
    if (worker.startupTimer) clearTimeout(worker.startupTimer)
    worker.startupTimer = null
    if (activeWorker === worker) activeWorker = null
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer)
      clearTimeout(pending.writeTimer)
      detachAbort(pending)
      pending.reject(error)
    }
    for (const waiter of worker.readyWaiters) {
      detachReadyWaiter(waiter)
      waiter.reject(error)
    }
    worker.readyWaiters.clear()
    worker.pending.clear()
    worker.queue.length = 0
    refreshReference(worker)
    if (terminate) {
      try { worker.child.stdin?.destroy() } catch { /* already closed */ }
      try { worker.child.kill('SIGKILL') } catch { /* already exited */ }
    }
  }

  const flushQueue = (worker) => {
    if (!worker?.ready || worker.failed) return
    while (worker.queue.length > 0) {
      const requestId = worker.queue.shift()
      const pending = worker.pending.get(requestId)
      if (!pending || pending.sent) continue
      pending.sent = true
      try {
        worker.child.stdin.write(`${pending.line}\n`, (error) => {
          clearTimeout(pending.writeTimer)
          pending.writeTimer = null
          if (error) {
            failWorker(worker, workerError(
              'WINDOWS_TREE_KILL_WORKER_WRITE_FAILED',
              `Windows 进程树清理 worker 写入失败：${error?.message || String(error)}`,
            ))
            return
          }
          if (worker.pending.get(requestId) !== pending || worker.failed) return
          pending.timer = setTimeout(() => {
            failWorker(worker, workerError(
              'WINDOWS_TREE_KILL_WORKER_REQUEST_TIMEOUT',
              'Windows 进程树清理 worker 请求超时',
            ))
          }, requestTimeoutMs)
          pending.timer.unref?.()
        })
        pending.writeTimer = setTimeout(() => {
          failWorker(worker, workerError(
            'WINDOWS_TREE_KILL_WORKER_WRITE_TIMEOUT',
            'Windows 进程树清理 worker 写入超时',
          ))
        }, requestTimeoutMs)
        pending.writeTimer.unref?.()
      } catch (error) {
        failWorker(worker, workerError(
          'WINDOWS_TREE_KILL_WORKER_WRITE_FAILED',
          `Windows 进程树清理 worker 写入失败：${error?.message || String(error)}`,
        ))
        return
      }
    }
  }

  const acceptLine = (worker, rawLine) => {
    const line = String(rawLine || '').replace(/^\uFEFF/u, '').replace(/\r$/u, '')
    if (!line) return
    if (!worker.ready) {
      if (line !== 'READY\t2') {
        failWorker(worker, workerError(
          'WINDOWS_TREE_KILL_WORKER_PROTOCOL_ERROR',
          'Windows 进程树清理 worker 启动握手无效',
        ))
        return
      }
      worker.ready = true
      if (worker.startupTimer) clearTimeout(worker.startupTimer)
      worker.startupTimer = null
      for (const waiter of worker.readyWaiters) {
        detachReadyWaiter(waiter)
        waiter.resolve(true)
      }
      worker.readyWaiters.clear()
      refreshReference(worker)
      flushQueue(worker)
      return
    }
    const fields = line.split('\t')
    if (fields.length !== 2 || (fields[1] !== '0' && fields[1] !== '1')) {
      failWorker(worker, workerError(
        'WINDOWS_TREE_KILL_WORKER_PROTOCOL_ERROR',
        'Windows 进程树清理 worker 返回了无效响应',
      ))
      return
    }
    const pending = worker.pending.get(fields[0])
    if (!pending) {
      failWorker(worker, workerError(
        'WINDOWS_TREE_KILL_WORKER_PROTOCOL_ERROR',
        'Windows 进程树清理 worker 返回了未知请求响应',
      ))
      return
    }
    clearTimeout(pending.timer)
    clearTimeout(pending.writeTimer)
    detachAbort(pending)
    worker.pending.delete(fields[0])
    pending.resolve(fields[1] === '1')
    refreshReference(worker)
  }

  const spawnWorker = () => {
    let child
    try {
      child = spawnProcess(workerPath, workerArgs, {
        env: sanitizeChildEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch (error) {
      throw workerError(
        'WINDOWS_TREE_KILL_WORKER_START_FAILED',
        `Windows 进程树清理 worker 启动失败：${error?.message || String(error)}`,
      )
    }
    const worker = {
      child,
      generation: ++generation,
      ready: false,
      failed: false,
      stdoutBuffer: '',
      pending: new Map(),
      queue: [],
      readyWaiters: new Set(),
      startupTimer: null,
    }
    activeWorker = worker
    spawnCount += 1
    refreshReference(worker)
    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => {
      if (worker.failed) return
      worker.stdoutBuffer += String(chunk || '')
      while (true) {
        const newlineAt = worker.stdoutBuffer.indexOf('\n')
        if (newlineAt < 0) break
        const next = worker.stdoutBuffer.slice(0, newlineAt)
        worker.stdoutBuffer = worker.stdoutBuffer.slice(newlineAt + 1)
        acceptLine(worker, next)
        if (worker.failed) return
      }
    })
    child.stdin?.on('error', (error) => failWorker(worker, workerError(
      'WINDOWS_TREE_KILL_WORKER_PIPE_FAILED',
      `Windows 进程树清理 worker 输入管道失败：${error?.message || String(error)}`,
    )))
    child.stdout?.on('error', (error) => failWorker(worker, workerError(
      'WINDOWS_TREE_KILL_WORKER_PIPE_FAILED',
      `Windows 进程树清理 worker 输出管道失败：${error?.message || String(error)}`,
    )))
    child.once('error', (error) => {
      failWorker(worker, workerError(
        'WINDOWS_TREE_KILL_WORKER_CRASHED',
        `Windows 进程树清理 worker 异常：${error?.message || String(error)}`,
      ), { terminate: false })
    })
    child.once('close', (code, signal) => {
      failWorker(worker, workerError(
        'WINDOWS_TREE_KILL_WORKER_CRASHED',
        `Windows 进程树清理 worker 已退出${typeof code === 'number' ? ` (code=${code})` : ''}${signal ? ` (${signal})` : ''}`,
      ), { terminate: false })
    })
    if (!child.stdin || !child.stdout) {
      queueMicrotask(() => failWorker(worker, workerError(
        'WINDOWS_TREE_KILL_WORKER_PIPE_FAILED',
        'Windows 进程树清理 worker 缺少协议管道',
      )))
      return worker
    }
    worker.startupTimer = setTimeout(() => failWorker(worker, workerError(
      'WINDOWS_TREE_KILL_WORKER_START_TIMEOUT',
      'Windows 进程树清理 worker 启动超时',
    )), startupTimeoutMs)
    worker.startupTimer.unref?.()
    if (workerPayload) {
      try {
        child.stdin.write(`${workerPayload}\n`, (error) => {
          if (!error || worker.failed) return
          failWorker(worker, workerError(
            'WINDOWS_TREE_KILL_WORKER_BOOTSTRAP_FAILED',
            `Windows 进程树清理 worker 源码传输失败：${error?.message || String(error)}`,
          ))
        })
      } catch (error) {
        failWorker(worker, workerError(
          'WINDOWS_TREE_KILL_WORKER_BOOTSTRAP_FAILED',
          `Windows 进程树清理 worker 源码传输失败：${error?.message || String(error)}`,
        ))
      }
    }
    return worker
  }

  const ensureWorker = () => (
    activeWorker && !activeWorker.failed ? activeWorker : spawnWorker()
  )

  const ready = ({ signal = null, timeoutMs = null } = {}) => {
    if (signal?.aborted) {
      return Promise.reject(workerError(
        'WINDOWS_TREE_KILL_WORKER_READY_ABORTED',
        'Windows 进程树清理 worker 准备已取消',
      ))
    }
    const requestedTimeout = timeoutMs == null ? null : Math.floor(Number(timeoutMs))
    if (requestedTimeout != null && (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0)) {
      return Promise.reject(workerError(
        'WINDOWS_TREE_KILL_WORKER_READY_TIMEOUT',
        'Windows 进程树清理 worker 准备超时',
      ))
    }
    let worker
    try { worker = ensureWorker() } catch (error) { return Promise.reject(error) }
    if (worker.ready) return Promise.resolve(true)
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abortListener: null,
        timer: null,
      }
      const rejectWaiter = (error) => {
        if (!worker.readyWaiters.delete(waiter)) return
        detachReadyWaiter(waiter)
        reject(error)
        refreshReference(worker)
      }
      waiter.abortListener = () => rejectWaiter(workerError(
        'WINDOWS_TREE_KILL_WORKER_READY_ABORTED',
        'Windows 进程树清理 worker 准备已取消',
      ))
      if (requestedTimeout != null) {
        waiter.timer = setTimeout(() => rejectWaiter(workerError(
          'WINDOWS_TREE_KILL_WORKER_READY_TIMEOUT',
          'Windows 进程树清理 worker 准备超时',
        )), requestedTimeout)
      }
      signal?.addEventListener('abort', waiter.abortListener, { once: true })
      worker.readyWaiters.add(waiter)
      refreshReference(worker)
      if (signal?.aborted) waiter.abortListener()
    })
  }

  const prewarm = () => {
    try { ensureWorker(); return true } catch { return false }
  }

  const enqueue = (worker, line, { signal = null } = {}) => {
    if (signal?.aborted) {
      return Promise.reject(workerError(
        'WINDOWS_TREE_KILL_TARGET_EXITED',
        'Windows 进程树清理目标已退出',
      ))
    }
    const requestId = line.split('\t', 2)[1]
    return new Promise((resolve, reject) => {
      const pending = {
        line,
        signal,
        abortListener: null,
        resolve,
        reject,
        timer: null,
        writeTimer: null,
        sent: false,
      }
      pending.abortListener = () => {
        if (pending.sent || worker.pending.get(requestId) !== pending) return
        worker.pending.delete(requestId)
        const queuedAt = worker.queue.indexOf(requestId)
        if (queuedAt >= 0) worker.queue.splice(queuedAt, 1)
        detachAbort(pending)
        pending.reject(workerError(
          'WINDOWS_TREE_KILL_TARGET_EXITED',
          'Windows 进程树清理目标在请求发送前已退出',
        ))
        refreshReference(worker)
      }
      signal?.addEventListener('abort', pending.abortListener, { once: true })
      worker.pending.set(requestId, pending)
      refreshReference(worker)
      worker.queue.push(requestId)
      if (signal?.aborted) pending.abortListener()
      flushQueue(worker)
    })
  }

  const bind = async (rawPid, { identityCutoffMs = null, signal = null, sealedJob = false } = {}) => {
    const pid = Math.floor(Number(rawPid) || 0)
    const cutoffMs = identityCutoffMs == null
      ? await settledIdentityCutoff(signal)
      : Number(identityCutoffMs)
    if (pid <= 0 || !Number.isSafeInteger(cutoffMs) || cutoffMs <= 0) {
      return Promise.reject(workerError(
        'WINDOWS_TREE_KILL_WORKER_IDENTITY_INVALID',
        'Windows 进程树清理请求缺少有效身份',
      ))
    }
    let worker
    try { worker = ensureWorker() } catch (error) { return Promise.reject(error) }
    const requestId = `${worker.generation}:${++nextRequestId}`
    const leaseId = `${worker.generation}:lease:${++nextLeaseId}`
    const operation = sealedJob === true ? 'BIND_SEALED' : 'BIND'
    return enqueue(
      worker,
      `${operation}\t${requestId}\t${leaseId}\t${pid}\t${cutoffMs}`,
      { signal },
    ).then((bound) => (bound ? { generation: worker.generation, leaseId } : null))
  }

  const operateLease = (operation, lease) => {
    const worker = activeWorker
    if (!worker || worker.failed || worker.generation !== lease?.generation) {
      return Promise.resolve(false)
    }
    const requestId = `${worker.generation}:${++nextRequestId}`
    const suffix = operation === 'KILL' ? `\t${INTERNAL_TIMEOUT_MS}` : ''
    return enqueue(worker, `${operation}\t${requestId}\t${lease.leaseId}${suffix}`)
  }

  const kill = (lease) => operateLease('KILL', lease)
  const release = (lease) => operateLease('RELEASE', lease)
  const request = async (pid, options) => {
    const lease = await bind(pid, options)
    return lease ? kill(lease) : false
  }

  const shutdown = () => {
    if (!activeWorker) return
    failWorker(activeWorker, workerError(
      'WINDOWS_TREE_KILL_WORKER_SHUTDOWN',
      'Windows 进程树清理 worker 已关闭',
    ))
  }

  const snapshot = () => ({
    active: Boolean(activeWorker && !activeWorker.failed),
    pid: activeWorker?.child?.pid || null,
    ready: Boolean(activeWorker?.ready && !activeWorker.failed),
    pending: activeWorker?.pending?.size || 0,
    queued: activeWorker?.queue?.length || 0,
    generation: activeWorker?.generation || generation,
    spawnCount,
  })

  return { bind, kill, prewarm, ready, release, request, shutdown, snapshot }
}

let sharedManager = null

function manager() {
  if (!sharedManager) sharedManager = createWindowsTreeKillWorkerManager()
  return sharedManager
}

export function prepareWindowsTreeKillWorker(options) {
  return manager().ready(options)
}

// sealedJob is reserved for an inert trusted gate bound before it can spawn.
export async function bindWindowsProcessTree({ pid, child = null, signal = null, sealedJob = false } = {}) {
  if (child) {
    try {
      if (child.kill(0) !== true) return null
    } catch { return null }
  }
  const identityCutoffMs = await settledIdentityCutoff(signal)
  if (child) {
    try {
      if (child.kill(0) !== true) return null
    } catch { return null }
  }
  return manager().bind(pid, { identityCutoffMs, signal, sealedJob })
}

export async function terminateWindowsProcessTree({
  pid,
  child = null,
  killRootOnFailure = false,
  leasePromise = null,
} = {}) {
  try {
    const lease = await (leasePromise || bindWindowsProcessTree({ pid, child }))
    if (lease && await manager().kill(lease) === true) return true
  } catch { /* cleanup remains unconfirmed */ }
  const targetStillOwned = child?.exitCode == null && child?.signalCode == null
  if (killRootOnFailure && targetStillOwned) {
    try { child?.kill?.('SIGKILL') } catch { /* process may already be gone */ }
  }
  return false
}

export async function releaseWindowsProcessTree(leasePromise) {
  try {
    const lease = await leasePromise
    return lease ? manager().release(lease) : false
  } catch { return false }
}

export const windowsTreeKillTesting = {
  createWindowsTreeKillWorkerManager,
  getSnapshot: () => sharedManager?.snapshot() || {
    active: false,
    pid: null,
    ready: false,
    pending: 0,
    queued: 0,
    generation: 0,
    spawnCount: 0,
  },
  prewarm: () => manager().prewarm(),
  request: (pid, options) => manager().request(pid, options),
  setManager: (nextManager) => {
    sharedManager?.shutdown()
    sharedManager = nextManager || null
  },
  reset: () => {
    sharedManager?.shutdown()
    sharedManager = null
  },
}
