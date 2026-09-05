import { spawn } from 'node:child_process'

import { terminateProcessTree } from '../utils/processGroup.js'
import {
  CODEX_APP_SERVER_REASON,
  DEFAULT_EXIT_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SIGNATURE_TIMEOUT_MS,
  DEFAULT_TERMINATE_TIMEOUT_MS,
  DEFAULT_VERSION_TIMEOUT_MS,
  MAX_HANDSHAKE_TIMEOUT_MS,
  codexEnvValue,
  createCodexRuntimeError,
  fallbackCodexReasonForStage,
  knownCodexReason,
  normalizeCodexStageTimeout,
  publicCodexAppServerSnapshot,
} from './codexAppServerContracts.js'
import {
  discoverCodexExecutableStage,
  readCodexVersionStage,
  spawnCodexRuntimeStage,
  verifyCodexExecutableStage,
} from './codexAppServerStartStages.js'
import {
  createCodexCliExecutableSnapshotAsync,
  isNativeCodexExecutablePath,
  readCodexCliVersion,
  resolveCodexCliExecutableAsync,
  verifyCodexCliAuthenticode,
} from './codexCliExecutableRuntime.js'
import {
  codexAppServerChildEnvironment,
  createProcessObserver,
  joinCodexStartAttempt,
  performModelListRequest,
  performInitializeHandshake,
  waitForCodexOperation,
} from './codexAppServerProcess.js'
import {
  assertCodexStartActive,
  cleanupCodexExecutableSnapshot,
  runBoundedCodexStartStage,
} from './codexAppServerStartStage.js'
import { disposeCodexAppServerRuntime } from './codexAppServerShutdown.js'

export { CODEX_APP_SERVER_REASON }
export {
  createCodexCliExecutableSnapshot,
  createCodexCliExecutableSnapshotAsync,
  parseCodexCliVersion,
  readCodexCliVersion,
  resolveCodexCliExecutable,
  resolveCodexCliExecutableAsync,
  resolveWindowsPowerShellExecutable,
  resolveWindowsPowerShellExecutableAsync,
  verifyCodexCliAuthenticode,
} from './codexCliExecutableRuntime.js'

let currentSnapshot = publicCodexAppServerSnapshot()
let currentRuntime = null
let activeStart = null
let closePromise = null

function publish(snapshot) {
  currentSnapshot = publicCodexAppServerSnapshot(snapshot)
  return currentSnapshot
}

function configuredByOptions({ explicitPath, env, platform }) {
  return Boolean(
    String(explicitPath || '').trim()
    || codexEnvValue(env, 'GUGO_CODEX_CLI_PATH', platform).trim()
    || codexEnvValue(env, 'CODEX_CLI_PATH', platform).trim(),
  )
}

function runtimeStatus(runtime, overrides = {}) {
  return {
    enabled: true,
    configured: runtime.configured,
    discovered: true,
    signatureValid: true,
    version: runtime.version,
    ready: runtime.ready && !runtime.observer.fatalReason && !runtime.observer.exited,
    ...overrides,
  }
}

async function handleRuntimeFatal(runtime, reason) {
  runtime.ready = false
  if (currentRuntime === runtime) {
    publish(runtimeStatus(runtime, {
      ready: false,
      failureStage: 'runtime',
      reasonCode: knownCodexReason(reason, CODEX_APP_SERVER_REASON.PROCESS_EXITED),
    }))
  }
  const stopped = await disposeCodexAppServerRuntime(runtime, { terminate: runtime.terminate })
  if (stopped) {
    if (currentRuntime === runtime) currentRuntime = null
    return
  }
  if (currentRuntime === runtime) {
    publish(runtimeStatus(runtime, {
      ready: false,
      failureStage: 'shutdown',
      reasonCode: CODEX_APP_SERVER_REASON.TERMINATION_FAILED,
    }))
  }
}

function beginRuntimeFatalHandling(runtime, reason) {
  if (runtime.phase !== 'ready' || runtime.fatalHandling) return
  const runtimeReason = reason === CODEX_APP_SERVER_REASON.SPAWN_FAILED
    ? CODEX_APP_SERVER_REASON.PROCESS_EXITED
    : reason
  const handling = handleRuntimeFatal(runtime, runtimeReason)
  runtime.fatalHandling = handling
  handling.then(() => {}, () => {
    if (currentRuntime === runtime) {
      publish(runtimeStatus(runtime, {
        ready: false,
        failureStage: 'shutdown',
        reasonCode: CODEX_APP_SERVER_REASON.TERMINATION_FAILED,
      }))
    }
  })
}

async function settleCodexStartFailure({
  error,
  stage,
  state,
  runtime,
  attempt,
  terminate,
  exitTimeoutMs,
}) {
  const reason = knownCodexReason(error?.code, fallbackCodexReasonForStage(stage))
  const failureStage = reason === CODEX_APP_SERVER_REASON.SPAWN_FAILED ? 'spawn' : stage
  let stopped = true
  if (runtime) {
    stopped = await disposeCodexAppServerRuntime(runtime, { terminate, exitTimeoutMs })
    if (stopped) attempt.runtime = null
    else currentRuntime = runtime
  }
  if (!stopped) {
    return publish({
      ...state,
      ready: false,
      failureStage: 'shutdown',
      reasonCode: CODEX_APP_SERVER_REASON.TERMINATION_FAILED,
    })
  }
  if (attempt.stopRequested) {
    return publish({
      ...state,
      ready: false,
      failureStage: null,
      reasonCode: CODEX_APP_SERVER_REASON.STOPPED,
    })
  }
  return publish({ ...state, ready: false, failureStage, reasonCode: reason })
}

async function runStartAttempt(attempt, {
  cwd, env, explicitPath, platform, resolveExecutable, snapshotExecutable,
  verifySignature, readVersion, spawnImpl, terminate, handshakeTimeoutMs,
  signatureTimeoutMs, versionTimeoutMs, exitTimeoutMs,
}) {
  const signal = attempt.controller.signal
  const state = {
    enabled: true,
    configured: configuredByOptions({ explicitPath, env, platform }),
    discovered: false,
    signatureValid: false,
    version: null,
    ready: false,
  }
  let stage = 'discovery'
  let runtime = null
  let executableSnapshot = null
  try {
    assertCodexStartActive(signal)
    const resolved = await discoverCodexExecutableStage({
      signal,
      explicitPath,
      env,
      platform,
      timeoutMs: signatureTimeoutMs,
      resolveExecutable,
      runStage: runBoundedCodexStartStage,
      notFoundReason: CODEX_APP_SERVER_REASON.CLI_NOT_FOUND,
    })
    assertCodexStartActive(signal)
    state.configured = resolved?.configured === true || state.configured
    if (!resolved?.found || !resolved.path) {
      return publish({
        ...state,
        failureStage: 'discovery',
        reasonCode: knownCodexReason(
          resolved?.reasonCode,
          CODEX_APP_SERVER_REASON.CLI_NOT_FOUND,
        ),
      })
    }
    state.discovered = true

    stage = 'signature'
    const verified = await verifyCodexExecutableStage({
      resolvedPath: resolved.path,
      signal,
      env,
      platform,
      timeoutMs: signatureTimeoutMs,
      exitTimeoutMs,
      snapshotExecutable,
      verifySignature,
      runStage: runBoundedCodexStartStage,
      assertActive: assertCodexStartActive,
      cleanupSnapshot: cleanupCodexExecutableSnapshot,
      isNativePath: isNativeCodexExecutablePath,
      createRuntimeError: createCodexRuntimeError,
      invalidSignatureReason: CODEX_APP_SERVER_REASON.CLI_SIGNATURE_INVALID,
    })
    executableSnapshot = verified.snapshot
    const trustedExecutable = executableSnapshot.path
    const { signatureValid } = verified
    if (signatureValid !== true) {
      return publish({
        ...state,
        failureStage: 'signature',
        reasonCode: CODEX_APP_SERVER_REASON.CLI_SIGNATURE_INVALID,
      })
    }
    state.signatureValid = true

    stage = 'version'
    const version = await readCodexVersionStage({
      executablePath: trustedExecutable,
      signal,
      env,
      platform,
      timeoutMs: versionTimeoutMs,
      readVersion,
      runStage: runBoundedCodexStartStage,
      assertActive: assertCodexStartActive,
      invalidVersionReason: CODEX_APP_SERVER_REASON.CLI_VERSION_INVALID,
    })
    if (typeof version !== 'string' || !/^[0-9][0-9A-Za-z.+-]{0,63}$/u.test(version)) {
      return publish({
        ...state,
        failureStage: 'version',
        reasonCode: CODEX_APP_SERVER_REASON.CLI_VERSION_INVALID,
      })
    }
    state.version = version

    stage = 'spawn'
    runtime = await spawnCodexRuntimeStage({
      executablePath: trustedExecutable,
      executableSnapshot,
      configured: state.configured,
      version,
      cwd,
      env,
      platform,
      spawnImpl,
      terminate,
      childEnvironment: codexAppServerChildEnvironment,
      createObserver: createProcessObserver,
      onFatal: beginRuntimeFatalHandling,
      onSpawned: (value) => {
        runtime = value
        executableSnapshot = null
        attempt.runtime = value
        stage = 'handshake'
      },
      performHandshake: performInitializeHandshake,
      handshakeTimeoutMs,
      signal,
      assertActive: assertCodexStartActive,
      createRuntimeError: createCodexRuntimeError,
      spawnFailedReason: CODEX_APP_SERVER_REASON.SPAWN_FAILED,
      processExitedReason: CODEX_APP_SERVER_REASON.PROCESS_EXITED,
    })

    runtime.ready = true
    runtime.phase = 'ready'
    currentRuntime = runtime
    attempt.runtime = null
    return publish({
      ...state,
      ready: true,
      failureStage: null,
      reasonCode: CODEX_APP_SERVER_REASON.READY,
    })
  } catch (error) {
    return settleCodexStartFailure({
      error,
      stage,
      state,
      runtime,
      attempt,
      terminate,
      exitTimeoutMs,
    })
  } finally {
    await cleanupCodexExecutableSnapshot(executableSnapshot, exitTimeoutMs)
  }
}

export function getCodexAppServerStatus() {
  return currentSnapshot
}

export function isCodexAppServerModelCatalogAvailable() {
  return currentSnapshot.enabled === true
    && currentSnapshot.ready === true
    && currentRuntime?.ready === true
    && currentRuntime?.phase === 'ready'
    && currentRuntime?.observer?.fatalReason == null
    && currentRuntime?.observer?.exited !== true
}

function boundedString(value, maximum) {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

function publicCodexModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = boundedString(value.id, 256).trim()
  const model = boundedString(value.model, 256).trim()
  if (!id || !model) return null
  const reasoningEfforts = (Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts
    : [])
    .map((entry) => boundedString(entry?.reasoningEffort, 32).trim())
    .filter((entry) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(entry))
    .slice(0, 8)
  const inputModalities = (Array.isArray(value.inputModalities) ? value.inputModalities : [])
    .map((entry) => boundedString(entry, 16).trim())
    .filter((entry) => entry === 'text' || entry === 'image')
    .slice(0, 2)
  return {
    id,
    model,
    displayName: boundedString(value.displayName, 256),
    description: boundedString(value.description, 2_000),
    hidden: value.hidden === true,
    reasoningEfforts,
    inputModalities,
    supportsPersonality: value.supportsPersonality === true,
    isDefault: value.isDefault === true,
  }
}

export async function listCodexAppServerModels({
  cursor = null,
  limit = 20,
  includeHidden = false,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  signal = null,
} = {}) {
  if (!isCodexAppServerModelCatalogAvailable()) {
    throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.NOT_STARTED)
  }
  const normalizedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20
  const normalizedCursor = typeof cursor === 'string' && cursor.length <= 2_048 ? cursor : null
  const result = await performModelListRequest(currentRuntime, {
    cursor: normalizedCursor,
    limit: normalizedLimit,
    includeHidden: includeHidden === true,
    timeoutMs,
    signal,
  })
  if (!Array.isArray(result.data)) {
    throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
  }
  const visibleData = includeHidden === true
    ? result.data
    : result.data.filter((entry) => entry?.hidden !== true)
  const models = visibleData.slice(0, normalizedLimit).map(publicCodexModel)
  if (models.some((entry) => entry == null)) {
    throw createCodexRuntimeError(CODEX_APP_SERVER_REASON.PROTOCOL_INVALID)
  }
  return {
    models,
    nextCursor: typeof result.nextCursor === 'string' && result.nextCursor.length <= 2_048
      ? result.nextCursor
      : null,
  }
}

/**
 * Start one process-owned app-server connection. Availability is published
 * only after the documented initialize/initialized handshake succeeds.
 */
export function startCodexAppServerRuntime({
  cwd = process.cwd(),
  env = process.env,
  explicitPath = '',
  platform = process.platform,
  signal = null,
  resolveExecutable = resolveCodexCliExecutableAsync,
  snapshotExecutable = createCodexCliExecutableSnapshotAsync,
  verifySignature = verifyCodexCliAuthenticode,
  readVersion = readCodexCliVersion,
  spawnImpl = spawn,
  terminate = terminateProcessTree,
  handshakeTimeoutMs = codexEnvValue(env, 'CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS', platform),
  signatureTimeoutMs = DEFAULT_SIGNATURE_TIMEOUT_MS,
  versionTimeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
  exitTimeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
} = {}) {
  if (closePromise) {
    return closePromise.then(() => startCodexAppServerRuntime({
      cwd,
      env,
      explicitPath,
      platform,
      signal,
      resolveExecutable,
      snapshotExecutable,
      verifySignature,
      readVersion,
      spawnImpl,
      terminate,
      handshakeTimeoutMs,
      signatureTimeoutMs,
      versionTimeoutMs,
      exitTimeoutMs,
    }))
  }
  if (currentRuntime) return Promise.resolve(currentSnapshot)
  if (activeStart) return joinCodexStartAttempt(activeStart, signal, currentSnapshot)

  const configured = configuredByOptions({ explicitPath, env, platform })
  // This bridge owns an external OpenAI Codex CLI child process and may cause
  // network activity under that CLI's own configuration. Keep it explicit
  // opt-in so discovery and process creation never happen by default.
  const enabled = codexEnvValue(env, 'CODEX_APP_SERVER_ENABLED', platform).trim() === '1'
  if (!enabled) {
    return Promise.resolve(publish({
      enabled: false,
      configured,
      reasonCode: CODEX_APP_SERVER_REASON.DISABLED,
    }))
  }

  const attempt = {
    controller: new AbortController(),
    hasPersistentWaiter: false,
    promise: null,
    runtime: null,
    signalWaiters: 0,
    stopRequested: false,
  }
  activeStart = attempt
  publish({
    enabled: true,
    configured,
    reasonCode: CODEX_APP_SERVER_REASON.STARTING,
  })
  const startOptions = {
    cwd,
    env,
    explicitPath,
    platform,
    resolveExecutable,
    snapshotExecutable,
    verifySignature,
    readVersion,
    spawnImpl,
    terminate,
    handshakeTimeoutMs: normalizeCodexStageTimeout(
      handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      MAX_HANDSHAKE_TIMEOUT_MS,
    ),
    signatureTimeoutMs: normalizeCodexStageTimeout(
      signatureTimeoutMs,
      DEFAULT_SIGNATURE_TIMEOUT_MS,
    ),
    versionTimeoutMs: normalizeCodexStageTimeout(versionTimeoutMs, DEFAULT_VERSION_TIMEOUT_MS),
    exitTimeoutMs: normalizeCodexStageTimeout(exitTimeoutMs, DEFAULT_EXIT_TIMEOUT_MS),
  }
  // Bind the first caller before any discovery callback can run. This makes a
  // pre-aborted sole caller a true zero-side-effect cancellation.
  attempt.promise = Promise.resolve().then(() => runStartAttempt(attempt, startOptions))
  const finish = () => {
    if (activeStart === attempt) activeStart = null
  }
  attempt.promise.then(finish, finish)
  return joinCodexStartAttempt(attempt, signal, currentSnapshot)
}

export function closeCodexAppServerRuntime({
  terminate = terminateProcessTree,
  exitTimeoutMs = DEFAULT_EXIT_TIMEOUT_MS,
  terminateTimeoutMs = DEFAULT_TERMINATE_TIMEOUT_MS,
  signal = null,
} = {}) {
  if (closePromise) return closePromise
  const operation = (async () => {
    const attempt = activeStart
    const hadWork = Boolean(attempt || currentRuntime)
    if (attempt) {
      attempt.stopRequested = true
      attempt.controller.abort()
      try {
        await waitForCodexOperation(attempt.promise, {
          signal,
          timeoutMs: exitTimeoutMs,
          timeoutReason: CODEX_APP_SERVER_REASON.TERMINATION_FAILED,
        })
      } catch {
        // Continue to the bounded runtime disposal path below.
      }
    }

    const runtime = currentRuntime || attempt?.runtime || null
    if (!runtime) {
      publish({
        ...currentSnapshot,
        ready: false,
        failureStage: null,
        reasonCode: CODEX_APP_SERVER_REASON.STOPPED,
      })
      return hadWork
    }

    const stopped = await disposeCodexAppServerRuntime(runtime, {
      terminate, exitTimeoutMs, terminateTimeoutMs, signal,
    })
    if (!stopped) {
      currentRuntime = runtime
      publish(runtimeStatus(runtime, {
        failureStage: 'shutdown',
        reasonCode: CODEX_APP_SERVER_REASON.TERMINATION_FAILED,
      }))
      return false
    }
    if (currentRuntime === runtime) currentRuntime = null
    publish({
      ...currentSnapshot,
      ready: false,
      failureStage: null,
      reasonCode: CODEX_APP_SERVER_REASON.STOPPED,
    })
    return true
  })()
  closePromise = operation
  const finish = () => {
    if (closePromise === operation) closePromise = null
  }
  operation.then(finish, finish)
  return operation
}
