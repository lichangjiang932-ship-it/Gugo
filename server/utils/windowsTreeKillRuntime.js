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

function refreshWorkerReference(worker) {
  if (!worker) return
  setReferenced(worker.child, !worker.failed && (worker.pending.size > 0 || worker.readyWaiters.size > 0))
}

function failWorker(runtime, worker, error, { terminate = true } = {}) {
  if (!worker || worker.failed) return
  worker.failed = true
  if (worker.startupTimer) clearTimeout(worker.startupTimer)
  worker.startupTimer = null
  if (runtime.state.activeWorker === worker) runtime.state.activeWorker = null
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
  refreshWorkerReference(worker)
  if (terminate) {
    try { worker.child.stdin?.destroy() } catch { /* already closed */ }
    try { worker.child.kill('SIGKILL') } catch { /* already exited */ }
  }
}

function flushWorkerQueue(runtime, worker) {
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
          failWorker(runtime, worker, workerError(
            'WINDOWS_TREE_KILL_WORKER_WRITE_FAILED',
            `Windows 进程树清理 worker 写入失败：${error?.message || String(error)}`,
          ))
          return
        }
        if (worker.pending.get(requestId) !== pending || worker.failed) return
        pending.timer = setTimeout(() => {
          failWorker(runtime, worker, workerError(
            'WINDOWS_TREE_KILL_WORKER_REQUEST_TIMEOUT',
            'Windows 进程树清理 worker 请求超时',
          ))
        }, runtime.requestTimeoutMs)
        pending.timer.unref?.()
      })
      pending.writeTimer = setTimeout(() => {
        failWorker(runtime, worker, workerError(
          'WINDOWS_TREE_KILL_WORKER_WRITE_TIMEOUT',
          'Windows 进程树清理 worker 写入超时',
        ))
      }, runtime.requestTimeoutMs)
      pending.writeTimer.unref?.()
    } catch (error) {
      failWorker(runtime, worker, workerError(
        'WINDOWS_TREE_KILL_WORKER_WRITE_FAILED',
        `Windows 进程树清理 worker 写入失败：${error?.message || String(error)}`,
      ))
      return
    }
  }
}

function acceptWorkerLine(runtime, worker, rawLine) {
  const line = String(rawLine || '').replace(/^\uFEFF/u, '').replace(/\r$/u, '')
  if (!line) return
  if (!worker.ready) {
    if (line !== 'READY\t2') {
      failWorker(runtime, worker, workerError(
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
    refreshWorkerReference(worker)
    flushWorkerQueue(runtime, worker)
    return
  }
  const fields = line.split('\t')
  if (fields.length !== 2 || (fields[1] !== '0' && fields[1] !== '1')) {
    failWorker(runtime, worker, workerError(
      'WINDOWS_TREE_KILL_WORKER_PROTOCOL_ERROR',
      'Windows 进程树清理 worker 返回了无效响应',
    ))
    return
  }
  const pending = worker.pending.get(fields[0])
  if (!pending) {
    failWorker(runtime, worker, workerError(
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
  refreshWorkerReference(worker)
}

function attachWorkerProtocol(runtime, worker) {
  const { child } = worker
  child.stdout?.setEncoding?.('utf8')
  child.stdout?.on('data', (chunk) => {
    if (worker.failed) return
    worker.stdoutBuffer += String(chunk || '')
    while (true) {
      const newlineAt = worker.stdoutBuffer.indexOf('\n')
      if (newlineAt < 0) break
      const next = worker.stdoutBuffer.slice(0, newlineAt)
      worker.stdoutBuffer = worker.stdoutBuffer.slice(newlineAt + 1)
      acceptWorkerLine(runtime, worker, next)
      if (worker.failed) return
    }
  })
  child.stdin?.on('error', (error) => failWorker(runtime, worker, workerError(
    'WINDOWS_TREE_KILL_WORKER_PIPE_FAILED',
    `Windows 进程树清理 worker 输入管道失败：${error?.message || String(error)}`,
  )))
  child.stdout?.on('error', (error) => failWorker(runtime, worker, workerError(
    'WINDOWS_TREE_KILL_WORKER_PIPE_FAILED',
    `Windows 进程树清理 worker 输出管道失败：${error?.message || String(error)}`,
  )))
  child.once('error', (error) => failWorker(runtime, worker, workerError(
    'WINDOWS_TREE_KILL_WORKER_CRASHED',
    `Windows 进程树清理 worker 异常：${error?.message || String(error)}`,
  ), { terminate: false }))
  child.once('close', (code, signal) => failWorker(runtime, worker, workerError(
    'WINDOWS_TREE_KILL_WORKER_CRASHED',
    `Windows 进程树清理 worker 已退出${typeof code === 'number' ? ` (code=${code})` : ''}${signal ? ` (${signal})` : ''}`,
  ), { terminate: false }))
}

function spawnWorker(runtime) {
  let child
  try {
    child = runtime.spawnProcess(runtime.workerPath, runtime.workerArgs, {
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
    generation: ++runtime.state.generation,
    ready: false,
    failed: false,
    stdoutBuffer: '',
    pending: new Map(),
    queue: [],
    readyWaiters: new Set(),
    startupTimer: null,
  }
  runtime.state.activeWorker = worker
  runtime.state.spawnCount += 1
  refreshWorkerReference(worker)
  attachWorkerProtocol(runtime, worker)
  if (!child.stdin || !child.stdout) {
    queueMicrotask(() => failWorker(runtime, worker, workerError(
      'WINDOWS_TREE_KILL_WORKER_PIPE_FAILED',
      'Windows 进程树清理 worker 缺少协议管道',
    )))
    return worker
  }
  worker.startupTimer = setTimeout(() => failWorker(runtime, worker, workerError(
    'WINDOWS_TREE_KILL_WORKER_START_TIMEOUT',
    'Windows 进程树清理 worker 启动超时',
  )), runtime.startupTimeoutMs)
  worker.startupTimer.unref?.()
  if (runtime.workerPayload) {
    try {
      child.stdin.write(`${runtime.workerPayload}\n`, (error) => {
        if (!error || worker.failed) return
        failWorker(runtime, worker, workerError(
          'WINDOWS_TREE_KILL_WORKER_BOOTSTRAP_FAILED',
          `Windows 进程树清理 worker 源码传输失败：${error?.message || String(error)}`,
        ))
      })
    } catch (error) {
      failWorker(runtime, worker, workerError(
        'WINDOWS_TREE_KILL_WORKER_BOOTSTRAP_FAILED',
        `Windows 进程树清理 worker 源码传输失败：${error?.message || String(error)}`,
      ))
    }
  }
  return worker
}

function ensureWorker(runtime) {
  const worker = runtime.state.activeWorker
  return worker && !worker.failed ? worker : spawnWorker(runtime)
}

function waitForWorkerReady(runtime, { signal = null, timeoutMs = null } = {}) {
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
  try { worker = ensureWorker(runtime) } catch (error) { return Promise.reject(error) }
  if (worker.ready) return Promise.resolve(true)
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, abortListener: null, timer: null }
    const rejectWaiter = (error) => {
      if (!worker.readyWaiters.delete(waiter)) return
      detachReadyWaiter(waiter)
      reject(error)
      refreshWorkerReference(worker)
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
    refreshWorkerReference(worker)
    if (signal?.aborted) waiter.abortListener()
  })
}

function enqueueWorkerRequest(runtime, worker, line, { signal = null } = {}) {
  if (signal?.aborted) {
    return Promise.reject(workerError(
      'WINDOWS_TREE_KILL_TARGET_EXITED',
      'Windows 进程树清理目标已退出',
    ))
  }
  const requestId = line.split('\t', 2)[1]
  return new Promise((resolve, reject) => {
    const pending = {
      line, signal, abortListener: null, resolve, reject,
      timer: null, writeTimer: null, sent: false,
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
      refreshWorkerReference(worker)
    }
    signal?.addEventListener('abort', pending.abortListener, { once: true })
    worker.pending.set(requestId, pending)
    refreshWorkerReference(worker)
    worker.queue.push(requestId)
    if (signal?.aborted) pending.abortListener()
    flushWorkerQueue(runtime, worker)
  })
}

async function bindWorkerLease(runtime, rawPid, {
  identityCutoffMs = null,
  signal = null,
  sealedJob = false,
} = {}) {
  const pid = Math.floor(Number(rawPid) || 0)
  const cutoffMs = identityCutoffMs == null
    ? await settledIdentityCutoff(signal)
    : Number(identityCutoffMs)
  if (pid <= 0 || !Number.isSafeInteger(cutoffMs) || cutoffMs <= 0) {
    throw workerError(
      'WINDOWS_TREE_KILL_WORKER_IDENTITY_INVALID',
      'Windows 进程树清理请求缺少有效身份',
    )
  }
  const worker = ensureWorker(runtime)
  const requestId = `${worker.generation}:${++runtime.state.nextRequestId}`
  const leaseId = `${worker.generation}:lease:${++runtime.state.nextLeaseId}`
  const operation = sealedJob === true ? 'BIND_SEALED' : 'BIND'
  const bound = await enqueueWorkerRequest(
    runtime,
    worker,
    `${operation}\t${requestId}\t${leaseId}\t${pid}\t${cutoffMs}`,
    { signal },
  )
  return bound ? { generation: worker.generation, leaseId } : null
}

function operateWorkerLease(runtime, operation, lease) {
  const worker = runtime.state.activeWorker
  if (!worker || worker.failed || worker.generation !== lease?.generation) {
    return Promise.resolve(false)
  }
  const requestId = `${worker.generation}:${++runtime.state.nextRequestId}`
  const suffix = operation === 'KILL' ? `\t${INTERNAL_TIMEOUT_MS}` : ''
  return enqueueWorkerRequest(runtime, worker, `${operation}\t${requestId}\t${lease.leaseId}${suffix}`)
}

export function createWindowsTreeKillWorkerManager({
  spawnProcess = spawn,
  workerPath = windowsPowerShellPath(),
  workerArgs = windowsTreeKillWorkerArgs(),
  workerPayload = windowsTreeKillWorkerPayload(),
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const runtime = {
    spawnProcess, workerPath, workerArgs, workerPayload, startupTimeoutMs, requestTimeoutMs,
    state: { activeWorker: null, generation: 0, nextRequestId: 0, nextLeaseId: 0, spawnCount: 0 },
  }
  return {
    bind: (pid, options) => bindWorkerLease(runtime, pid, options),
    kill: (lease) => operateWorkerLease(runtime, 'KILL', lease),
    prewarm() {
      try { ensureWorker(runtime); return true } catch { return false }
    },
    ready: (options) => waitForWorkerReady(runtime, options),
    release: (lease) => operateWorkerLease(runtime, 'RELEASE', lease),
    async request(pid, options) {
      const lease = await bindWorkerLease(runtime, pid, options)
      return lease ? operateWorkerLease(runtime, 'KILL', lease) : false
    },
    shutdown() {
      if (!runtime.state.activeWorker) return
      failWorker(runtime, runtime.state.activeWorker, workerError(
        'WINDOWS_TREE_KILL_WORKER_SHUTDOWN',
        'Windows 进程树清理 worker 已关闭',
      ))
    },
    snapshot() {
      const worker = runtime.state.activeWorker
      return {
        active: Boolean(worker && !worker.failed),
        pid: worker?.child?.pid || null,
        ready: Boolean(worker?.ready && !worker.failed),
        pending: worker?.pending?.size || 0,
        queued: worker?.queue?.length || 0,
        generation: worker?.generation || runtime.state.generation,
        spawnCount: runtime.state.spawnCount,
      }
    },
  }
}

let sharedManager = null

function manager() {
  if (!sharedManager) sharedManager = createWindowsTreeKillWorkerManager()
  return sharedManager
}

export function prepareWindowsTreeKillWorker(options) {
  return manager().ready(options)
}

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
