import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { processExecutionNotStartedResult } from './processExecutionFailure.js'
import { terminateProcessTree } from './processTreeTermination.js'
import { sanitizeChildEnv } from './sensitiveEnv.js'
import {
  prepareWindowsProcessExecution,
  WINDOWS_PROCESS_GATE_PATH,
  WINDOWS_PROCESS_GATE_PROTOCOL,
  windowsProcessGateEnv,
} from './windowsProcessGateRuntime.js'
import { windowsTreeKillWorkerScript } from './windowsTreeKillWorkerSource.js'
import {
  bindWindowsProcessTree,
  createWindowsTreeKillWorkerManager,
  releaseWindowsProcessTree,
  terminateWindowsProcessTree,
  windowsTreeKillTesting,
} from './windowsTreeKillRuntime.js'

const GRACE_MS = 2_000
const WINDOWS_TREE_HANDLE_DRAIN_MS = 250

function utf8Tail(value, maxBytes) {
  const source = Buffer.from(String(value || ''), 'utf8')
  if (source.length <= maxBytes) return source.toString('utf8')
  let start = Math.max(0, source.length - Math.max(0, maxBytes))
  while (start < source.length && (source[start] & 0xc0) === 0x80) start += 1
  return source.subarray(start).toString('utf8')
}

export { terminateProcessTree }

export function runProcessWithGroup(options, { spawnProcessFn = spawn } = {}) {
  const startExecution = (startedOptions) => runProcessWithGroupStarted(startedOptions, { spawnProcessFn })
  return process.platform === 'win32'
    ? prepareWindowsProcessExecution(options, startExecution)
    : startExecution(options)
}

function createProcessRuntime(options, spawnProcessFn, resolve) {
  const hasControlPipe = options.controlPipe === true
  const hasStdinInput = typeof options.stdinInput === 'string' || Buffer.isBuffer(options.stdinInput)
  const requestedControlMaxBuffer = Number(options.controlMaxBuffer)
  const controlMaxBuffer = Number.isFinite(requestedControlMaxBuffer)
    ? Math.max(0, Math.floor(requestedControlMaxBuffer))
    : 256 * 1024
  const isWin = process.platform === 'win32'
  const targetEnv = sanitizeChildEnv({}, {
    sourceEnv: options.env || process.env,
    inheritKeys: options.inheritEnvKeys,
  })
  const useWindowsProcessGate = isWin
  const child = spawnProcessFn(
    useWindowsProcessGate ? process.execPath : options.shellPath,
    useWindowsProcessGate ? [WINDOWS_PROCESS_GATE_PATH] : options.shellArgs,
    {
      cwd: useWindowsProcessGate ? path.dirname(process.execPath) : options.cwd,
      env: useWindowsProcessGate ? windowsProcessGateEnv(targetEnv) : targetEnv,
      windowsHide: options.windowsHide,
      windowsVerbatimArguments: useWindowsProcessGate ? false : options.windowsVerbatimArguments,
      detached: !isWin,
      stdio: hasControlPipe
        ? [hasStdinInput ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe', ...(useWindowsProcessGate ? ['ipc'] : [])]
        : [hasStdinInput ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(useWindowsProcessGate ? ['ipc'] : [])],
    },
  )
  return {
    ...options,
    spawnProcessFn,
    resolve,
    hasControlPipe,
    hasStdinInput,
    controlMaxBuffer,
    isWin,
    targetEnv,
    useWindowsProcessGate,
    child,
    state: {
      windowsBindController: isWin ? new AbortController() : null,
      windowsBindError: null,
      stdoutBuf: '', stderrBuf: '', controlChunks: [], controlBufferedBytes: 0,
      controlTotalBytes: 0, controlTruncated: false, controlError: null,
      outputEvents: [], bufferedOutputBytes: 0, totalOutputBytes: 0,
      truncated: false, timedOut: false, aborted: false, killed: false,
      settled: false, finalizing: false, killTimer: null, sigkillTimer: null,
      abortListener: null, windowsTreeKillPromise: null, posixTreeKillPromise: null,
      outputLogStream: null, outputLogOwned: false, outputLogError: null,
      windowsGateStarted: !useWindowsProcessGate,
      windowsStartRequestMayHaveArrived: false,
      processStartFailed: false, processStartError: null,
      processIsolationFailed: false, processIsolationError: null,
      windowsGateReadySettled: !useWindowsProcessGate,
      resolveWindowsGateReady: null,
      windowsGateReadyPromise: null,
      streamsPausedForLog: new Set(),
    },
  }
}

function hasTerminalIntent(runtime) {
  const s = runtime.state
  return s.finalizing || s.timedOut || s.aborted || s.killed || s.settled
}

function settleWindowsGateReady(runtime, ready) {
  const state = runtime.state
  if (state.windowsGateReadySettled) return
  state.windowsGateReadySettled = true
  state.resolveWindowsGateReady?.(ready === true)
}

function stopBuffering(runtime) {
  const { child, controlStream, state } = runtime
  try { child.stdout?.destroy() } catch { /* noop */ }
  try { child.stderr?.destroy() } catch { /* noop */ }
  if (controlStream && !controlStream.readableEnded && !controlStream.destroyed) {
    state.controlTruncated = true
  }
  try { controlStream?.destroy() } catch { /* noop */ }
}

function killProcessTree(runtime, signal, { markKilled = true, stopOutput = true } = {}) {
  const { state, child } = runtime
  if (state.settled || child.pid == null) return
  if (markKilled) state.killed = true
  if (stopOutput) stopBuffering(runtime)
  try {
    if (runtime.isWin) {
      if (!state.windowsTreeKillPromise) {
        if (runtime.useWindowsProcessGate
          && !state.windowsStartRequestMayHaveArrived
          && !state.windowsGateStarted) {
          settleWindowsGateReady(runtime, false)
          state.windowsBindController?.abort()
          void releaseWindowsProcessTree(state.windowsTreeLeasePromise)
          const exited = child.exitCode != null || child.signalCode != null
          try { state.windowsTreeKillPromise = Promise.resolve(exited || child.kill('SIGKILL') === true) }
          catch { state.windowsTreeKillPromise = Promise.resolve(false) }
          return
        }
        state.windowsTreeKillPromise = terminateWindowsProcessTree({
          pid: child.pid,
          child,
          killRootOnFailure: true,
          leasePromise: state.windowsTreeLeasePromise,
        })
      }
    } else if (!state.posixTreeKillPromise) {
      state.posixTreeKillPromise = terminateProcessTree({ pid: child.pid, child })
    }
  } catch { /* process may already have exited */ }
}

function configureWindowsProcessGate(runtime) {
  const { state, child } = runtime
  if (!runtime.useWindowsProcessGate) return
  state.windowsGateReadyPromise = new Promise((resolve) => { state.resolveWindowsGateReady = resolve })
  child.once('error', () => settleWindowsGateReady(runtime, false))
  child.once('exit', () => settleWindowsGateReady(runtime, false))
  state.windowsTreeLeasePromise = state.windowsGateReadyPromise.then((ready) => {
    if (ready !== true) return null
    return bindWindowsProcessTree({
      pid: child.pid,
      child,
      signal: state.windowsBindController.signal,
      sealedJob: true,
    })
  }).catch((error) => {
    if (!hasTerminalIntent(runtime)) state.windowsBindError = error
    return null
  })
  child.on('message', (message) => {
    if (message?.protocol !== WINDOWS_PROCESS_GATE_PROTOCOL) return
    if (message?.operation === 'READY') {
      settleWindowsGateReady(runtime, true)
      return
    }
    if (message?.operation === 'START_FAILED'
      && !state.windowsGateStarted && !hasTerminalIntent(runtime)) {
      state.processStartFailed = true
      state.processStartError = typeof message.error === 'string' && message.error
        ? message.error
        : 'Windows target process failed to start'
      return
    }
    if (message?.operation !== 'STARTED' || state.windowsGateStarted || hasTerminalIntent(runtime)) return
    state.windowsGateStarted = true
    try {
      runtime.onSpawn?.(child, {
        targetPid: Number.isSafeInteger(message.pid) && message.pid > 0 ? message.pid : null,
        supervisor: 'windows-process-gate',
      })
    } catch { /* observer must not affect execution */ }
    if (hasTerminalIntent(runtime)) return
    if (runtime.hasStdinInput) child.stdin?.end(runtime.stdinInput)
  })
  void Promise.all([state.windowsTreeLeasePromise, state.windowsGateReadyPromise])
    .then(([lease, ready]) => {
      if (hasTerminalIntent(runtime)) return
      if (!lease || ready !== true) {
        state.processIsolationFailed = true
        state.processIsolationError = state.windowsBindError
          ? (state.windowsBindError?.message || String(state.windowsBindError))
          : 'Windows process isolation could not be established before execution'
        if (state.windowsBindError) state.stderrBuf += state.windowsBindError?.message || String(state.windowsBindError)
        killProcessTree(runtime, 'SIGKILL', { markKilled: false })
        return
      }
      if (hasTerminalIntent(runtime)) return
      try {
        state.windowsStartRequestMayHaveArrived = true
        child.send({
          protocol: WINDOWS_PROCESS_GATE_PROTOCOL,
          operation: 'START',
          shellPath: runtime.shellPath,
          shellArgs: runtime.shellArgs,
          cwd: runtime.cwd,
          env: runtime.targetEnv,
          hasStdinInput: runtime.hasStdinInput,
          hasControlPipe: runtime.hasControlPipe,
          windowsHide: runtime.windowsHide,
          windowsVerbatimArguments: runtime.windowsVerbatimArguments,
        }, (error) => {
          if (!error || hasTerminalIntent(runtime)) return
          state.processIsolationFailed = true
          state.processIsolationError = error?.message || String(error)
          state.stderrBuf += error?.message || String(error)
          killProcessTree(runtime, 'SIGKILL', { markKilled: false })
        })
      } catch (error) {
        if (hasTerminalIntent(runtime)) return
        state.processIsolationFailed = true
        state.processIsolationError = error?.message || String(error)
        state.stderrBuf += error?.message || String(error)
        killProcessTree(runtime, 'SIGKILL', { markKilled: false })
      }
    })
}

function configureOutputLog(runtime) {
  if (runtime.overflowMode !== 'tail' || !runtime.fullOutputPath) return
  const { state } = runtime
  try {
    fs.mkdirSync(path.dirname(runtime.fullOutputPath), { recursive: true })
    state.outputLogStream = fs.createWriteStream(runtime.fullOutputPath, { flags: 'wx' })
    state.outputLogStream.once('open', () => { state.outputLogOwned = true })
    state.outputLogStream.on('drain', () => {
      for (const stream of state.streamsPausedForLog) stream.resume?.()
      state.streamsPausedForLog.clear()
    })
    state.outputLogStream.on('error', (error) => {
      state.outputLogError = error
      for (const stream of state.streamsPausedForLog) stream.resume?.()
      state.streamsPausedForLog.clear()
    })
  } catch (error) { state.outputLogError = error }
}

function collectControlOutput(runtime) {
  const { state, controlStream } = runtime
  if (runtime.hasControlPipe && !controlStream) state.controlError = 'control pipe fd3 is unavailable'
  controlStream?.on('error', (error) => {
    if (!state.controlError) state.controlError = error?.message || String(error)
  })
  controlStream?.on('data', (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    state.controlTotalBytes += bytes.length
    const remaining = runtime.controlMaxBuffer - state.controlBufferedBytes
    if (remaining <= 0) {
      if (bytes.length > 0) state.controlTruncated = true
      return
    }
    const kept = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes
    if (kept.length > 0) {
      state.controlChunks.push(Buffer.from(kept))
      state.controlBufferedBytes += kept.length
    }
    if (kept.length < bytes.length) state.controlTruncated = true
  })
}

function trimTailBuffer(runtime) {
  const { state } = runtime
  while (state.bufferedOutputBytes > runtime.maxBuffer && state.outputEvents.length > 0) {
    state.truncated = true
    const first = state.outputEvents[0]
    const overflow = state.bufferedOutputBytes - runtime.maxBuffer
    if (first.bytes <= overflow) {
      state.outputEvents.shift()
      state.bufferedOutputBytes -= first.bytes
      continue
    }
    const kept = utf8Tail(first.text, first.bytes - overflow)
    const keptBytes = Buffer.byteLength(kept, 'utf8')
    state.bufferedOutputBytes -= first.bytes - keptBytes
    first.text = kept
    first.bytes = keptBytes
  }
}

function collectProcessOutput(runtime, stream, which) {
  const { state } = runtime
  stream?.setEncoding('utf8')
  stream?.on('error', () => {})
  stream?.on('data', (chunk) => {
    const text = String(chunk)
    const bytes = Buffer.byteLength(text, 'utf8')
    state.totalOutputBytes += bytes
    try { runtime.onOutput?.({ stream: which === 'out' ? 'stdout' : 'stderr', chunk: text }) }
    catch { /* best-effort */ }
    if (state.outputLogStream && !state.outputLogStream.destroyed) {
      try {
        if (!state.outputLogStream.write(text)) {
          stream.pause?.()
          state.streamsPausedForLog.add(stream)
        }
      } catch (error) {
        state.outputLogError = error
        stream.resume?.()
        state.streamsPausedForLog.delete(stream)
      }
    }
    if (runtime.overflowMode === 'tail') {
      state.outputEvents.push({ which, text, bytes })
      state.bufferedOutputBytes += bytes
      trimTailBuffer(runtime)
      return
    }
    if (state.truncated) return
    const remaining = runtime.maxBuffer - state.stdoutBuf.length - state.stderrBuf.length
    if (remaining <= 0) {
      state.truncated = true
      stopBuffering(runtime)
      killProcessTree(runtime, 'SIGTERM')
      return
    }
    const slice = text.length > remaining ? text.slice(0, remaining) : text
    if (which === 'out') state.stdoutBuf += slice
    else state.stderrBuf += slice
    if (text.length > remaining) {
      state.truncated = true
      stopBuffering(runtime)
      killProcessTree(runtime, 'SIGTERM')
    }
  })
}

async function closeOutputLog(runtime) {
  const stream = runtime.state.outputLogStream
  if (!stream || stream.destroyed) return
  await new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    stream.once('finish', finish)
    stream.once('close', finish)
    stream.once('error', finish)
    stream.end()
  })
}

async function finalizeProcess(runtime, code, exitSignal) {
  const { state } = runtime
  if (state.settled || state.finalizing) return
  state.finalizing = true
  if (state.killTimer) clearTimeout(state.killTimer)
  if (state.sigkillTimer) clearTimeout(state.sigkillTimer)
  if (state.abortListener) runtime.signal?.removeEventListener('abort', state.abortListener)
  let processTreeCleanupFailed = false
  if (runtime.isWin && state.windowsTreeKillPromise) {
    processTreeCleanupFailed = !(await state.windowsTreeKillPromise)
    if (state.processIsolationFailed
      && !state.windowsStartRequestMayHaveArrived
      && !state.windowsGateStarted) processTreeCleanupFailed = false
    if (state.timedOut || state.aborted || state.killed) {
      await new Promise((resolve) => setTimeout(resolve, WINDOWS_TREE_HANDLE_DRAIN_MS))
    }
  } else if (runtime.isWin && state.windowsTreeLeasePromise) {
    await releaseWindowsProcessTree(state.windowsTreeLeasePromise)
  } else if (state.posixTreeKillPromise) {
    processTreeCleanupFailed = !(await state.posixTreeKillPromise)
  }
  await closeOutputLog(runtime)
  if (runtime.overflowMode === 'tail') {
    state.stdoutBuf = state.outputEvents.filter((entry) => entry.which === 'out')
      .map((entry) => entry.text).join('')
    state.stderrBuf = state.outputEvents.filter((entry) => entry.which === 'err')
      .map((entry) => entry.text).join('')
  }
  let persistedFullOutputPath = null
  if (runtime.overflowMode === 'tail' && state.truncated && runtime.fullOutputPath
    && state.outputLogOwned && !state.outputLogError) {
    persistedFullOutputPath = runtime.fullOutputPath
  } else if (runtime.overflowMode === 'tail' && runtime.fullOutputPath && state.outputLogOwned) {
    try { await fs.promises.rm(runtime.fullOutputPath, { force: true }) } catch { /* cleanup */ }
  }
  if (runtime.useWindowsProcessGate && !state.windowsGateStarted
    && !state.processIsolationFailed && !state.aborted && !state.timedOut) {
    state.processStartFailed = true
    if (!state.processStartError) {
      state.processStartError = state.stderrBuf.trim() || 'Windows target process failed to start'
    }
  }
  state.settled = true
  runtime.resolve({
    stdout: state.stdoutBuf,
    stderr: state.stderrBuf,
    code: state.processStartFailed || state.processIsolationFailed
      ? null
      : typeof code === 'number' ? code : null,
    signal: exitSignal || null,
    timedOut: state.timedOut,
    killed: state.killed,
    processStartFailed: state.processStartFailed,
    processStartError: state.processStartError,
    processIsolationFailed: state.processIsolationFailed,
    processIsolationError: state.processIsolationError,
    processTreeCleanupFailed,
    truncated: state.truncated,
    aborted: state.aborted,
    totalOutputBytes: state.totalOutputBytes,
    ...(runtime.hasControlPipe ? {
      control: Buffer.concat(state.controlChunks, state.controlBufferedBytes),
      controlError: state.controlError,
      controlTruncated: state.controlTruncated,
      controlTotalBytes: state.controlTotalBytes,
    } : {}),
    ...(persistedFullOutputPath ? { fullOutputPath: persistedFullOutputPath } : {}),
    ...(state.outputLogError
      ? { outputLogError: state.outputLogError?.message || String(state.outputLogError) }
      : {}),
  })
}

function attachProcessLifecycle(runtime) {
  const { state, child } = runtime
  child.stdin?.on('error', () => {})
  child.once('spawn', () => {
    if (runtime.useWindowsProcessGate) return
    try { runtime.onSpawn?.(child) } catch { /* observer must not affect execution */ }
    if (runtime.hasStdinInput) child.stdin?.end(runtime.stdinInput)
  })
  collectControlOutput(runtime)
  collectProcessOutput(runtime, child.stdout, 'out')
  collectProcessOutput(runtime, child.stderr, 'err')
  const scheduleForceKill = () => {
    if (state.sigkillTimer) clearTimeout(state.sigkillTimer)
    state.sigkillTimer = setTimeout(() => killProcessTree(runtime, 'SIGKILL'), GRACE_MS)
  }
  if (runtime.signal) {
    state.abortListener = () => {
      if (hasTerminalIntent(runtime)) return
      state.aborted = true
      killProcessTree(runtime, 'SIGTERM')
      scheduleForceKill()
    }
    runtime.signal.addEventListener('abort', state.abortListener, { once: true })
    if (runtime.signal.aborted) state.abortListener()
  }
  state.killTimer = setTimeout(() => {
    if (hasTerminalIntent(runtime)) return
    state.timedOut = true
    killProcessTree(runtime, 'SIGTERM')
    scheduleForceKill()
  }, runtime.timeout)
  child.on('error', (error) => {
    if (runtime.useWindowsProcessGate && hasTerminalIntent(runtime)) {
      state.windowsBindController?.abort()
      void finalizeProcess(runtime, null, null)
      return
    }
    const message = error?.message || String(error)
    state.stderrBuf += message
    if (runtime.useWindowsProcessGate) {
      settleWindowsGateReady(runtime, false)
      state.processIsolationFailed = true
      state.processIsolationError = message
    } else {
      state.processStartFailed = true
      state.processStartError = message
    }
    state.windowsBindController?.abort()
    void finalizeProcess(runtime, null, null)
  })
  child.on('exit', () => {
    if (runtime.isWin && (runtime.cleanupWindowsTreeOnExit || state.windowsTreeLeasePromise)) {
      killProcessTree(runtime, 'SIGTERM', { markKilled: false, stopOutput: false })
    }
    state.windowsBindController?.abort()
  })
  child.on('close', (code, signal) => {
    state.resolveWindowsGateReady?.(false)
    void finalizeProcess(runtime, code, signal)
  })
}

function runProcessWithGroupStarted({
  shellPath,
  shellArgs,
  cwd,
  env,
  inheritEnvKeys = [],
  timeout = 60_000,
  maxBuffer = 1 * 1024 * 1024,
  windowsHide = true,
  windowsVerbatimArguments = false,
  signal = null,
  overflowMode = 'kill',
  fullOutputPath = null,
  onOutput = null,
  stdinInput = null,
  onSpawn = null,
  cleanupWindowsTreeOnExit = false,
  controlPipe = false,
  controlMaxBuffer = 256 * 1024,
}, { spawnProcessFn = spawn } = {}) {
  if (signal?.aborted) {
    return Promise.resolve(processExecutionNotStartedResult({
      controlPipe: controlPipe === true,
      aborted: true,
    }))
  }
  return new Promise((resolve) => {
    const runtime = createProcessRuntime({
      shellPath, shellArgs, cwd, env, inheritEnvKeys, timeout, maxBuffer,
      windowsHide, windowsVerbatimArguments, signal, overflowMode,
      fullOutputPath, onOutput, stdinInput, onSpawn, cleanupWindowsTreeOnExit,
      controlPipe, controlMaxBuffer,
    }, spawnProcessFn, resolve)
    runtime.controlStream = runtime.hasControlPipe ? runtime.child.stdio?.[3] : null
    configureWindowsProcessGate(runtime)
    configureOutputLog(runtime)
    attachProcessLifecycle(runtime)
  })
}

export const _testing = {
  createWindowsTreeKillWorkerManager,
  windowsTreeKillWorkerScript,
  getWindowsTreeKillWorkerSnapshot: windowsTreeKillTesting.getSnapshot,
  resetWindowsTreeKillWorker: windowsTreeKillTesting.reset,
  prewarmWindowsTreeKillWorker: windowsTreeKillTesting.prewarm,
  requestWindowsTreeKill: windowsTreeKillTesting.request,
  setWindowsTreeKillWorkerManager: windowsTreeKillTesting.setManager,
}
